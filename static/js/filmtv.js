/**
 * Shared interactive workspace / iframe viewer.
 * Allows users to share URLs for viewing docs, websites, streaming media (YouTube, Netflix, etc.),
 * and synced documents (PDF, Word, PPT, Excel) with host-controlled sync.
 */
const FilmTV = (() => {
  let containerEl = null;
  let iframeEl = null;
  let videoEl = null;
  let socket = null;
  let getToken = () => null;
  let applyingRemote = false;
  let isHost = false;

  function init({ container, socket: sock, tokenFn }) {
    containerEl = container;
    socket = sock;
    getToken = tokenFn;

    if (!videoEl) {
      videoEl = document.getElementById("filmtvVideo");
      if (videoEl) {
        videoEl.addEventListener("play", () => {
          if (!applyingRemote && isHost) emitControl("play");
        });
        videoEl.addEventListener("pause", () => {
          if (!applyingRemote && isHost) emitControl("pause");
        });
        videoEl.addEventListener("seeked", () => {
          if (!applyingRemote && isHost) emitControl("seek");
        });
      }
    }

    if (!iframeEl && containerEl) {
      iframeEl = document.createElement("iframe");
      iframeEl.className = "filmtv-iframe";
      iframeEl.setAttribute("sandbox", "allow-scripts allow-popups allow-forms allow-downloads allow-same-origin");
      iframeEl.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture");
      iframeEl.style.cssText = "width:100%; height:100%; border:none; display:none;";

      iframeEl.onload = () => {
        try {
          const doc = iframeEl.contentWindow.document;
          doc.addEventListener("scroll", () => {
            if (!applyingRemote && isHost) {
              emitControl("scroll", { scroll_top: doc.documentElement.scrollTop });
            }
          });
        } catch (e) { /* Cross-origin blocks scroll sync for external sites like YouTube */ }
      };

      containerEl.appendChild(iframeEl);
    }

    // Bind Share button and input listener
    setupShareHandlers();
  }

  function setSocket(sock) {
    socket = sock;
  }

  function emitControl(action, extra = {}) {
    if (applyingRemote || !socket || !isHost) return;
    socket.emit("filmtv_control", {
      token: getToken(),
      action,
      position: videoEl ? videoEl.currentTime || 0 : 0,
      ...extra
    });
  }

  function updateStatusBadge(status) {
    const badge = document.getElementById("filmtvStatusBadge");
    if (badge) {
      badge.textContent = status;
      badge.setAttribute("data-status", status);
    }
  }

  function setupShareHandlers() {
    const shareBtn = document.getElementById("filmtvShareBtn");
    const inputEl = document.getElementById("filmtvInput");

    if (shareBtn && inputEl && !shareBtn.dataset.bound) {
      shareBtn.dataset.bound = "true";
      shareBtn.addEventListener("click", async () => {
        const val = inputEl.value.trim();
        if (!val) return;

        try {
          const res = await fetch("/api/filmtv/source", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Session-Token": getToken() || ""
            },
            body: JSON.stringify({ source: val, source_type: "url" })
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.error || "Failed to share source");
          } else {
            inputEl.value = "";
          }
        } catch (err) {
          console.error("Share error:", err);
        }
      });
    }
  }

  async function loadState(state, memberId) {
    if (!state || !state.stream_url) {
      clearPlayer();
      return;
    }

    isHost = state.host_id === memberId;
    const titleEl = document.getElementById("filmtvTitle");
    if (titleEl) titleEl.textContent = state.title || "Shared Workspace";

    // STEP 1: Wake up containers immediately
    const empty = document.getElementById("filmtvEmpty");
    if (empty) empty.style.display = "none";
    if (containerEl) containerEl.style.display = "block";

    const videoExts = /\.(mp4|webm|ogg|mov|mkv|m4v)(\?.*)?$/i;
    const isVideo = videoExts.test(state.source || "") && state.source_type === "upload";

    // STEP 2: Logic Branching
    if (isVideo) {
      // HANDLE UPLOADED VIDEO
      if (iframeEl) iframeEl.style.display = "none";
      if (videoEl) {
        videoEl.style.display = "block";
        const tokenStr = getToken() ? `?token=${encodeURIComponent(getToken())}` : "";
        const src = state.stream_url + tokenStr;

        if (!videoEl.src.includes(state.stream_url)) {
          videoEl.src = src;
          videoEl.load();
        }

        applyingRemote = true;

        if (Math.abs(videoEl.currentTime - (state.position || 0)) > 1.5) {
          videoEl.currentTime = state.position || 0;
        }

        if (state.playing) {
          videoEl.play().catch(() => { });
        } else {
          videoEl.pause();
        }
        applyingRemote = false;
      }
    } else {
      // HANDLE URLS OR UPLOADED DOCUMENTS
      if (videoEl) {
        videoEl.pause();
        videoEl.style.display = "none";
      }
      if (iframeEl) {
        iframeEl.style.display = "block";

        let displaySource = state.stream_url;

        if (state.source_type === "upload") {
          // Document Upload (PDFs, Word, etc.)
          const tokenStr = getToken() ? `?token=${encodeURIComponent(getToken())}` : "";
          const streamUrl = window.location.origin + state.stream_url + tokenStr;

          if (/\.(doc|docx|xls|xlsx|ppt|pptx)(\?.*)?$/i.test(state.source || "")) {
            displaySource = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(streamUrl)}`;
          } else {
            displaySource = streamUrl;
          }
        } else {
          // Robust YouTube URL Transform (Handles watch?v=, youtu.be, and extra params)
          let rawUrl = (state.source || state.stream_url || "").trim();
          if (rawUrl.includes("youtube.com/watch?v=")) {
            const urlObj = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
            const videoId = urlObj.searchParams.get("v");
            if (videoId) {
              displaySource = `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;
            }
          } else if (rawUrl.includes("youtu.be/")) {
            const parts = rawUrl.split("youtu.be/");
            if (parts[1]) {
              const videoId = parts[1].split("?")[0];
              displaySource = `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;
            }
          } else {
            displaySource = rawUrl;
          }
        }

        if (iframeEl.src !== displaySource) {
          iframeEl.src = displaySource;
        }

        applyingRemote = true;
        try {
          if (state.scroll_top !== undefined && iframeEl.contentWindow) {
            iframeEl.contentWindow.scrollTo(0, state.scroll_top);
          }
        } catch (e) { }
        applyingRemote = false;
      }
    }

    if (videoEl) videoEl.controls = isHost;
    updateStatusBadge(isHost ? "Hosting Workspace (Synced)" : "Watching Workspace (Synced)");
  }

  function clearPlayer() {
    if (iframeEl) iframeEl.removeAttribute("src");
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
      videoEl.style.display = "none";
    }
    const container = document.getElementById("filmtvIframeContainer") || containerEl;
    if (container) container.style.display = "none";

    const title = document.getElementById("filmtvTitle");
    if (title) title.textContent = "Shared Workspace";
    const empty = document.getElementById("filmtvEmpty");
    if (empty) empty.style.display = "flex";

    updateStatusBadge("clear");
  }

  async function applyRemoteControl(payload) {
    if (!payload || !payload.state) return;
    const { action, state } = payload;

    if (action === "load" || action === "sync" || action === "play" || action === "pause" || action === "seek" || action === "scroll") {
      await loadState(state, state.host_id);
    } else if (action === "clear") {
      clearPlayer();
    }
  }

  function openStage() {
    document.body.classList.add("filmtv-open");
    document.getElementById("filmtvStage")?.classList.add("open");
    document.getElementById("btnFilmTV")?.classList.add("active");
  }

  function openTheater() {
    openStage();
    document.body.classList.add("theater-mode");
  }

  function closeTheater() {
    document.body.classList.remove("theater-mode", "filmtv-open");
    document.getElementById("filmtvStage")?.classList.remove("open");
    document.getElementById("btnFilmTV")?.classList.remove("active");
  }

  function toggleTheater() {
    if (!document.getElementById("filmtvStage")?.classList.contains("open")) {
      openTheater();
      return;
    }
    if (document.body.classList.contains("theater-mode")) {
      document.body.classList.remove("theater-mode");
      document.body.classList.add("filmtv-open");
    } else {
      document.body.classList.add("theater-mode", "filmtv-open");
    }
  }

  return {
    init,
    setSocket,
    loadState,
    applyRemoteControl,
    clearPlayer,
    openStage,
    openTheater,
    closeTheater,
    toggleTheater,
    updateStatusBadge,
  };
})();