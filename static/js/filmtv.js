/**
 * Shared interactive workspace / iframe viewer - Ultra-Advanced & 100% Zero-Error Version.
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
    console.log("🟢 [FilmTV] Initializing ultra-advanced module...");
    containerEl = container;
    socket = sock;
    getToken = typeof tokenFn === "function" ? tokenFn : () => null;

    if (!videoEl) {
      videoEl = document.getElementById("filmtvVideo");
    }

    if (!iframeEl && containerEl) {
      iframeEl = document.createElement("iframe");
      iframeEl.className = "filmtv-iframe";
      iframeEl.setAttribute("sandbox", "allow-scripts allow-popups allow-forms allow-downloads allow-same-origin");
      iframeEl.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture");
      iframeEl.style.cssText = "width:100%; height:100%; border:none; display:block;";
      containerEl.appendChild(iframeEl);
    }

    setupShareHandlers();
  }

  function setSocket(sock) {
    socket = sock;
  }

  function emitControl(action, extra = {}) {
    if (applyingRemote || !socket || !isHost) return;
    try {
      socket.emit("filmtv_control", {
        token: getToken(),
        action,
        position: videoEl ? videoEl.currentTime || 0 : 0,
        ...extra
      });
    } catch (err) {
      console.error("❌ [FilmTV] Emit control error:", err);
    }
  }

  function updateStatusBadge(status) {
    const badge = document.getElementById("filmtvSyncBadge") || document.getElementById("filmtvStatusBadge");
    if (badge) {
      badge.textContent = status;
      badge.setAttribute("data-status", status);
    }
  }

  function setupShareHandlers() {
    const shareBtn = document.getElementById("btnFilmTVLoad") || document.getElementById("filmtvShareBtn");
    const inputEl = document.getElementById("filmtvUrl") || document.getElementById("filmtvInput");
    const clearBtn = document.getElementById("btnFilmTVClear");

    if (shareBtn && inputEl && !shareBtn.dataset.bound) {
      shareBtn.dataset.bound = "true";
      shareBtn.addEventListener("click", async () => {
        const val = inputEl.value.trim();
        if (!val) {
          alert("Kripya ek valid URL darj karein.");
          return;
        }

        try {
          const res = await fetch("/api/filmtv/source", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Session-Token": getToken() || ""
            },
            body: JSON.stringify({ source: val, source_type: "url", title: val })
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.error || "Source share karne mein asafalta rahi.");
          } else {
            inputEl.value = "";
          }
        } catch (err) {
          console.error("❌ [FilmTV] Share fetch error:", err);
        }
      });
    }

    if (clearBtn && !clearBtn.dataset.bound) {
      clearBtn.dataset.bound = "true";
      clearBtn.addEventListener("click", async () => {
        try {
          await fetch("/api/filmtv/clear", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Session-Token": getToken() || ""
            }
          });
          clearPlayer();
        } catch (err) {
          console.error("❌ [FilmTV] Clear fetch error:", err);
        }
      });
    }
  }

  async function loadState(state, memberId) {
    if (!state || (!state.stream_url && !state.source)) {
      clearPlayer();
      return;
    }

    isHost = state.host_id === memberId;
    const titleEl = document.getElementById("filmtvTitle");
    if (titleEl) titleEl.textContent = state.title || "FilmTV Watch Party";

    const empty = document.getElementById("filmtvEmpty");
    if (empty) empty.style.display = "none";

    const targetContainer = document.getElementById("filmtvIframeContainer") || containerEl;

    const sourceStr = (state.source || "").toLowerCase();
    const streamUrlStr = (state.stream_url || "").toLowerCase();

    // Sirf asli video files (mp4, webm, etc.) ke liye video element use hoga
    const isVideoUpload = (
      state.source_type === "upload" && (
        sourceStr.endsWith(".mp4") || sourceStr.endsWith(".webm") ||
        sourceStr.endsWith(".ogg") || sourceStr.endsWith(".mov") ||
        sourceStr.endsWith(".mkv") || sourceStr.endsWith(".m4v")
      )
    );

    if (isVideoUpload && videoEl) {
      if (iframeEl) iframeEl.style.display = "none";
      if (targetContainer) targetContainer.style.display = "none";

      videoEl.style.display = "block";
      const tokenVal = getToken();
      const tokenStr = tokenVal ? `?token=${encodeURIComponent(tokenVal)}` : "";
      const src = (state.stream_url || "/api/filmtv/stream") + tokenStr;

      if (!videoEl.src.includes("stream")) {
        videoEl.src = src;
        videoEl.load();
      }

      applyingRemote = true;
      if (Math.abs(videoEl.currentTime - (state.position || 0)) > 1.5) {
        videoEl.currentTime = state.position || 0;
      }

      if (state.playing) {
        videoEl.play().catch((err) => console.log("Playback info:", err));
      } else {
        videoEl.pause();
      }
      applyingRemote = false;

      videoEl.controls = isHost;
    } else {
      // YouTube, web links, PDFs aur documents ke liye iframe container use hoga
      if (videoEl) {
        videoEl.pause();
        videoEl.style.display = "none";
      }
      if (targetContainer) targetContainer.style.display = "block";

      if (iframeEl) {
        iframeEl.style.display = "block";
        let displaySource = "";

        const rawUrl = (state.source || state.stream_url || "").trim();

        if (state.source_type === "upload") {
          const tokenVal = getToken();
          const tokenStr = tokenVal ? `?token=${encodeURIComponent(tokenVal)}` : "";
          const streamUrl = window.location.origin + state.stream_url + tokenStr;

          if (sourceStr.endsWith(".pdf")) {
            displaySource = streamUrl; // PDFs browser mein direct render honge
          } else if (/\.(doc|docx|xls|xlsx|ppt|pptx)(\?.*)?$/i.test(state.source || "")) {
            displaySource = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(streamUrl)}`;
          } else {
            displaySource = streamUrl;
          }
        } else {
          if (rawUrl.includes("youtube.com/watch?v=")) {
            try {
              const urlObj = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
              const videoId = urlObj.searchParams.get("v");
              if (videoId) {
                displaySource = `https://www.youtube.com/embed/${videoId}?autoplay=1&enablejsapi=1`;
              }
            } catch (e) {
              displaySource = rawUrl.replace("watch?v=", "embed/");
            }
          } else if (rawUrl.includes("youtu.be/")) {
            const parts = rawUrl.split("youtu.be/");
            if (parts[1]) {
              const videoId = parts[1].split("?")[0];
              displaySource = `https://www.youtube.com/embed/${videoId}?autoplay=1&enablejsapi=1`;
            }
          } else if (rawUrl.includes("youtube.com/embed/")) {
            displaySource = rawUrl;
          } else {
            displaySource = rawUrl;
          }
        }

        if (iframeEl.src !== displaySource) {
          iframeEl.src = displaySource;
        }
      }
    }

    updateStatusBadge(isHost ? "♡ hosting (synced)" : "♡ watching (synced)");
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
    if (title) title.textContent = "FilmTV Watch Party";
    const empty = document.getElementById("filmtvEmpty");
    if (empty) empty.style.display = "flex";

    updateStatusBadge("♡ ready");
  }

  async function applyRemoteControl(payload) {
    if (!payload || !payload.state) return;
    const { action, state } = payload;

    if (["load", "sync", "play", "pause", "seek", "scroll"].includes(action)) {
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