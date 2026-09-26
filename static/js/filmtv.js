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
      iframeEl.style.width = "100%";
      iframeEl.style.height = "100%";
      iframeEl.style.border = "none";
      iframeEl.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms allow-downloads");

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

  async function loadState(state, memberId) {
    if (!state || !state.source) {
      clearPlayer();
      return;
    }

    isHost = state.host_id === memberId;
    const titleEl = document.getElementById("filmtvTitle");
    if (titleEl) titleEl.textContent = state.title || "Shared Workspace";

    const empty = document.getElementById("filmtvEmpty");
    if (empty) empty.style.display = "none";

    // Check if source is a direct video file or uploaded media
    const isVideo = /\.(mp4|webm|ogg|mov|mkv|m4v)$/i.test(state.source) || state.source_type === "upload";

    if (isVideo) {
      if (iframeEl) iframeEl.style.display = "none";
      if (videoEl) {
        videoEl.style.display = "block";
        const src = state.source_type === "upload" ? "/api/filmtv/stream" : state.source;

        if (videoEl.src !== src && videoEl.src.indexOf(src) === -1) {
          videoEl.src = src;
          videoEl.load();
        }

        applyingRemote = true;
        if (Math.abs(videoEl.currentTime - (state.position || 0)) > 1.0) {
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
      // Handles Streaming platforms (YouTube, Netflix, Twitch, Vimeo) & Documents (PDF, Word, PPT, Excel via viewer)
      if (videoEl) {
        videoEl.pause();
        videoEl.style.display = "none";
      }
      if (iframeEl) {
        iframeEl.style.display = "block";

        let displaySource = state.source;
        // Optional: Embed formatting helpers for YouTube if raw watch link is passed
        if (displaySource.includes("youtube.com/watch?v=")) {
          displaySource = displaySource.replace("watch?v=", "embed/");
        } else if (displaySource.includes("youtu.be/")) {
          displaySource = displaySource.replace("youtu.be/", "www.youtube.com/embed/");
        }

        if (iframeEl.src !== displaySource && iframeEl.src.indexOf(displaySource) === -1) {
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