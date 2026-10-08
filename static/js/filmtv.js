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
  let remoteControlsSuppressedUntil = 0;
  let currentVideoSource = null;
  let latestVideoState = null;
  let youtubePlayer = null;
  let youtubeVideoId = null;
  let youtubePlayerHost = null;
  let youtubeApiUnavailable = false;
  let youtubeMonitor = null;
  let lastYoutubePosition = null;
  let lastYoutubeSampleAt = 0;
  let youtubePlayerReady = null;
  let stateLoadVersion = 0;

  function pdfViewer() {
    return typeof PdfDocumentViewer === "undefined" ? null : PdfDocumentViewer;
  }

  function resolveAbsoluteUrl(rawSource) {
    if (!rawSource) return "";
    let clean = String(rawSource).trim().replace(/^[\.\s]+/, "");
    if (clean.startsWith("http://") || clean.startsWith("https://")) {
      return clean;
    }
    try {
      return new URL(clean, window.location.origin).href;
    } catch {
      return clean;
    }
  }

  function init({ container, socket: sock, tokenFn }) {
    console.log("🟢 [FilmTV] Initializing ultra-advanced module...");
    containerEl = container;
    socket = sock;
    getToken = typeof tokenFn === "function" ? tokenFn : () => null;

    if (!videoEl) {
      videoEl = document.getElementById("filmtvVideo");
    }

    ensureIframe();
    bindVideoControls();
    pdfViewer()?.init({ tokenFn: getToken });

  }

  function setSocket(sock) {
    socket = sock;
  }

  function ensureIframe() {
    const iframeContainer = document.getElementById("filmtvIframeContainer");
    if (!iframeContainer) return;
    if (!iframeEl || !iframeEl.isConnected) {
      iframeEl = document.createElement("iframe");
      iframeEl.className = "filmtv-iframe";
      iframeEl.setAttribute("sandbox", "allow-scripts allow-popups allow-forms allow-downloads allow-same-origin allow-modals");
      iframeEl.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture");
      iframeEl.style.cssText = "width:100%; height:100%; border:none; display:block;";
      iframeContainer.replaceChildren(iframeEl);
    }
  }

  function bindVideoControls() {
    if (!videoEl || videoEl.dataset.filmtvBound) return;
    videoEl.dataset.filmtvBound = "true";
    videoEl.addEventListener("play", () => emitControl("play"));
    videoEl.addEventListener("pause", () => {
      if (!videoEl.ended) emitControl("pause");
    });
    videoEl.addEventListener("seeked", () => emitControl("seek"));
    videoEl.addEventListener("loadedmetadata", applyLatestVideoState);
  }

  function suppressRemoteControls() {
    applyingRemote = true;
    remoteControlsSuppressedUntil = Date.now() + 1500;
    window.setTimeout(() => { applyingRemote = false; }, 0);
  }

  function applyLatestVideoState() {
    if (!videoEl || !latestVideoState || videoEl.readyState < 1) return;
    const state = latestVideoState;
    const target = Number(state.position) || 0;
    suppressRemoteControls();
    if (Math.abs(videoEl.currentTime - target) > 1.5) {
      try {
        videoEl.currentTime = target;
      } catch (err) {
        console.warn("Unable to seek shared video:", err);
      }
    }
    if (state.playing) {
      videoEl.play().catch((err) => console.info("Playback requires a user gesture:", err));
    } else {
      videoEl.pause();
    }
  }

  function ensureYouTubeApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (window.filmTvYouTubeApi) return window.filmTvYouTubeApi;

    window.filmTvYouTubeApi = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      const timeoutId = window.setTimeout(() => reject(new Error("YouTube player API timed out")), 15000);
      window.onYouTubeIframeAPIReady = () => {
        window.clearTimeout(timeoutId);
        if (typeof previousReady === "function") previousReady();
        if (window.YT?.Player) resolve(window.YT);
        else reject(new Error("YouTube player API failed to initialize"));
      };

      let script = document.querySelector('script[data-filmtv-youtube-api]');
      if (!script) {
        script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.dataset.filmtvYoutubeApi = "true";
        script.onerror = () => {
          window.clearTimeout(timeoutId);
          reject(new Error("Unable to load YouTube player API"));
        };
        document.head.appendChild(script);
      }
    });
    return window.filmTvYouTubeApi;
  }

  function youtubeIdFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.toLowerCase();
      if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
      if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
        if (url.pathname === "/watch") return url.searchParams.get("v");
        const match = url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/);
        return match ? match[1] : null;
      }
    } catch {
      return null;
    }
    return null;
  }

  function emitYouTubeControl(action, position) {
    if (applyingRemote || Date.now() < remoteControlsSuppressedUntil || !isHost || !socket) return;
    socket.emit("filmtv_control", { action, position });
  }

  function startYouTubeMonitor() {
    if (youtubeMonitor) window.clearInterval(youtubeMonitor);
    youtubeMonitor = window.setInterval(() => {
      if (!youtubePlayer || !isHost || youtubePlayer.getPlayerState() !== window.YT.PlayerState.PLAYING) return;
      const position = youtubePlayer.getCurrentTime();
      const now = Date.now();
      if (lastYoutubePosition !== null) {
        const expected = lastYoutubePosition + (now - lastYoutubeSampleAt) / 1000;
        if (Math.abs(position - expected) > 2) emitYouTubeControl("seek", position);
      }
      lastYoutubePosition = position;
      lastYoutubeSampleAt = now;
    }, 1000);
  }

  async function applyYouTubeState(state, videoId) {
    const YT = await ensureYouTubeApi();
    const iframeContainer = document.getElementById("filmtvIframeContainer");
    if (!iframeContainer) throw new Error("FilmTV iframe container is unavailable");

    const target = Number(state.position) || 0;
    if (youtubePlayerReady) await youtubePlayerReady;
    if (!youtubePlayer || youtubePlayerHost !== isHost) {
      if (youtubePlayer) youtubePlayer.destroy();
      const placeholder = document.createElement("div");
      placeholder.id = "filmtvYouTubePlayer";
      placeholder.style.cssText = "width:100%; height:100%;";
      iframeContainer.replaceChildren(placeholder);
      iframeEl = null;
      youtubeVideoId = videoId;
      youtubePlayerHost = isHost;
      const ready = new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(
          () => reject(new Error("YouTube player did not become ready")),
          10000
        );
        youtubePlayer = new YT.Player(placeholder, {
          videoId,
          playerVars: {
            autoplay: 0,
            controls: isHost ? 1 : 0,
            disablekb: isHost ? 0 : 1,
            enablejsapi: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              window.clearTimeout(timeoutId);
              resolve();
            },
            onError: () => {
              window.clearTimeout(timeoutId);
              reject(new Error("YouTube could not load this video"));
            },
            onStateChange: (event) => {
              if (!isHost || applyingRemote || Date.now() < remoteControlsSuppressedUntil) return;
              if (event.data === YT.PlayerState.PLAYING) {
                emitYouTubeControl("play", youtubePlayer.getCurrentTime());
              } else if (event.data === YT.PlayerState.PAUSED) {
                emitYouTubeControl("pause", youtubePlayer.getCurrentTime());
              }
            },
          },
        });
      });
      youtubePlayerReady = ready;
      try {
        await ready;
        youtubeApiUnavailable = false;
      } catch (err) {
        if (youtubePlayerReady === ready) youtubePlayerReady = null;
        youtubeApiUnavailable = true;
        stopYouTubePlayer();
        throw err;
      }
      if (youtubePlayerReady === ready) youtubePlayerReady = null;
      iframeEl = youtubePlayer.getIframe();
      startYouTubeMonitor();
    }

    if (youtubeVideoId !== videoId) {
      youtubeVideoId = videoId;
      suppressRemoteControls();
      if (state.playing) youtubePlayer.loadVideoById({ videoId, startSeconds: target });
      else youtubePlayer.cueVideoById({ videoId, startSeconds: target });
      return;
    }

    suppressRemoteControls();
    if (Math.abs(youtubePlayer.getCurrentTime() - target) > 1.5) youtubePlayer.seekTo(target, true);
    if (state.playing) youtubePlayer.playVideo();
    else youtubePlayer.pauseVideo();
  }

  function emitControl(action, extra = {}) {
    if (applyingRemote || Date.now() < remoteControlsSuppressedUntil || !socket || !isHost) return;
    try {
      socket.emit("filmtv_control", {
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

  function stopYouTubePlayer() {
    if (youtubeMonitor) window.clearInterval(youtubeMonitor);
    youtubeMonitor = null;
    if (youtubePlayer) {
      try {
        youtubePlayer.destroy();
      } catch (err) {
        console.warn("Unable to stop YouTube player:", err);
      }
    }
    youtubePlayer = null;
    youtubePlayerReady = null;
    youtubeVideoId = null;
    youtubePlayerHost = null;
    iframeEl = null;
  }

  async function getOfficePreviewUrl() {
    const response = await fetch("/api/filmtv/view-ticket", {
      credentials: "same-origin",
      headers: { "X-Session-Token": getToken() || "" },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.stream_url) {
      throw new Error(data.error || "Unable to open document preview");
    }
    return new URL(data.stream_url, window.location.origin).href;
  }

  function loadYouTubeFallback(state, videoId) {
    ensureIframe();
    if (!iframeEl) return;
    iframeEl.removeAttribute("sandbox");
    iframeEl.referrerPolicy = "strict-origin-when-cross-origin";
    const fallbackUrl = new URL(`https://www.youtube.com/embed/${encodeURIComponent(videoId)}`);
    fallbackUrl.searchParams.set("autoplay", state.playing ? "1" : "0");
    fallbackUrl.searchParams.set("controls", "1");
    fallbackUrl.searchParams.set("start", String(Math.floor(Number(state.position) || 0)));
    iframeEl.src = fallbackUrl.href;
    updateStatusBadge("♡ watching (sync unavailable)");
  }

  async function loadState(state, memberId) {
    if (!state || (!state.stream_url && !state.source)) {
      clearPlayer();
      return;
    }
    const loadVersion = ++stateLoadVersion;

    isHost = state.host_id === memberId;
    const titleEl = document.getElementById("filmtvTitle");
    if (titleEl) titleEl.textContent = state.title || "FilmTV Watch Party";

    const empty = document.getElementById("filmtvEmpty");
    if (empty) empty.style.display = "none";

    const iframeContainer = document.getElementById("filmtvIframeContainer");

    const sourceStr = (state.source || "").toLowerCase();
    const rawUrl = (state.source || state.stream_url || "").trim();
    const videoExtension = /\.(mp4|webm|ogg|mov|mkv|m4v)$/i;
    const isVideoUpload = state.source_type === "upload" && videoExtension.test(sourceStr);
    const isPdfUpload = state.source_type === "upload" && /\.pdf$/i.test(sourceStr);
    const isDirectVideo = state.source_type !== "upload" && (() => {
      try {
        return videoExtension.test(new URL(rawUrl).pathname);
      } catch {
        return false;
      }
    })();

    if ((isVideoUpload || isDirectVideo) && videoEl) {
      pdfViewer()?.close();
      suppressRemoteControls();
      if (youtubePlayer) stopYouTubePlayer();
      ensureIframe();
      if (iframeContainer) iframeContainer.style.display = "none";

      videoEl.style.display = "block";
      const src = resolveAbsoluteUrl(isVideoUpload ? (state.stream_url || "/api/filmtv/stream") : rawUrl);
      if (currentVideoSource !== state.source || videoEl.src !== src) {
        currentVideoSource = state.source;
        videoEl.src = src;
        videoEl.load();
      }
      latestVideoState = state;
      if (videoEl.readyState >= 1) applyLatestVideoState();
      videoEl.controls = isHost;
      updateStatusBadge(isHost ? "♡ hosting (synced)" : "♡ watching (synced)");
      return;
    }

    if (isPdfUpload && pdfViewer()) {
      openStage();
      if (videoEl) {
        videoEl.pause();
        videoEl.style.display = "none";
        currentVideoSource = null;
        latestVideoState = null;
      }
      if (iframeContainer) iframeContainer.style.display = "none";
      try {
        await pdfViewer().open(state);
      } catch (error) {
        updateStatusBadge("♡ PDF unavailable");
        throw error;
      }
      updateStatusBadge(isHost ? "♡ reading together" : "♡ reading together");
      return;
    }

    pdfViewer()?.close();
    if (videoEl) {
      suppressRemoteControls();
      videoEl.pause();
      videoEl.style.display = "none";
      currentVideoSource = null;
      latestVideoState = null;
    }
    if (iframeContainer) iframeContainer.style.display = "block";

    if (state.source_type !== "upload") {
      const videoId = youtubeIdFromUrl(rawUrl);
      if (videoId) {
        if (iframeEl) iframeEl.style.display = "block";
        if (youtubeApiUnavailable) {
          loadYouTubeFallback(state, videoId);
          return;
        }
        updateStatusBadge(isHost ? "♡ hosting (syncing)" : "♡ watching (syncing)");
        applyYouTubeState(state, videoId).then(() => {
          if (loadVersion === stateLoadVersion && !youtubeApiUnavailable) {
            updateStatusBadge(isHost ? "♡ hosting (synced)" : "♡ watching (synced)");
          }
        }).catch((err) => {
          if (loadVersion !== stateLoadVersion) return;
          console.warn("YouTube sync unavailable; using iframe playback:", err);
          youtubeApiUnavailable = true;
          loadYouTubeFallback(state, videoId);
        });
        return;
      }
    }

    if (youtubePlayer) stopYouTubePlayer();
    ensureIframe();
    if (iframeEl) {
      iframeEl.setAttribute("sandbox", "allow-scripts allow-popups allow-forms allow-downloads allow-same-origin allow-modals");
      iframeEl.style.display = "block";
      let displaySource = rawUrl;

      if (state.source_type === "upload") {
        const extension = sourceStr.split("?")[0].split("#")[0].split(".").pop();
        const streamUrl = resolveAbsoluteUrl(state.stream_url || "/api/filmtv/stream");
        if (extension === "pdf") {
          displaySource = streamUrl;
        } else if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(extension)) {
          const publicStreamUrl = await getOfficePreviewUrl();
          displaySource = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(publicStreamUrl)}`;
        } else {
          displaySource = streamUrl;
        }
      }

      const absoluteSource = resolveAbsoluteUrl(displaySource);
      if (iframeEl.src !== absoluteSource) iframeEl.src = absoluteSource;
    }

    updateStatusBadge(isHost ? "♡ hosting (synced)" : "♡ watching (synced)");
  }

  function clearPlayer() {
    stateLoadVersion += 1;
    isHost = false;
    pdfViewer()?.close();
    latestVideoState = null;
    currentVideoSource = null;
    suppressRemoteControls();
    if (youtubePlayer) stopYouTubePlayer();
    ensureIframe();
    if (iframeEl) iframeEl.removeAttribute("src");
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
      videoEl.style.display = "none";
    }
    const iframeContainer = document.getElementById("filmtvIframeContainer");
    if (iframeContainer) iframeContainer.style.display = "none";

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
    const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (fullscreenElement && exitFullscreen) {
      Promise.resolve(exitFullscreen.call(document)).catch((err) => {
        console.warn("Unable to exit fullscreen:", err);
      });
    }
    document.body.classList.remove("theater-mode", "filmtv-open");
    document.body.classList.remove("messages-open", "film-fullscreen");
    document.getElementById("filmtvStage")?.classList.remove("open");
    document.getElementById("btnFilmTV")?.classList.remove("active");
    updateFullscreenButton();
    updateMessagesButton();
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

  function updateFullscreenButton() {
    const button = document.getElementById("btnFilmTVFullscreen");
    if (!button) return;
    const roomSplit = document.getElementById("roomSplit");
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const active = fullscreenElement === roomSplit;
    document.body.classList.toggle("film-fullscreen", active);
    button.textContent = active ? "Exit full screen" : "Full screen";
    button.setAttribute("aria-pressed", String(active));
  }

  function updateMessagesButton() {
    const button = document.getElementById("btnFilmTVMessages");
    if (!button) return;
    const visible = document.body.classList.contains("messages-open");
    button.textContent = visible ? "Hide messages" : "Messages";
    button.setAttribute("aria-pressed", String(visible));
  }

  async function toggleFullscreen() {
    const roomSplit = document.getElementById("roomSplit");
    if (!roomSplit) return;
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
    if (fullscreenElement) {
      if (exitFullscreen) await exitFullscreen.call(document);
      return;
    }

    openTheater();
    const requestFullscreen = roomSplit.requestFullscreen || roomSplit.webkitRequestFullscreen;
    if (!requestFullscreen) {
      throw new Error("Fullscreen is not supported by this browser.");
    }
    await requestFullscreen.call(roomSplit);
    updateFullscreenButton();
  }

  function toggleMessages() {
    if (!document.body.classList.contains("theater-mode")) openTheater();
    const open = document.body.classList.toggle("messages-open");
    document.body.classList.toggle("mobile-chat-open", open);
    updateMessagesButton();
    if (open) {
      const composer = document.getElementById("composerInput");
      composer?.focus({ preventScroll: true });
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("fullscreenchange", updateFullscreenButton);
    document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
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
    toggleFullscreen,
    toggleMessages,
    updateStatusBadge,
  };
})();