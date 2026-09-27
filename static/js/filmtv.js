/**
 * Shared interactive workspace / iframe viewer with detailed console diagnostics.
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
    console.log("🟢 [FilmTV Diagnostics] Initializing module...", { container, sock });
    containerEl = container;
    socket = sock;
    getToken = tokenFn;

    if (!containerEl) {
      console.error("❌ [FilmTV Critical] Container element is missing during initialization!");
    }

    if (!videoEl) {
      videoEl = document.getElementById("filmtvVideo");
      if (!videoEl) {
        console.warn("⚠️ [FilmTV Warning] #filmtvVideo element not found in DOM.");
      } else {
        console.log("✅ [FilmTV Diagnostics] #filmtvVideo element found.");
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
        console.log("🌐 [FilmTV Diagnostics] Iframe loaded source successfully.");
        try {
          const doc = iframeEl.contentWindow.document;
          doc.addEventListener("scroll", () => {
            if (!applyingRemote && isHost) {
              emitControl("scroll", { scroll_top: doc.documentElement.scrollTop });
            }
          });
        } catch (e) {
          console.log("ℹ️ [FilmTV Info] Cross-origin restrictions apply to iframe (normal for external embeds like YouTube).");
        }
      };

      containerEl.appendChild(iframeEl);
      console.log("✅ [FilmTV Diagnostics] Dynamic iframe created and appended.");
    }

    setupShareHandlers();
  }

  function setSocket(sock) {
    socket = sock;
    console.log("🔌 [FilmTV Diagnostics] Socket updated:", socket ? "Active" : "Null");
  }

  function emitControl(action, extra = {}) {
    if (applyingRemote || !socket || !isHost) return;
    console.log(`📤 [FilmTV Diagnostics] Emitting action: ${action}`, extra);
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
    } else {
      console.warn("⚠️ [FilmTV Warning] #filmtvStatusBadge element not found.");
    }
  }

  function setupShareHandlers() {
    const shareBtn = document.getElementById("filmtvShareBtn");
    const inputEl = document.getElementById("filmtvInput");

    console.log("🔍 [FilmTV Diagnostics] Checking Share Elements -> ShareBtn:", shareBtn, "| InputEl:", inputEl);

    if (!shareBtn || !inputEl) {
      console.error("❌ [FilmTV Critical Error] #filmtvShareBtn or #filmtvInput is missing from HTML!");
      return;
    }

    if (!shareBtn.dataset.bound) {
      shareBtn.dataset.bound = "true";
      shareBtn.addEventListener("click", async () => {
        const val = inputEl.value.trim();
        console.log("🖱️ [FilmTV Diagnostics] Share button clicked. Input value:", val);

        if (!val) {
          alert("Please enter a valid URL or select a file.");
          console.warn("⚠️ [FilmTV Warning] User tried to share an empty input box.");
          return;
        }

        try {
          console.log("🌐 [FilmTV Diagnostics] Sending POST to /api/filmtv/source...");
          const res = await fetch("/api/filmtv/source", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Session-Token": getToken() || ""
            },
            body: JSON.stringify({ source: val, source_type: "url" })
          });

          const data = await res.json();
          console.log(`📥 [FilmTV Diagnostics] Response status: ${res.status}`, data);

          if (!res.ok) {
            console.error("❌ [FilmTV API Error]", data.error || "Failed to share source");
            alert(data.error || "Failed to share source");
          } else {
            console.log("✨ [FilmTV Diagnostics] Source shared successfully!");
            inputEl.value = "";
          }
        } catch (err) {
          console.error("🔥 [FilmTV Fetch Exception] Network or script error during share:", err);
        }
      });
      console.log("✅ [FilmTV Diagnostics] Share button event listener attached.");
    }
  }

  async function loadState(state, memberId) {
    console.log("📥 [FilmTV Diagnostics] loadState called with payload:", state, "MemberID:", memberId);

    if (!state || (!state.stream_url && !state.source)) {
      console.warn("⚠️ [FilmTV Warning] State or stream_url/source is missing. Clearing player.");
      clearPlayer();
      return;
    }

    isHost = state.host_id === memberId;
    const titleEl = document.getElementById("filmtvTitle");
    if (titleEl) titleEl.textContent = state.title || "Shared Workspace";

    const empty = document.getElementById("filmtvEmpty");
    if (empty) empty.style.display = "none";
    if (containerEl) containerEl.style.display = "block";

    const videoExts = /\.(mp4|webm|ogg|mov|mkv|m4v)(\?.*)?$/i;
    const isVideo = videoExts.test(state.source || "") && state.source_type === "upload";
    console.log("🔎 [FilmTV Diagnostics] Is video file upload?", isVideo);

    if (isVideo) {
      if (iframeEl) iframeEl.style.display = "none";
      if (videoEl) {
        videoEl.style.display = "block";
        const tokenStr = getToken() ? `?token=${encodeURIComponent(getToken())}` : "";
        const src = state.stream_url + tokenStr;

        if (!videoEl.src.includes(state.stream_url)) {
          console.log("🎬 [FilmTV Diagnostics] Setting video source:", src);
          videoEl.src = src;
          videoEl.load();
        }

        applyingRemote = true;
        if (Math.abs(videoEl.currentTime - (state.position || 0)) > 1.5) {
          videoEl.currentTime = state.position || 0;
        }

        if (state.playing) {
          videoEl.play().catch((err) => { console.error("❌ [FilmTV Video Play Error]", err); });
        } else {
          videoEl.pause();
        }
        applyingRemote = false;
      }
    } else {
      if (videoEl) {
        videoEl.pause();
        videoEl.style.display = "none";
      }
      if (iframeEl) {
        iframeEl.style.display = "block";
        let displaySource = state.stream_url || state.source;

        if (state.source_type === "upload") {
          const tokenStr = getToken() ? `?token=${encodeURIComponent(getToken())}` : "";
          const streamUrl = window.location.origin + state.stream_url + tokenStr;

          if (/\.(doc|docx|xls|xlsx|ppt|pptx)(\?.*)?$/i.test(state.source || "")) {
            displaySource = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(streamUrl)}`;
          } else {
            displaySource = streamUrl;
          }
        } else {
          let rawUrl = (state.source || state.stream_url || "").trim();
          console.log("🔗 [FilmTV Diagnostics] Raw URL received for iframe:", rawUrl);

          if (rawUrl.includes("youtube.com/watch?v=")) {
            try {
              const urlObj = new URL(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`);
              const videoId = urlObj.searchParams.get("v");
              if (videoId) {
                displaySource = `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;
              }
            } catch (e) {
              displaySource = rawUrl.replace("watch?v=", "embed/");
            }
          } else if (rawUrl.includes("youtu.be/")) {
            const parts = rawUrl.split("youtu.be/");
            if (parts[1]) {
              const videoId = parts[1].split("?")[0];
              displaySource = `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;
            }
          } else if (rawUrl.includes("youtube.com/embed/")) {
            displaySource = rawUrl;
          } else {
            displaySource = rawUrl;
          }
        }

        console.log("📺 [FilmTV Diagnostics] Final iframe displaySource:", displaySource);
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
    console.log("🧹 [FilmTV Diagnostics] Clearing player state.");
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
    console.log("⚡ [FilmTV Diagnostics] Socket remote control event received:", payload);
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