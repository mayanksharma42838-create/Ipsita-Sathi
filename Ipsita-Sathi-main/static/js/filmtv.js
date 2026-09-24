/**
 * FilmTV Watch Party — HTML5 <video> only.
 * Play / pause / seek synced via Flask-SocketIO. No YouTube, no screen share.
 */
const FilmTV = (() => {
  let videoEl = null;
  let socket = null;
  let getToken = () => null;
  let applyingRemote = false;
  let heartbeatTimer = null;
  let lastEmittedSeek = 0;
  let hasSource = false;

  function init({ video, socket: sock, tokenFn }) {
    videoEl = video;
    socket = sock;
    getToken = tokenFn;

    videoEl.addEventListener("play", () => emitControl("play"));
    videoEl.addEventListener("pause", () => emitControl("pause"));
    videoEl.addEventListener("seeked", () => {
      if (applyingRemote) return;
      const now = Date.now();
      if (now - lastEmittedSeek < 350) return;
      lastEmittedSeek = now;
      emitControl("seek");
    });

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (applyingRemote || !hasSource || !videoEl || videoEl.paused) return;
      emitControl("heartbeat");
    }, 8000);
  }

  function setSocket(sock) {
    socket = sock;
  }

  function emitControl(action) {
    if (applyingRemote || !socket || !hasSource) return;
    socket.emit("filmtv_control", {
      token: getToken(),
      action,
      position: videoEl ? videoEl.currentTime || 0 : 0,
    });
    updateStatusBadge(action);
  }

  function updateStatusBadge(action) {
    const el = document.getElementById("filmtvSyncBadge");
    if (!el) return;
    const labels = {
      play: "▶ playing together",
      pause: "❚❚ paused together",
      seek: "⟷ seek synced",
      heartbeat: "♡ in sync",
      load: "loaded for both",
      clear: "cleared",
    };
    el.textContent = labels[action] || "♡ synced";
    el.classList.add("pulse");
    setTimeout(() => el.classList.remove("pulse"), 700);
  }

  function resolveSrc(state) {
    if (!state || !state.source_type) return null;
    if (state.source_type === "upload") {
      // Cookie / header auth only — never put session tokens in the URL (V-04)
      return "/api/filmtv/stream";
    }
    if (state.source_type === "url") {
      return state.stream_url || state.source;
    }
    return null;
  }

  async function loadState(state) {
    if (!state || !state.source_type || !state.source) {
      clearPlayer();
      return;
    }
    // Reject legacy youtube leftovers from older sessions
    if (state.source_type === "youtube") {
      clearPlayer();
      const title = document.getElementById("filmtvTitle");
      if (title) title.textContent = "Use a direct mp4/webm URL or upload a file";
      return;
    }

    const titleEl = document.getElementById("filmtvTitle");
    if (titleEl) titleEl.textContent = state.title || "FilmTV Watch Party";

    const src = resolveSrc(state);
    if (!src || !videoEl) return;

    applyingRemote = true;
    hasSource = true;
    const empty = document.getElementById("filmtvEmpty");
    if (empty) empty.style.display = "none";

    if (videoEl.getAttribute("src") !== src) {
      videoEl.src = src;
      videoEl.load();
      await waitEvent(videoEl, "loadedmetadata").catch(() => {});
    }

    const target = Number(state.position) || 0;
    if (Math.abs((videoEl.currentTime || 0) - target) > 0.4) {
      try {
        videoEl.currentTime = target;
      } catch {
        /* ignore */
      }
    }

    if (state.playing) {
      try {
        await videoEl.play();
      } catch {
        /* autoplay may require a tap */
      }
    } else {
      videoEl.pause();
    }

    applyingRemote = false;
    updateStatusBadge("load");
  }

  function clearPlayer() {
    hasSource = false;
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
    }
    const title = document.getElementById("filmtvTitle");
    if (title) title.textContent = "FilmTV Watch Party";
    const empty = document.getElementById("filmtvEmpty");
    if (empty) empty.style.display = "flex";
    updateStatusBadge("clear");
  }

  async function applyRemoteControl(payload) {
    if (!payload || !payload.state) return;
    const { action, state } = payload;

    if (action === "load" || !hasSource) {
      await loadState(state);
      return;
    }

    applyingRemote = true;
    try {
      await syncPlayback(state);
      updateStatusBadge(action);
    } finally {
      setTimeout(() => {
        applyingRemote = false;
      }, 250);
    }
  }

  async function syncPlayback(state) {
    if (!videoEl || !hasSource) return;
    const target = Number(state.position) || 0;
    const driftTol = 1.1;

    if (Math.abs((videoEl.currentTime || 0) - target) > driftTol) {
      try {
        videoEl.currentTime = target;
      } catch {
        /* ignore */
      }
    }

    if (state.playing && videoEl.paused) {
      try {
        await videoEl.play();
      } catch {
        /* ignore */
      }
    } else if (!state.playing && !videoEl.paused) {
      videoEl.pause();
    }
  }

  function waitEvent(el, name, ms = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      el.addEventListener(
        name,
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
    });
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
  };
})();
