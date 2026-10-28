/**
 * Sathi OTT & Social Media DOM Interceptor & Content Script Bridge
 * Captures play, pause, seek, and timestamp events from Netflix, Disney+ Hotstar,
 * JioCinema, YouTube, Instagram, and standard HTML5 video elements.
 * Forwards state to Android Native @JavascriptInterface and Socket.IO server.
 */
const SathiOttBridge = (() => {
  "use strict";

  let isRemoteSeeking = false;
  let activeVideoEl = null;

  function attachVideoInterceptors() {
    const videos = document.querySelectorAll("video");
    videos.forEach((video) => {
      if (video.dataset.sathiHooked) return;
      video.dataset.sathiHooked = "true";
      activeVideoEl = video;

      video.addEventListener("play", () => {
        if (isRemoteSeeking) return;
        notifyPlaybackState("play", video.currentTime);
      });

      video.addEventListener("pause", () => {
        if (isRemoteSeeking) return;
        notifyPlaybackState("pause", video.currentTime);
      });

      video.addEventListener("seeked", () => {
        if (isRemoteSeeking) return;
        notifyPlaybackState("seek", video.currentTime);
      });
    });
  }

  function notifyPlaybackState(action, currentTime) {
    const payload = {
      action,
      time: currentTime || 0,
      url: window.location.href,
      timestamp: Date.now(),
    };

    if (window.SathiAndroidBridge && window.SathiAndroidBridge.onVideoEvent) {
      try {
        window.SathiAndroidBridge.onVideoEvent(JSON.stringify(payload));
      } catch (e) { }
    }

    const socket = window.appSocket || window.AppSocket;
    if (socket && socket.connected) {
      socket.emit("ott_player_control", payload);
    }
  }

  function applyRemotePlayback(action, time) {
    if (!activeVideoEl) attachVideoInterceptors();
    if (!activeVideoEl) return;

    isRemoteSeeking = true;
    if (time !== undefined && Math.abs(activeVideoEl.currentTime - time) > 1.0) {
      try { activeVideoEl.currentTime = time; } catch (e) { }
    }

    if (action === "play") {
      activeVideoEl.play().catch(() => {});
    } else if (action === "pause") {
      activeVideoEl.pause();
    }

    setTimeout(() => { isRemoteSeeking = false; }, 600);
  }

  setInterval(attachVideoInterceptors, 1000);

  return {
    attachVideoInterceptors,
    notifyPlaybackState,
    applyRemotePlayback,
  };
})();

window.SathiOttBridge = SathiOttBridge;
