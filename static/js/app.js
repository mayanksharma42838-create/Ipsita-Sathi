/* global CryptoClient, OfflineStore, PrivacyGuard, DoodleBoard, FilmTV, PdfDocumentViewer, io */

const App = (() => {
  const THEMES = {
    blush: { bg: "linear-gradient(160deg,#1a0f14,#3a1528)", accent: "#ff4d7a" },
    midnight: { bg: "linear-gradient(160deg,#0b1020,#1a2040)", accent: "#7aa2ff" },
    forest: { bg: "linear-gradient(160deg,#0f1a14,#1a3324)", accent: "#6bcb77" },
    sand: { bg: "linear-gradient(160deg,#2a2218,#3d3224)", accent: "#e8b86d" },
    lavender: { bg: "linear-gradient(160deg,#1a1428,#2a1a40)", accent: "#c9a0ff" },
  };

  let state = {
    token: null,
    memberId: null,
    displayName: null,
    phoneNumber: null,
    roomId: null,
    password: null,
    key: null,
    socket: null,
    ttlSeconds: 0,
    mediaRecorder: null,
    audioChunks: [],
    recording: false,
  };
  let partnerLaunchWindow = null;

  const WATCH_PROVIDER_URLS = {
    teleparty: "https://www.teleparty.com/mobile-download",
    rave: "https://www.rave.io/",
  };

  const WATCH_PROVIDER_NAMES = {
    teleparty: "Teleparty",
    rave: "Rave",
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  function googleSearchUrl(query) {
    const url = new URL("https://www.google.com/search");
    url.searchParams.set("q", query);
    return url;
  }

  function headers(json = true) {
    const h = { "X-Session-Token": state.token };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      credentials: "include",
      headers: { ...headers(!(opts.body instanceof FormData)), ...(opts.headers || {}) },
    });

    let data;
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok) {
      const errorMsg = data.error || `Request failed (${res.status})`;
      throw new Error(errorMsg);
    }
    return data;
  }

  function showAuthError(msg) {
    const el = $("#authError");
    if (el) el.textContent = msg || "";
  }

  function normalizePhoneNumber(value) {
    return String(value || "").trim().replace(/[\s().-]/g, "").replace(/^\+/, "");
  }

  function handleLogin(contact, email, room, password) {
    const userData = { contact, email, room, password, isLoggedIn: true };
    localStorage.setItem("sathi_user_session", JSON.stringify(userData));
  }

  function triggerMessageNotification(sender, text) {
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(`Message from ${sender || "Partner"}`, {
          body: text || "New message received",
          icon: "/favicon.ico",
        });
      } catch (e) { }
    }
  }

  function leaveRoom() {
    localStorage.removeItem("sathi_user_session");
    logout().catch(() => { });
    window.location.href = "/";
  }

  window.handleLogin = handleLogin;
  window.triggerMessageNotification = triggerMessageNotification;
  window.leaveRoom = leaveRoom;

  async function loginRoom(event) {
    event?.preventDefault();
    showAuthError("");
    const phoneNumber = $("#phoneNumber")?.value.trim() || "";
    const emailAddress = $("#emailAddress")?.value.trim() || "";
    const roomName = $("#roomName")?.value.trim() || "";
    const password = $("#roomPassword")?.value || "";
    const legacyRoomId = $("#legacyRoomId")?.value.trim();
    const saved = OfflineStore.getSession();
    const loginButton = $("#btnLogin");
    if (loginButton) loginButton.disabled = true;

    const identifier = phoneNumber || emailAddress || roomName;

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          identifier: identifier,
          phone_number: phoneNumber || emailAddress,
          password,
          legacy_room_id: legacyRoomId || roomName || undefined,
          resume_token:
            saved?.token && normalizePhoneNumber(saved.phoneNumber) === normalizePhoneNumber(phoneNumber)
              ? saved.token
              : undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Login failed (${response.status})`);

      handleLogin(phoneNumber, emailAddress, data.room_id || roomName, password);
      await enterRoom(data, password, data.phone_number || phoneNumber || emailAddress);
    } catch (e) {
      showAuthError(e.message);
    } finally {
      if (loginButton) loginButton.disabled = false;
    }
  }

  async function logout() {
    try {
      if (state.token) {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { "X-Session-Token": state.token },
        });
      }
    } catch {
      /* ignore */
    }
    if (state.socket) {
      try {
        state.socket.disconnect();
      } catch {
        /* ignore */
      }
      state.socket = null;
    }
    OfflineStore.clearSession();
    state.token = null;
    state.memberId = null;
    state.displayName = null;
    state.phoneNumber = null;
    state.roomId = null;
    state.password = null;
    state.key = null;
    document.body.classList.remove("filmtv-open", "theater-mode");
    $("#chatView")?.classList.remove("active");
    $("#authView")?.classList.remove("hidden");
    closeModal("settingsModal");
  }

  async function enterRoom(data, password, phoneNumber = data.phone_number || "") {
    state.token = data.session_token;
    state.memberId = data.member_id;
    state.displayName = data.display_name;
    state.phoneNumber = phoneNumber;
    state.roomId = data.room_id;
    state.password = password;

    const saltBase64 = data.salt;
    let salt = undefined;
    if (saltBase64) {
      salt = CryptoClient.b64decode(saltBase64);
    }
    state.key = await CryptoClient.deriveKey(state.roomId, password, salt);

    if (data.theme_opacity !== undefined) {
      document.documentElement.style.setProperty("--overlay-opacity", data.theme_opacity);
      if ($("#themeOpacity")) {
        $("#themeOpacity").value = Math.round(data.theme_opacity * 100);
        $("#themeOpacityVal").textContent = Math.round(data.theme_opacity * 100) + "%";
      }
    }

    OfflineStore.setSession({
      token: state.token,
      memberId: state.memberId,
      displayName: state.displayName,
      roomId: state.roomId,
      phoneNumber: state.phoneNumber,
    });

    $("#authView")?.classList.add("hidden");
    $("#chatView")?.classList.add("active");
    if ($("#roomLabel")) $("#roomLabel").textContent = state.phoneNumber ? "Private room" : state.roomId;
    if ($("#meLabel")) $("#meLabel").textContent = state.displayName;

    initFilmTV();
    initZoom();
    connectSocket();
    await loadMessages();
    await loadGallery();
    await loadDoodle();
    await flushOutbox();

    if (data.theme_preset === "custom") {
      applyCustomTheme(data.theme_url);
    } else {
      applyTheme(data.theme_preset || "blush");
    }

    if (data.filmtv) await FilmTV.loadState(data.filmtv, state.memberId);
    else await refreshFilmTVState();
  }

  function initFilmTV() {
    const container = $("#filmtvIframeContainer");
    if (!container || !window.FilmTV) return;
    FilmTV.init({
      container,
      socket: state.socket,
      tokenFn: () => state.token,
    });
  }

  function openFilmTV() {
    FilmTV.openStage();
    if (state.socket) {
      state.socket.emit("filmtv_request_sync", { token: state.token });
    } else {
      refreshFilmTVState();
    }
  }

  function closeFilmTV() {
    FilmTV.closeTheater();
  }

  function setFilmTVError(msg) {
    const el = $("#filmtvError");
    if (el) el.textContent = msg || "";
  }

  async function refreshFilmTVState() {
    try {
      const data = await api("/api/filmtv/state");
      if (data.state) await FilmTV.loadState(data.state, state.memberId);
    } catch {
      /* ignore until room ready */
    }
  }

  async function loadFilmTVUrl() {
    setFilmTVError("");
    const urlInput = $("#filmtvUrl");
    const url = (urlInput?.value || "").trim();
    const title = ($("#filmtvTitleInput")?.value || "").trim();
    if (!url) {
      setFilmTVError("Please paste a valid video URL, YouTube link, or document link.");
      return;
    }
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") {
        setFilmTVError("Only HTTPS URLs are allowed.");
        return;
      }
    } catch {
      setFilmTVError("Invalid URL format.");
      return;
    }

    const shareButton = $("#btnFilmTVLoad");
    if (shareButton) shareButton.disabled = true;
    try {
      const data = await api("/api/filmtv/source", {
        method: "POST",
        body: JSON.stringify({ source: url, source_type: "url", title: title || undefined }),
      });
      if (!data?.state) throw new Error("Server did not return FilmTV state");
      await FilmTV.loadState(data.state, state.memberId);
      if (urlInput) urlInput.value = "";
    } catch (e) {
      setFilmTVError(e.message);
    } finally {
      if (shareButton) shareButton.disabled = false;
    }
  }

  async function uploadFilmTV(file) {
    setFilmTVError("");
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const title = ($("#filmtvTitleInput")?.value || "").trim();
    if (title) fd.append("title", title);
    try {
      const res = await fetch("/api/filmtv/upload", {
        method: "POST",
        headers: { "X-Session-Token": state.token },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed");

      if (data.state) {
        await FilmTV.loadState(data.state, state.memberId);
        const fileInput = $("#filmtvFile");
        if (fileInput) fileInput.value = "";
      }
    } catch (e) {
      setFilmTVError(e.message);
    }
  }

  async function clearFilmTV() {
    setFilmTVError("");
    try {
      const data = await api("/api/filmtv/clear", { method: "POST", body: "{}" });
      if (data && data.state) {
        await FilmTV.loadState(data.state, state.memberId);
      } else {
        FilmTV.clearPlayer();
      }
      if ($("#filmtvUrl")) $("#filmtvUrl").value = "";
    } catch (e) {
      setFilmTVError(e.message);
    }
  }

  async function requestNotificationPermissions(silent = false) {
    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
      try {
        const localNotifs = window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
        if (localNotifs) {
          const perm = await localNotifs.checkPermissions();
          if (perm.display !== "granted") {
            const req = await localNotifs.requestPermissions();
            if (req.display === "granted") {
              if (!silent) alert("Native mobile notifications enabled!");
              try {
                await localNotifs.createChannel({
                  id: "sathi_messages",
                  name: "Sathi Messages",
                  description: "Room notifications for messages and sync events",
                  importance: 5,
                  visibility: 1,
                  sound: "notification.wav",
                  vibration: true,
                });
              } catch (e) { }
            }
          }
        }
      } catch (err) {
        console.warn("Capacitor LocalNotifications error:", err);
      }
    }

    if ("Notification" in window) {
      if (Notification.permission === "default") {
        if (!silent) {
          const perm = await Notification.requestPermission();
          if (perm === "granted") {
            alert("Background notifications enabled!");
          }
        }
      } else if (Notification.permission === "granted" && !silent) {
        alert("Notifications are already enabled.");
      }
    }
  }

  function showWaNotification(sender, text) {
    const banner = $("#waNotificationBanner");
    const senderEl = $("#waNotifySender");
    const msgEl = $("#waNotifyMessage");
    if (banner && senderEl && msgEl) {
      senderEl.textContent = sender || "Partner";
      msgEl.textContent = text || "New message received";
      banner.classList.add("show");
      setTimeout(() => banner.classList.remove("show"), 4000);
    }

    // Play subtle chime sound
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
    } catch (e) { }

    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }

    if (window.Capacitor && window.Capacitor.isNativePlatform()) {
      try {
        const localNotifs = window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
        if (localNotifs) {
          localNotifs.schedule({
            notifications: [
              {
                title: `💬 ${sender || "Partner"}`,
                body: text || "New message received",
                id: Math.floor(Math.random() * 100000) + 1,
                schedule: { at: new Date(Date.now() + 100) },
                channelId: "sathi_messages",
              },
            ],
          });
        }
      } catch (e) { }
    }

    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      try {
        new Notification(`💬 ${sender || "Partner"}`, {
          body: text || "New message received",
          icon: "/static/icons/icon-192.png",
        });
      } catch (e) { }
    }
  }

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    state.socket = io({
      auth: { token: state.token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    window.appSocket = state.socket;
    FilmTV.setSocket(state.socket);
    if (window.CoupleGames && window.CoupleGames.init) {
      window.CoupleGames.init(state.socket, state.memberId);
    }
    requestNotificationPermissions(true);

    state.socket.on("new_message", (msg) => {
      renderMessage(msg);
      if (msg.media_url) loadGallery();
      if (msg.sender_id !== state.memberId) {
        let text = "New message received";
        if (state.key && msg.ciphertext) {
          text = decryptText(msg.ciphertext, state.key) || "New photo/message";
        }
        if (document.hidden || !document.hasFocus()) {
          showWaNotification(msg.sender_name || "Partner", text);
        }
      }
    });

    state.socket.on("widget_sync", (data) => {
      if (window.FloatingWidget && window.FloatingWidget.handleIncomingWidgetSync) {
        window.FloatingWidget.handleIncomingWidgetSync(data);
      }
    });

    state.socket.on("avatar_updated", (data) => {
      if (data && data.avatar_url) {
        const headerAvatar = $("#partnerAvatarHeader");
        if (headerAvatar) headerAvatar.src = `${data.avatar_url}?v=${Date.now()}`;
      }
    });

    state.socket.on("room_updated", (data) => {
      if (data && data.room_name && $("#roomLabel")) {
        $("#roomLabel").textContent = data.room_name;
      }
    });

    state.socket.on("message_reaction", (data) => {
      if (data && data.msg_id && data.reaction) {
        const msgEl = document.querySelector(`[data-msg-id="${data.msg_id}"]`);
        if (msgEl) {
          let badge = msgEl.querySelector(".msg-reaction-badge");
          if (!badge) {
            badge = document.createElement("div");
            badge.className = "msg-reaction-badge";
            msgEl.appendChild(badge);
          }
          badge.textContent = data.reaction;
        }
      }
    });

    state.socket.on("read_receipt", (data) => {
      document.querySelectorAll(".msg.me .msg-ticks").forEach((t) => {
        t.className = "msg-ticks read";
        t.textContent = "✓✓";
      });
    });
    state.socket.on("messages_expired", ({ ids }) => {
      ids.forEach((id) => {
        const el = document.querySelector(`[data-msg-id="${id}"]`);
        if (el) el.remove();
      });
    });
    state.socket.on("presence", (p) => {
      const el = $("#presenceDot");
      const txt = $("#presenceText");
      if (el && txt) {
        if (p.online) {
          el.classList.remove("off");
          txt.textContent = `${p.display_name} online`;
        } else {
          el.classList.add("off");
          txt.textContent = `${p.display_name} offline`;
        }
      }
    });
    state.socket.on("typing", (p) => {
      const typingEl = $("#typing");
      if (typingEl) typingEl.textContent = p.typing ? `${p.display_name} is typing…` : "";
    });
    state.socket.on("theme_updated", (t) => {
      if (t.theme_opacity !== undefined) {
        document.documentElement.style.setProperty("--overlay-opacity", t.theme_opacity);
        if ($("#themeOpacity")) {
          $("#themeOpacity").value = Math.round(t.theme_opacity * 100);
          $("#themeOpacityVal").textContent = Math.round(t.theme_opacity * 100) + "%";
        }
      }
      if (t.theme_preset === "custom") applyCustomTheme(t.theme_url);
      else applyTheme(t.theme_preset);
    });
    state.socket.on("doodle_stroke", (p) => DoodleBoard.applyRemote({ points: p.points, ...p }));
    state.socket.on("doodle_clear", () => DoodleBoard.clear());
    state.socket.on("instagram_sync", (p) => showInstagram(p.url));
    state.socket.on("doodle_saved", () => { });

    // Fixed socket listeners passing correct state.memberId to prevent host/watcher mismatch
    state.socket.on("filmtv_control", (payload) => {
      if (payload && payload.state) {
        FilmTV.loadState(payload.state, state.memberId).catch((e) => setFilmTVError(e.message));
      } else {
        FilmTV.applyRemoteControl(payload).catch((e) => setFilmTVError(e.message));
      }
    });
    state.socket.on("filmtv_state", (payload) => {
      if (payload && payload.state) {
        FilmTV.loadState(payload.state, state.memberId).catch((e) => setFilmTVError(e.message));
      }
    });
    state.socket.on("filmtv_search", (payload) => {
      if (!payload || typeof payload.query !== "string") return;
      FilmTV.openStage();
      const input = $("#filmtvSearchInput");
      const openButton = $("#btnFilmTVPartnerSearch");
      const status = $("#filmtvSearchStatus");
      if (input) input.value = payload.query;
      if (partnerLaunchWindow && !partnerLaunchWindow.closed) {
        partnerLaunchWindow.location.href = googleSearchUrl(payload.query).href;
        if (openButton) openButton.hidden = true;
        if (status) status.textContent = `${payload.by || "Your partner"} searched: ${payload.query}. Search opened in your opted-in tab; page clicks do not sync.`;
        return;
      }
      if (openButton) {
        openButton.dataset.query = payload.query;
        openButton.hidden = false;
      }
      if (status) status.textContent = `${payload.by || "Your partner"} searched: ${payload.query}`;
    });
    state.socket.on("filmtv_provider_launch", (payload) => {
      const provider = payload?.provider;
      const url = WATCH_PROVIDER_URLS[provider];
      const name = WATCH_PROVIDER_NAMES[provider];
      if (!url || !name) return;
      FilmTV.openStage();
      const status = $("#filmtvSearchStatus");
      if (partnerLaunchWindow && !partnerLaunchWindow.closed) {
        partnerLaunchWindow.location.href = url;
        if (status) status.textContent = `${payload.by || "Your partner"} opened ${name} in your opted-in tab. Both viewers need service access and must join the same party there.`;
        return;
      }
      const openButton = $("#btnFilmTVPartnerProvider");
      if (openButton) {
        openButton.dataset.provider = provider;
        openButton.textContent = `Open partner's ${name} ↗`;
        openButton.hidden = false;
      }
      if (status) status.textContent = `${payload.by || "Your partner"} wants to open ${name}. Tap to continue; both viewers need service access and must join the same party there.`;
    });
    state.socket.on("filmtv_annotation_added", (annotation) => {
      PdfDocumentViewer.receiveAnnotation(annotation);
    });
    state.socket.on("filmtv_annotations_cleared", (payload) => {
      PdfDocumentViewer.clearRemoteAnnotations(payload);
    });

    // WebRTC Screen Sharing Socket Listeners
    state.socket.on("webrtc_offer", async (payload) => {
      if (!payload || !payload.sdp) return;
      FilmTV.openStage();

      if (rtcPeerConnection) rtcPeerConnection.close();
      rtcPeerConnection = new RTCPeerConnection(rtcConfig);

      rtcPeerConnection.ontrack = (event) => {
        const videoEl = $("#filmtvVideo");
        const iframeContainer = $("#filmtvIframeContainer");
        const empty = $("#filmtvEmpty");
        if (empty) empty.style.display = "none";
        if (iframeContainer) iframeContainer.style.display = "none";
        if (videoEl) {
          videoEl.srcObject = event.streams[0];
          videoEl.style.display = "block";
          videoEl.play().catch(() => {});
        }
      };

      rtcPeerConnection.onicecandidate = (e) => {
        if (e.candidate && state.socket) {
          state.socket.emit("webrtc_ice_candidate", { candidate: e.candidate });
        }
      };

      try {
        await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        const answer = await rtcPeerConnection.createAnswer();
        await rtcPeerConnection.setLocalDescription(answer);
        state.socket.emit("webrtc_answer", { sdp: rtcPeerConnection.localDescription });
      } catch (err) {
        console.warn("WebRTC offer error:", err);
      }
    });

    state.socket.on("webrtc_answer", async (payload) => {
      if (!payload || !payload.sdp || !rtcPeerConnection) return;
      try {
        await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      } catch (err) {
        console.warn("WebRTC answer error:", err);
      }
    });

    state.socket.on("webrtc_ice_candidate", async (payload) => {
      if (!payload || !payload.candidate || !rtcPeerConnection) return;
      try {
        await rtcPeerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (e) {
        console.warn("ICE candidate error:", e);
      }
    });

    state.socket.on("webrtc_stop_screen", () => {
      if (rtcPeerConnection) {
        rtcPeerConnection.close();
        rtcPeerConnection = null;
      }
      const videoEl = $("#filmtvVideo");
      if (videoEl) {
        videoEl.srcObject = null;
        videoEl.style.display = "none";
      }
      const empty = $("#filmtvEmpty");
      if (empty) empty.style.display = "flex";
    });

    state.socket.on("connect", () => {
      state.socket.emit("filmtv_request_sync", { token: state.token });
    });

    // ─── New Synced Socket Listeners (YouTube Watch Party, Aesthetic Timer, Study Music, Doc Annotations) ───
    state.socket.on("yt_sync", (payload) => handleRemoteYtSync(payload));
    state.socket.on("video_sync", (payload) => handleRemoteVideoSync(payload));
    state.socket.on("timer_sync", (payload) => handleRemoteTimerSync(payload));
    state.socket.on("music_sync", (payload) => handleRemoteMusicSync(payload));
    state.socket.on("doc_annotation_sync", (payload) => handleRemoteDocAnnotationSync(payload));
    state.socket.on("spotify_sync", (payload) => handleRemoteSpotifySync(payload));
  }

  let zoomState = { scale: 1, x: 0, y: 0, lastX: 0, lastY: 0, dragging: false };

  function initZoom() {
    const img = $("#zoomImage");
    const viewport = $(".zoom-viewport");
    if (!img || !viewport) return;
    const apply = () => {
      img.style.transform = `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;
    };
    $("#btnZoomIn")?.addEventListener("click", () => { zoomState.scale *= 1.2; apply(); });
    $("#btnZoomOut")?.addEventListener("click", () => { zoomState.scale /= 1.2; apply(); });
    $("#btnZoomReset")?.addEventListener("click", () => {
      zoomState = { scale: 1, x: 0, y: 0, lastX: 0, lastY: 0, dragging: false };
      apply();
    });
    viewport.addEventListener("mousedown", (e) => {
      zoomState.dragging = true;
      zoomState.lastX = e.clientX - zoomState.x;
      zoomState.lastY = e.clientY - zoomState.y;
    });
    window.addEventListener("mousemove", (e) => {
      if (!zoomState.dragging) return;
      zoomState.x = e.clientX - zoomState.lastX;
      zoomState.y = e.clientY - zoomState.lastY;
      apply();
    });

    window.addEventListener("mouseup", () => { zoomState.dragging = false; });
    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      zoomState.scale *= delta;
      apply();
    }, { passive: false });
  }

  function openZoom(src) {
    const img = $("#zoomImage");
    if (!img) return;
    img.src = src;
    zoomState = { scale: 1, x: 0, y: 0, lastX: 0, lastY: 0, dragging: false };
    img.style.transform = `none`;
    openModal("mediaZoomModal");
  }

  async function loadGallery() {
    const grid = $("#galleryGrid");
    if (!grid) return;
    try {
      const data = await api("/api/gallery");
      grid.innerHTML = "";
      if (!data.gallery || !data.gallery.length) {
        grid.innerHTML = '<p class="hint" style="grid-column:1/-1;text-align:center;padding:20px;">The vault is empty. Share photos or voice notes to see them here.</p>';
        return;
      }
      for (const m of data.gallery) {
        const item = document.createElement("div");
        item.className = "gallery-item";
        if (m.msg_type === "image") {
          const img = await fetchDecryptedMedia(m);
          if (img) {
            item.appendChild(img);
            item.addEventListener("click", () => openZoom(img.src));
          }
        } else if (m.msg_type === "voice") {
          const audio = await fetchDecryptedAudio(m);
          if (audio) {
            const icon = document.createElement("div");
            icon.textContent = "🎙 Voice Note";
            icon.style.marginBottom = "8px";
            item.appendChild(icon);
            item.appendChild(audio);
          }
        }
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = `${m.sender_name} · ${new Date(m.created_at).toLocaleDateString()}`;
        item.appendChild(meta);
        grid.appendChild(item);
      }
    } catch (e) {
      grid.innerHTML = `<p class="err">${e.message}</p>`;
    }
  }

  async function loadDoodle() {
    if (!state.token) return;
    try {
      const response = await fetch("/api/doodle/latest", {
        credentials: "include",
        headers: headers(false),
      });
      if (response.status === 404) {
        if (typeof DoodleBoard !== "undefined" && DoodleBoard.clear) DoodleBoard.clear();
        return;
      }
      if (!response.ok) throw new Error(`Doodle restore failed (${response.status})`);
      const blob = await response.blob();
      if (blob && blob.size > 0 && typeof DoodleBoard !== "undefined" && DoodleBoard.loadImage) {
        const loaded = await DoodleBoard.loadImage(blob);
        if (!loaded && DoodleBoard.clear) DoodleBoard.clear();
      } else if (typeof DoodleBoard !== "undefined" && DoodleBoard.clear) {
        DoodleBoard.clear();
      }
    } catch (error) {
      console.warn("Saved room doodle fallback engaged:", error);
      try {
        if (typeof DoodleBoard !== "undefined" && DoodleBoard.clear) DoodleBoard.clear();
      } catch (e) { }
    }
  }

  async function loadMessages() {
    const box = $("#messages");
    if (!box) return;
    try {
      const data = await api("/api/messages");
      box.innerHTML = "";
      for (const m of data.messages) await renderMessage(m, false);
      OfflineStore.cacheMessages(state.roomId, data.messages);
      scrollMessages();
    } catch {
      const cached = OfflineStore.getCachedMessages(state.roomId) || [];
      box.innerHTML = "";
      for (const m of cached) await renderMessage(m, false);
    }
  }

  let currentQuotedReply = null;

  function setQuotedReply(sender, snippet) {
    currentQuotedReply = { sender, snippet };
    const bar = $("#quotedReplyBar");
    const senderEl = $("#quotedReplySender");
    const textEl = $("#quotedReplyText");
    if (bar && senderEl && textEl) {
      senderEl.textContent = `Replying to ${sender}`;
      textEl.textContent = snippet;
      bar.classList.remove("hidden");
    }
  }

  function clearQuotedReply() {
    currentQuotedReply = null;
    const bar = $("#quotedReplyBar");
    if (bar) bar.classList.add("hidden");
  }

  async function renderMessage(m, scroll = true) {
    if (document.querySelector(`[data-msg-id="${m.id}"]`)) return;
    const isMe = m.sender_id === state.memberId;
    const div = document.createElement("div");
    div.className = `msg ${isMe ? "me" : "them"}`;
    div.dataset.msgId = m.id;

    const msgHeader = document.createElement("div");
    msgHeader.className = "msg-header";
    const avatarImg = document.createElement("img");
    avatarImg.className = "msg-avatar";
    avatarImg.src = m.sender_avatar_url || `/api/profile/avatar/${m.sender_id}`;
    avatarImg.alt = "DP";
    const senderSpan = document.createElement("span");
    senderSpan.className = "msg-sender";
    senderSpan.textContent = m.sender_name || "Partner";
    msgHeader.appendChild(avatarImg);
    msgHeader.appendChild(senderSpan);
    div.appendChild(msgHeader);

    const plain = state.key ? await CryptoClient.decryptText(state.key, m.ciphertext) : null;
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = plain || "[encrypted]";
    div.appendChild(body);

    if (m.media_url && m.msg_type === "image") {
      try {
        const img = await fetchDecryptedMedia(m);
        if (img) div.appendChild(img);
      } catch { /* skip */ }
    }
    if (m.media_url && m.msg_type === "voice") {
      try {
        const audio = await fetchDecryptedAudio(m);
        if (audio) div.appendChild(audio);
      } catch { /* skip */ }
    }

    const footer = document.createElement("div");
    footer.className = "msg-footer";
    const timeSpan = document.createElement("span");
    timeSpan.className = "msg-time";
    timeSpan.textContent = new Date(m.created_at || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    footer.appendChild(timeSpan);

    if (isMe) {
      const ticksSpan = document.createElement("span");
      ticksSpan.className = "msg-ticks read";
      ticksSpan.textContent = "✓✓";
      footer.appendChild(ticksSpan);
    }

    div.appendChild(footer);

    div.addEventListener("dblclick", () => {
      setQuotedReply(m.sender_name || "Partner", plain || "Media message");
    });

    if (m.expires_at) {
      const ttl = document.createElement("div");
      ttl.className = "ttl";
      ttl.textContent = `⏱ disappears ${new Date(m.expires_at).toLocaleTimeString()}`;
      div.appendChild(ttl);
      scheduleExpiry(m.id, m.expires_at);
    }

    $("#messages")?.appendChild(div);

    // Also append to Fullscreen Mini Chat Overlay
    const fsChatBox = $("#fullscreenChatMessages");
    if (fsChatBox && plain) {
      const fsDiv = document.createElement("div");
      fsDiv.className = `fullscreen-chat-msg ${isMe ? "me" : "them"}`;
      fsDiv.textContent = `${isMe ? "Me" : (m.sender_name || "Partner")}: ${plain}`;
      fsChatBox.appendChild(fsDiv);
      fsChatBox.scrollTop = fsChatBox.scrollHeight;

      if (!isMe && $("#fullscreenChatOverlay")?.classList.contains("hidden")) {
        $("#fullscreenChatOverlay")?.classList.remove("hidden");
      }
    }

    if (scroll) scrollMessages();
  }

  function scheduleExpiry(id, expiresAt) {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      document.querySelector(`[data-msg-id="${id}"]`)?.remove();
      return;
    }
    setTimeout(() => {
      document.querySelector(`[data-msg-id="${id}"]`)?.remove();
    }, ms + 200);
  }

  async function fetchDecryptedMedia(m) {
    const url = m.media_url.includes("?") ? `${m.media_url}&token=${encodeURIComponent(state.token || "")}` : `${m.media_url}?token=${encodeURIComponent(state.token || "")}`;
    const res = await fetch(url, { headers: headers(false), credentials: "include" });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    let blob;
    try {
      const dec = await CryptoClient.decryptBlob(state.key, buf);
      blob = new Blob([dec], { type: m.media_mime || "image/jpeg" });
    } catch {
      blob = new Blob([buf], { type: m.media_mime || "image/jpeg" });
    }
    const img = document.createElement("img");
    img.className = "media";
    img.src = URL.createObjectURL(blob);
    img.draggable = false;
    return img;
  }

  async function fetchDecryptedAudio(m) {
    const url = m.media_url.includes("?") ? `${m.media_url}&token=${encodeURIComponent(state.token || "")}` : `${m.media_url}?token=${encodeURIComponent(state.token || "")}`;
    const res = await fetch(url, { headers: headers(false), credentials: "include" });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    let blob;
    try {
      const dec = await CryptoClient.decryptBlob(state.key, buf);
      blob = new Blob([dec], { type: m.media_mime || "audio/webm" });
    } catch {
      blob = new Blob([buf], { type: m.media_mime || "audio/webm" });
    }
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = URL.createObjectURL(blob);
    audio.controlsList = "nodownload";
    return audio;
  }

  function scrollMessages() {
    const box = $("#messages");
    if (box) box.scrollTop = box.scrollHeight;
  }

  async function sendText() {
    const input = $("#composerInput");
    if (!input) return;
    let text = input.value.trim();
    if (!text || !state.key) return;

    if (currentQuotedReply) {
      text = `> [Replying to ${currentQuotedReply.sender}]: "${currentQuotedReply.snippet}"\n\n${text}`;
      clearQuotedReply();
    }

    input.value = "";

    const ciphertext = await CryptoClient.encryptText(state.key, text);
    const payload = {
      ciphertext,
      msg_type: "text",
      ttl_seconds: state.ttlSeconds || null,
    };

    if (!navigator.onLine) {
      OfflineStore.enqueueOutbox({ type: "text", payload });
      $("#offlineBanner")?.classList.add("show");
      return;
    }

    try {
      await api("/api/messages", { method: "POST", body: JSON.stringify(payload) });
    } catch (e) {
      OfflineStore.enqueueOutbox({ type: "text", payload });
      alert(e.message);
    }
  }

  async function flushOutbox() {
    if (!navigator.onLine) return;
    const items = OfflineStore.getOutbox() || [];
    const remaining = [];
    for (const item of items) {
      try {
        if (item.type === "text") {
          await api("/api/messages", { method: "POST", body: JSON.stringify(item.payload) });
        }
      } catch {
        remaining.push(item);
      }
    }
    OfflineStore.setOutbox(remaining);
    if (!remaining.length) $("#offlineBanner")?.classList.remove("show");
  }

  async function sendPhoto(file) {
    if (!file || !state.key) return;
    const buf = await file.arrayBuffer();
    const enc = await CryptoClient.encryptBlob(state.key, buf);
    const caption = await CryptoClient.encryptText(state.key, file.name || "photo");
    const fd = new FormData();
    fd.append("file", new Blob([enc]), "photo.enc");
    fd.append("ciphertext", caption);
    fd.append("msg_type", "image");
    fd.append("media_mime", file.type || "image/jpeg");
    if (state.ttlSeconds) fd.append("ttl_seconds", String(state.ttlSeconds));

    const res = await fetch("/api/media", {
      method: "POST",
      headers: { "X-Session-Token": state.token },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
  }

  async function toggleVoice() {
    if (state.recording) {
      state.mediaRecorder.stop();
      state.recording = false;
      const btn = $("#btnVoice");
      if (btn) btn.textContent = "🎙";
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    state.mediaRecorder = new MediaRecorder(stream);
    state.mediaRecorder.ondataavailable = (e) => state.audioChunks.push(e.data);
    state.mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(state.audioChunks, { type: "audio/webm" });
      const buf = await blob.arrayBuffer();
      const enc = await CryptoClient.encryptBlob(state.key, buf);
      const caption = await CryptoClient.encryptText(state.key, "voice note");
      const fd = new FormData();
      fd.append("file", new Blob([enc]), "voice.enc");
      fd.append("ciphertext", caption);
      fd.append("msg_type", "voice");
      fd.append("media_mime", "audio/webm");
      if (state.ttlSeconds) fd.append("ttl_seconds", String(state.ttlSeconds));
      await fetch("/api/media", {
        method: "POST",
        headers: { "X-Session-Token": state.token },
        body: fd,
      });
    };
    state.mediaRecorder.start();
    state.recording = true;
    const btn = $("#btnVoice");
    if (btn) btn.textContent = "⏹";
  }

  function applyTheme(name) {
    const t = THEMES[name] || THEMES.blush;
    document.documentElement.style.setProperty("--theme-image", "none");
    document.body.style.background = `${t.bg}, radial-gradient(ellipse at 20% 10%, #4a1a2e 0%, transparent 50%)`;
    document.documentElement.style.setProperty("--accent", t.accent);
    $$(".theme-swatch").forEach((el) => {
      el.classList.toggle("active", el.dataset.theme === name);
    });
  }

  async function applyCustomTheme(url = null) {
    const bg = url || `/api/theme/background?v=${Date.now()}`;
    document.documentElement.style.setProperty("--theme-image", `url(${bg})`);
    document.body.style.background = `url(${bg}) center/cover no-repeat fixed`;
  }

  async function saveTheme(preset) {
    applyTheme(preset);
    await api("/api/theme", { method: "POST", body: JSON.stringify({ theme_preset: preset }) });
  }

  async function uploadTheme(file) {
    const errEl = $("#themeError");
    if (errEl) errEl.textContent = "";
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/theme/upload", {
        method: "POST",
        headers: { "X-Session-Token": state.token },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Theme upload failed");
      await applyCustomTheme();
    } catch (e) {
      if (errEl) errEl.textContent = e.message;
    }
  }

  async function setThemeUrl(url) {
    if (!url) return;
    const errEl = $("#themeError");
    if (errEl) errEl.textContent = "";
    try {
      await api("/api/theme", {
        method: "POST",
        body: JSON.stringify({ theme_preset: "custom", custom_url: url }),
      });
      await applyCustomTheme(url);
      closeModal("themeModal");
    } catch (e) {
      if (errEl) errEl.textContent = e.message;
    }
  }

  async function searchTheme() {
    const queryInput = $("#themeSearchInput");
    const grid = $("#themeSearchResults");
    if (!queryInput || !grid) return;

    const query = queryInput.value.trim() || "wallpaper";
    grid.innerHTML = '<p class="hint" style="grid-column:1/-1;text-align:center;color:#fff;">Searching photos...</p>';

    try {
      let images = [];
      try {
        const res = await api(`/api/theme/search?q=${encodeURIComponent(query)}`);
        if (res && res.results && res.results.length > 0) {
          images = res.results;
        }
      } catch (err) {
        // Fallback generator
      }

      if (!images || images.length === 0) {
        for (let i = 0; i < 9; i++) {
          const sig = Math.floor(Math.random() * 1000) + i;
          images.push(`https://picsum.photos/seed/${encodeURIComponent(query)}_${sig}/400/400`);
        }
      }

      grid.innerHTML = "";
      images.forEach((url) => {
        const item = document.createElement("div");
        item.className = "search-item";
        item.style.backgroundImage = `url(${url})`;
        item.style.backgroundSize = "cover";
        item.style.backgroundPosition = "center";
        item.style.cursor = "pointer";
        item.style.height = "120px";
        item.style.borderRadius = "8px";
        item.style.border = "2px solid rgba(255,255,255,0.2)";

        item.addEventListener("click", () => {
          setThemeUrl(url);
        });
        grid.appendChild(item);
      });
    } catch (e) {
      grid.innerHTML = `<p class="err" style="grid-column:1/-1;text-align:center;">Failed to load photos.</p>`;
    }
  }

  async function updateDisplayName() {
    const name = $("#settingsName")?.value.trim();
    if (!name) return;
    await api("/api/auth/display-name", {
      method: "POST",
      body: JSON.stringify({ display_name: name }),
    });
    state.displayName = name;
    if ($("#meLabel")) $("#meLabel").textContent = name;
    closeModal("settingsModal");
  }

  function openModal(id) {
    $(`#${id}`)?.classList.add("open");
  }
  function closeModal(id) {
    $(`#${id}`)?.classList.remove("open");
  }

  function showInstagram(url) {
    const frame = $("#igFrame");
    const ph = $("#igPlaceholder");
    if (!frame || !ph) return;
    if (!url) {
      frame.removeAttribute("src");
      ph.style.display = "flex";
      return;
    }
    let embed = null;
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host !== "www.instagram.com" && host !== "instagram.com") {
        throw new Error("host");
      }
      if (!/^\/(p|reel|reels|tv)\/[\w\-]+\/?/.test(u.pathname)) {
        throw new Error("path");
      }
      const path = u.pathname.endsWith("/") ? u.pathname : u.pathname + "/";
      embed = `https://www.instagram.com${path}embed/`;
    } catch {
      frame.removeAttribute("src");
      ph.style.display = "flex";
      ph.textContent = "Blocked non-Instagram URL";
      return;
    }

    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.src = embed;
    ph.style.display = "none";
  }

  async function syncInstagram() {
    const url = $("#igUrl")?.value.trim();
    await api("/api/instagram/sync", { method: "POST", body: JSON.stringify({ url }) });
    if (state.socket) state.socket.emit("instagram_nav", { token: state.token, url });
    showInstagram(url);
  }

  async function saveIgSession() {
    const raw = $("#igSession")?.value.trim();
    if (!raw || !state.key) return;
    const enc = await CryptoClient.encryptText(state.key, raw);
    await api("/api/instagram/session", {
      method: "POST",
      body: JSON.stringify({ session_ciphertext: enc }),
    });
    if ($("#igSessionStatus")) $("#igSessionStatus").textContent = "Session saved (encrypted). Partner can load it.";
  }

  async function loadIgSession() {
    const data = await api("/api/instagram/session");
    const statusEl = $("#igSessionStatus");
    if (!data.session_ciphertext) {
      if (statusEl) statusEl.textContent = "No shared session yet.";
      return;
    }
    const plain = await CryptoClient.decryptText(state.key, data.session_ciphertext);
    if ($("#igSession")) $("#igSession").value = plain || "";
    if (statusEl) statusEl.textContent = plain ? "Session loaded." : "Could not decrypt.";
  }

  async function saveDoodle() {
    const blob = await DoodleBoard.toBlob();
    if (!blob) return;
    const fd = new FormData();
    fd.append("file", blob, "doodle.png");
    await fetch("/api/doodle/save", {
      method: "POST",
      headers: { "X-Session-Token": state.token },
      body: fd,
    });
  }

  async function searchMovieDatabase(query = "") {
    return searchInternetArchive(query);
  }

  async function searchInternetArchive(query = "") {
    const statusEl = $("#archiveSearchStatus");
    const gridEl = $("#archiveSearchResults");
    if (!gridEl) return;

    if (statusEl) statusEl.textContent = "Searching Archive Feature Films and Prelinger titles...";
    gridEl.innerHTML = '<p class="hint" style="grid-column:1/-1;text-align:center;padding:20px;">Searching archive.org database...</p>';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const q = query.trim().slice(0, 120);
      const params = new URLSearchParams();
      params.set("q", `mediatype:movies AND (collection:feature_films OR collection:prelinger) AND (licenseurl:*creativecommons.org* OR licenseurl:*publicdomain*) AND title:(${q})`);
      ["identifier", "title", "year", "downloads", "licenseurl", "collection"].forEach((field) => params.append("fl[]", field));
      params.set("sort[]", "downloads desc");
      params.set("rows", "12");
      params.set("page", "1");
      params.set("output", "json");

      const res = await fetch(`https://archive.org/advancedsearch.php?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      const docs = data?.response?.docs || [];

      gridEl.innerHTML = "";
      const allowedCollections = new Set(["feature_films", "prelinger"]);
      const candidates = docs.filter((doc) =>
        doc.identifier &&
        doc.licenseurl &&
        Array.isArray(doc.collection) &&
        doc.collection.some((collection) => allowedCollections.has(collection)) &&
        !/(?:bdrip|brrip|dvdrip|hdrip|webrip|web[- .]?dl|blu[- .]?ray|remux|x26[45]|1080p|720p|2160p|torrent|katmovie|8xflix|orgmovies)/i.test(doc.title || "")
      );

      const ripMarkers = [
        "bdrip", "brrip", "dvdrip", "hdrip", "webrip", "web-dl", "web dl",
        "bluray", "blu-ray", "remux", "x264", "x265", "1080p", "720p", "2160p",
        "torrent", "katmovie", "8xflix", "orgmovies",
      ];
      const safeCandidates = candidates.filter((doc) =>
        !ripMarkers.some((marker) => (doc.title || "").toLowerCase().includes(marker))
      );
      const fullLengthDocs = (await Promise.all(safeCandidates.map(async (doc) => {
        try {
          const metadataResponse = await fetch(
            `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`,
            { signal: controller.signal }
          );
          if (!metadataResponse.ok) return null;
          const metadata = await metadataResponse.json();
          const videoFiles = (metadata.files || [])
            .filter((file) => /\.(mp4|webm|ogv|ogg)$/i.test(file.name || ""));
          if (videoFiles.some((file) =>
            ripMarkers.some((marker) => (file.name || "").toLowerCase().includes(marker))
          )) return null;
          const ripPattern = /\b(?:bdrip|brrip|dvdrip|hdrip|webrip|web[- .]?dl|blu[- .]?ray|remux|x26[45]|1080p|720p|2160p|torrent|katmovie|8xflix|orgmovies)/i;
          if (videoFiles.some((file) => ripPattern.test(file.name || ""))) return null;
          const durations = [metadata.metadata?.runtime, ...videoFiles.map((file) => file.length)]
            .map(archiveDurationSeconds);
          const durationSeconds = Math.max(0, ...durations);
          return durationSeconds >= 3600 ? { ...doc, durationSeconds } : null;
        } catch (error) {
          if (error.name === "AbortError") throw error;
          return null;
        }
      }))).filter(Boolean);
      clearTimeout(timeoutId);

      if (!fullLengthDocs.length) {
        if (statusEl) statusEl.textContent = "No full-length titles found in the selected Archive collections.";
        gridEl.textContent = "No rights-marked movie of 60 minutes or more matched. Latest commercial releases are not included.";
        return;
      }

      if (statusEl) statusEl.textContent = `Found ${fullLengthDocs.length} Archive records with video files at least 60 minutes long. Rights labels come from Archive metadata; review each item record.`;

      fullLengthDocs.forEach((doc) => {
        const card = document.createElement("div");
        card.className = "archive-movie-card";

        const img = document.createElement("img");
        img.src = `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`;
        img.alt = doc.title || "Movie Poster";
        img.loading = "lazy";
        img.style.cssText = "width:100%;height:120px;object-fit:cover;border-radius:6px;margin-bottom:6px;background:rgba(0,0,0,0.3);";
        img.onerror = () => { img.style.display = "none"; };

        const titleDiv = document.createElement("div");
        titleDiv.className = "archive-movie-title";
        titleDiv.textContent = doc.title || doc.identifier;

        const metaDiv = document.createElement("div");
        metaDiv.className = "archive-movie-meta";
        const rights = /publicdomain/i.test(doc.licenseurl) ? "Public domain marker" : "Creative Commons marker";
        const runtimeMinutes = Math.round(doc.durationSeconds / 60);
        metaDiv.textContent = `${doc.year || "Classic"} · ${runtimeMinutes} min · ${rights}`;

        const playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.className = "btn sm";
        playBtn.style.cssText = "width:100%;margin-top:6px;background:var(--accent, #ff8fab);color:#121826;font-weight:bold;";
        playBtn.textContent = "▶ Watch together";
        playBtn.onclick = () => streamArchiveMovie(doc.identifier, doc.title || doc.identifier);

        card.appendChild(img);
        card.appendChild(titleDiv);
        card.appendChild(metaDiv);
        card.appendChild(playBtn);
        gridEl.appendChild(card);
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (statusEl) statusEl.textContent = err.name === "AbortError"
        ? "Internet Archive search timed out. Please try again."
        : "Unable to reach Internet Archive. Check the connection and retry.";
      gridEl.replaceChildren();
    }
  }

  function archiveDurationSeconds(value) {
    const parts = String(value || "").split(":").map(Number);
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
    return parts.reduce((duration, part) => duration * 60 + part, 0);
  }

  async function streamArchiveMovie(identifier, title) {
    const statusEl = $("#archiveSearchStatus");
    if (statusEl) statusEl.textContent = `Loading the Internet Archive player for "${title}"...`;

    try {
      const embedUrl = `https://archive.org/embed/${encodeURIComponent(identifier)}`;

      FilmTV.openStage();
      const dataRes = await api("/api/filmtv/source", {
        method: "POST",
        body: JSON.stringify({ source: embedUrl, source_type: "url", title: title || undefined }),
      });
      if (dataRes?.state) {
        await FilmTV.loadState(dataRes.state, state.memberId);
      }
      document.querySelector(".filmtv-player-wrap")?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      if (statusEl) statusEl.textContent = `Archive player loaded for "${title}". Press Play; Archive playback controls are not synchronized between partners.`;
    } catch (err) {
      if (statusEl) statusEl.textContent = `Could not load the Archive player: ${err.message}`;
    }
  }

  let rtcPeerConnection = null;
  let rtcLocalStream = null;

  const rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  };

  async function startScreenShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      alert("Screen sharing is not supported in this browser environment.");
      return;
    }

    try {
      try {
        rtcLocalStream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: "always" },
          audio: true
        });
      } catch {
        rtcLocalStream = await navigator.mediaDevices.getDisplayMedia({
          video: true
        });
      }

      FilmTV.openStage();
      const videoEl = $("#filmtvVideo");
      const iframeContainer = $("#filmtvIframeContainer");
      const empty = $("#filmtvEmpty");
      if (empty) empty.style.display = "none";
      if (iframeContainer) iframeContainer.style.display = "none";
      if (videoEl) {
        videoEl.srcObject = rtcLocalStream;
        videoEl.style.display = "block";
        videoEl.play().catch(() => {});
      }

      if (rtcPeerConnection) rtcPeerConnection.close();
      rtcPeerConnection = new RTCPeerConnection(rtcConfig);

      rtcLocalStream.getTracks().forEach((track) => {
        rtcPeerConnection.addTrack(track, rtcLocalStream);
      });

      rtcPeerConnection.onicecandidate = (e) => {
        if (e.candidate && state.socket) {
          state.socket.emit("webrtc_ice_candidate", { candidate: e.candidate });
        }
      };

      const offer = await rtcPeerConnection.createOffer();
      await rtcPeerConnection.setLocalDescription(offer);

      if (state.socket) {
        state.socket.emit("webrtc_offer", { sdp: rtcPeerConnection.localDescription });
      }

      const videoTrack = rtcLocalStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => stopScreenShare();
      }

      const btn = $("#btnShareScreen");
      if (btn) {
        btn.textContent = "🛑 Stop Sharing";
        btn.onclick = stopScreenShare;
      }
    } catch (err) {
      if (err.name !== "NotAllowedError") {
        alert(`Screen share error: ${err.message}`);
      }
    }
  }

  function stopScreenShare() {
    if (rtcLocalStream) {
      rtcLocalStream.getTracks().forEach((t) => t.stop());
      rtcLocalStream = null;
    }
    if (rtcPeerConnection) {
      rtcPeerConnection.close();
      rtcPeerConnection = null;
    }
    if (state.socket) {
      state.socket.emit("webrtc_stop_screen");
    }
    const videoEl = $("#filmtvVideo");
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.style.display = "none";
    }
    const empty = $("#filmtvEmpty");
    if (empty) empty.style.display = "flex";

    const btn = $("#btnShareScreen");
    if (btn) {
      btn.textContent = "🖥️ Share Screen / Tab";
      btn.onclick = startScreenShare;
    }
  }

  function bindUI() {
    $("#btnShareScreen")?.addEventListener("click", startScreenShare);
    $("#loginForm")?.addEventListener("submit", loginRoom);

    $("#btnSend")?.addEventListener("click", sendText);

    $("#composerInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendText();
      }
      if (state.socket) {
        state.socket.emit("typing", { token: state.token, typing: true });
        clearTimeout(state._typingTimer);
        state._typingTimer = setTimeout(() => {
          state.socket.emit("typing", { token: state.token, typing: false });
        }, 1200);
      }
    });

    $("#ttlSelect")?.addEventListener("change", (e) => {
      state.ttlSeconds = Number(e.target.value) || 0;
    });

    $("#photoInput")?.addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (f) {
        try {
          await sendPhoto(f);
        } catch (err) {
          alert(err.message);
        }
      }
      e.target.value = "";
    });

    $("#btnVoice")?.addEventListener("click", () =>
      toggleVoice().catch((e) => alert(e.message || "Mic permission needed"))
    );

    $("#btnToggleFloatingChat")?.addEventListener("click", () => {
      const overlay = $("#fullscreenChatOverlay");
      if (overlay) overlay.classList.toggle("hidden");
    });

    $("#btnCloseFullscreenChat")?.addEventListener("click", () => {
      $("#fullscreenChatOverlay")?.classList.add("hidden");
    });

    const sendFsChat = async () => {
      const input = $("#fullscreenChatInput");
      const text = input ? input.value.trim() : "";
      if (!text || !state.key) return;
      input.value = "";
      const cipher = await CryptoClient.encryptText(state.key, text);
      await sendMessage(cipher);
    };

    $("#btnSendFullscreenChat")?.addEventListener("click", sendFsChat);
    $("#fullscreenChatInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendFsChat();
      }
    });



    $("#btnEnableNotifications")?.addEventListener("click", () => {
      requestNotificationPermissions(false);
    });

    $("#btnCancelQuotedReply")?.addEventListener("click", clearQuotedReply);

    $("#btnEmojiToggle")?.addEventListener("click", () => {
      const popover = $("#emojiPickerPopover");
      if (popover) popover.classList.toggle("hidden");
    });

    $$(".emoji-opt").forEach((el) => {
      el.addEventListener("click", () => {
        const input = $("#composerInput");
        if (input) {
          input.value += el.textContent;
          input.focus();
        }
        $("#emojiPickerPopover")?.classList.add("hidden");
      });
    });

    $("#avatarFileInput")?.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/profile/avatar", {
          method: "POST",
          headers: { "X-Session-Token": state.token },
          body: fd,
        });
        const data = await res.json();
        if (data.ok && data.avatar_url) {
          const preview = $("#settingsAvatarPreview");
          const headerAvatar = $("#partnerAvatarHeader");
          if (preview) preview.src = `${data.avatar_url}?v=${Date.now()}`;
          if (headerAvatar) headerAvatar.src = `${data.avatar_url}?v=${Date.now()}`;
          alert("Profile picture updated!");
        } else {
          alert(data.error || "Failed to upload avatar");
        }
      } catch (err) {
        alert(err.message);
      }
    });

    $("#btnSaveRoomName")?.addEventListener("click", async () => {
      const input = $("#settingsRoomName");
      const name = input ? input.value.trim() : "";
      if (!name) return;
      try {
        const data = await api("/api/auth/room/name", {
          method: "POST",
          body: JSON.stringify({ room_name: name }),
        });
        if (data.ok && data.room_name) {
          if ($("#roomLabel")) $("#roomLabel").textContent = data.room_name;
          alert("Room title updated!");
        }
      } catch (err) {
        alert(err.message);
      }
    });

    $("#waNotificationBanner")?.addEventListener("click", () => {
      $("#waNotificationBanner")?.classList.remove("show");
      window.focus();
    });

    $("#btnHeaderMenu")?.addEventListener("click", (e) => {
      e.stopPropagation();
      $("#headerDropdownMenu")?.classList.toggle("hidden");
    });
    document.addEventListener("click", () => {
      $("#headerDropdownMenu")?.classList.add("hidden");
    });

    $("#btnSettings")?.addEventListener("click", () => {
      $("#headerDropdownMenu")?.classList.add("hidden");
      const settingsName = $("#settingsName");
      if (settingsName) settingsName.value = state.displayName || "";
      openModal("settingsModal");
    });

    $("#btnWatchParty")?.addEventListener("click", () => {
      $("#headerDropdownMenu")?.classList.add("hidden");
      if (document.body.classList.contains("filmtv-open")) closeFilmTV();
      else openFilmTV();
    });

    $("#btnSpotify")?.addEventListener("click", () => {
      $("#headerDropdownMenu")?.classList.add("hidden");
      openModal("spotifyModal");
      initSpotifyPlayer();
    });

    $("#btnStudyTimer")?.addEventListener("click", () => {
      $("#headerDropdownMenu")?.classList.add("hidden");
      openModal("studyTimerModal");
      initStudyTimer();
    });

    $("#btnDocWorkspace")?.addEventListener("click", () => {
      $("#headerDropdownMenu")?.classList.add("hidden");
      openModal("docWorkspaceModal");
      initDocWorkspace();
    });

    $("#btnGifSticker")?.addEventListener("click", () => {
      openModal("gifStickerModal");
      initRichMediaPicker();
    });
    $("#btnTheme")?.addEventListener("click", () => {
      $("#headerDropdownMenu")?.classList.add("hidden");
      openModal("themeModal");
    });
    $("#btnDoodle")?.addEventListener("click", () => {
      $("#headerDropdownMenu")?.classList.add("hidden");
      openModal("doodleModal");
    });
    $("#btnLogoutTop")?.addEventListener("click", () => {
      $("#headerDropdownMenu")?.classList.add("hidden");
    });
    $("#btnIg")?.addEventListener("click", () => openModal("igModal"));
    $("#btnGallery")?.addEventListener("click", () => {
      openModal("galleryModal");
      loadGallery();
    });

    $("#btnFilmTV")?.addEventListener("click", () => {
      if (document.body.classList.contains("filmtv-open")) closeFilmTV();
      else openFilmTV();
    });
    $("#btnFilmTVClose")?.addEventListener("click", closeFilmTV);
    $("#btnTheater")?.addEventListener("click", () => FilmTV.toggleTheater());
    $("#btnFilmTVFullscreen")?.addEventListener("click", () =>
      FilmTV.toggleFullscreen().catch((e) => setFilmTVError(e.message))
    );
    $("#btnFilmTVMessages")?.addEventListener("click", () => FilmTV.toggleMessages());
    $("#btnFilmTVLoad")?.addEventListener("click", () => loadFilmTVUrl());

    $("#archiveSearchForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = $("#archiveSearchInput")?.value.trim();
      if (!query) return;
      const button = event.currentTarget.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      searchMovieDatabase(query).finally(() => {
        if (button) button.disabled = false;
      });
    });

    $("#filmtvSearchForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = $("#filmtvSearchInput")?.value.trim();
      const status = $("#filmtvSearchStatus");
      if (!query) {
        if (status) status.textContent = "Enter something to search.";
        return;
      }
      const searchUrl = googleSearchUrl(query);
      window.open(searchUrl.href, "_blank", "noopener,noreferrer");
      state.socket?.emit("filmtv_search", { query });
      const partnerButton = $("#btnFilmTVPartnerSearch");
      if (partnerButton) partnerButton.hidden = true;
      if (status) status.textContent = "Google opened in a new tab; your search was shared with your partner.";
    });
    $$('[data-watch-provider]').forEach((button) => {
      button.addEventListener("click", () => {
        const provider = button.dataset.watchProvider;
        const url = WATCH_PROVIDER_URLS[provider];
        if (!url) return;
        window.open(url, "_blank", "noopener,noreferrer");
        state.socket?.emit("filmtv_provider_launch", { provider });
        const partnerButton = $("#btnFilmTVPartnerProvider");
        if (partnerButton) partnerButton.hidden = true;
        const status = $("#filmtvSearchStatus");
        if (status) status.textContent = `${WATCH_PROVIDER_NAMES[provider]} opened. Your partner was notified; both viewers need service access and must join the same party there.`;
      });
    });
    $("#btnFilmTVPartnerProvider")?.addEventListener("click", (event) => {
      const provider = event.currentTarget.dataset.provider;
      const url = WATCH_PROVIDER_URLS[provider];
      if (!url) return;
      window.open(url, "_blank", "noopener,noreferrer");
      event.currentTarget.hidden = true;
    });
    $("#btnFilmTVPartnerSearch")?.addEventListener("click", (event) => {
      const query = event.currentTarget.dataset.query;
      if (!query) return;
      const searchUrl = googleSearchUrl(query);
      window.open(searchUrl.href, "_blank", "noopener,noreferrer");
    });
    $("#btnFilmTVAutoOpenSearch")?.addEventListener("click", (event) => {
      const button = event.currentTarget;
      const status = $("#filmtvSearchStatus");
      if (partnerLaunchWindow && !partnerLaunchWindow.closed) {
        partnerLaunchWindow.close();
        partnerLaunchWindow = null;
        button.textContent = "Enable auto-open";
        button.setAttribute("aria-pressed", "false");
        if (status) status.textContent = "Automatic partner search opening is off.";
        return;
      }

      partnerLaunchWindow = window.open("about:blank", "sathiPartnerLaunch");
      if (!partnerLaunchWindow) {
        if (status) status.textContent = "Popup blocked. Allow this site to open a tab, then enable auto-open again.";
        return;
      }
      button.textContent = "Disable auto-open";
      button.setAttribute("aria-pressed", "true");
      if (status) status.textContent = "Enabled. Partner searches and app links can open in this tab. Page clicks are not shared.";
    });

    $("#filmtvUrl")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        loadFilmTVUrl();
      }
    });
    $("#filmtvFile")?.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadFilmTV(f);
    });
    $("#filmtvFileEmpty")?.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadFilmTV(f);
    });
    $("#btnFilmTVClear")?.addEventListener("click", () => clearFilmTV());
    $$("[data-close]").forEach((b) =>
      b.addEventListener("click", () => closeModal(b.dataset.close))
    );

    $("#btnSaveName")?.addEventListener("click", () =>
      updateDisplayName().catch((e) => alert(e.message))
    );

    const onLogout = () => logout().catch((e) => alert(e.message || "Logout failed"));
    $("#btnLogout")?.addEventListener("click", onLogout);
    $("#btnLogoutTop")?.addEventListener("click", onLogout);
    $$(".theme-swatch").forEach((el) => {
      el.addEventListener("click", () => saveTheme(el.dataset.theme).catch((e) => alert(e.message)));
    });

    $("#themeFile")?.addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (f) await uploadTheme(f).catch((err) => alert(err.message));
    });

    $("#btnThemeSearch")?.addEventListener("click", () => searchTheme());
    $("#themeSearchInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") searchTheme();
    });

    $("#themeOpacity")?.addEventListener("input", (e) => {
      const val = e.target.value;
      const valEl = $("#themeOpacityVal");
      if (valEl) valEl.textContent = val + "%";
      document.documentElement.style.setProperty("--overlay-opacity", val / 100);
    });

    $("#btnIgSync")?.addEventListener("click", () => syncInstagram().catch((e) => alert(e.message)));
    $("#btnIgSaveSession")?.addEventListener("click", () => saveIgSession().catch((e) => alert(e.message)));
    $("#btnIgLoadSession")?.addEventListener("click", () => loadIgSession().catch((e) => alert(e.message)));

    $("#doodleColor")?.addEventListener("input", (e) => DoodleBoard.setColor(e.target.value));
    $("#doodleWidth")?.addEventListener("input", (e) => DoodleBoard.setWidth(e.target.value));
    $("#btnDoodlePen")?.addEventListener("click", () => DoodleBoard.setTool("pen"));
    $("#btnDoodleEraser")?.addEventListener("click", () => DoodleBoard.setTool("eraser"));
    $("#btnDoodleClear")?.addEventListener("click", () => {
      DoodleBoard.clear();
      if (state.socket) state.socket.emit("doodle_clear", { token: state.token });
    });
    $("#btnDoodleSave")?.addEventListener("click", () => saveDoodle().catch((e) => alert(e.message)));

    DoodleBoard.init($("#doodleCanvas"), (stroke) => {
      if (state.socket) {
        state.socket.emit("doodle_stroke", {
          token: state.token,
          points: { from: stroke.from, to: stroke.to },
          color: stroke.color,
          width: stroke.width,
          tool: stroke.tool,
        });
      }
    });

    window.addEventListener("online", () => {
      $("#offlineBanner")?.classList.remove("show");
      flushOutbox();
      loadMessages();
    });
    window.addEventListener("offline", () => $("#offlineBanner")?.classList.add("show"));

    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-export]")) {
        e.preventDefault();
        alert("Chat history export is permanently disabled for privacy.");
      }
    });
  }

  async function tryRestore() {
    const s = OfflineStore.getSession();
    if (!s || !s.token) return;
    try {
      const res = await fetch("/api/auth/session-check", {
        headers: { "X-Session-Token": s.token },
        credentials: "include"
      });
      if (!res.ok) {
        OfflineStore.clearSession();
        return;
      }

      const data = await res.json();
      if (!data.authenticated) {
        OfflineStore.clearSession();
        return;
      }
      if ($("#phoneNumber")) {
        $("#phoneNumber").value = data.phone_number || data.email || "";
      }
    } catch {
      // Keep the login form available when the network is offline.
    }
  }

  function init() {
    window.AppSendMessage = (text) => {
      if (text && state.key) {
        const cipher = encryptText(text, state.key);
        sendMessage(cipher).catch((e) => alert(e.message));
      }
    };

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/static/sw.js").catch((e) => {
        console.warn("ServiceWorker registration failed:", e);
      });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (state.socket && !state.socket.connected) {
          state.socket.connect();
        }
        flushOutbox();
        loadMessages();
        if (state.socket && state.socket.connected) {
          state.socket.emit("read_receipt");
        }
      }
    });

    if ("Notification" in window && Notification.permission !== "granted") {
      try { Notification.requestPermission(); } catch (e) { }
    }

    const savedSession = JSON.parse(localStorage.getItem("sathi_user_session") || "null");
    if (savedSession && savedSession.isLoggedIn) {
      if ($("#phoneNumber") && savedSession.contact) $("#phoneNumber").value = savedSession.contact;
      if ($("#emailAddress") && savedSession.email) $("#emailAddress").value = savedSession.email;
      if ($("#roomName") && savedSession.room) $("#roomName").value = savedSession.room;
      if ($("#roomPassword") && savedSession.password) $("#roomPassword").value = savedSession.password;
    }

    const widget = document.getElementById("floating-widget") || document.querySelector(".floating-window") || document.getElementById("floatingWidgetOverlay");
    if (widget) {
      widget.style.display = "block";
      widget.onclick = (e) => {
        if (e.target && e.target.closest && e.target.closest("input, button, canvas")) return;
        widget.classList.toggle("expanded");
      };
    }

    PrivacyGuard.init();
    bindUI();
    initFilmTV();
    initZoom();
    tryRestore();
  }

  // ─── Synced Modules Implementation ───
  let timerState = { timeLeft: 25 * 60, totalTime: 25 * 60, interval: null, mode: "work", isRunning: false };
  const TRACK_URLS = {
    lofi: "https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3",
    rain: "https://cdn.pixabay.com/download/audio/2021/08/09/audio_8844888716.mp3",
    forest: "https://cdn.pixabay.com/download/audio/2022/03/15/audio_c8c8a73213.mp3"
  };

  function initStudyTimer() {
    const digits = $("#timerDigits");
    const progressRing = $("#timerProgressRing");
    const modeBtns = $$(".timer-mode-btn");

    function updateDisplay() {
      const m = Math.floor(timerState.timeLeft / 60);
      const s = timerState.timeLeft % 60;
      if (digits) digits.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      if (progressRing) {
        const percent = timerState.timeLeft / (timerState.totalTime || 1);
        progressRing.style.strokeDashoffset = 276.46 * (1 - percent);
      }
    }

    modeBtns.forEach((btn) => {
      btn.onclick = () => {
        modeBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const mode = btn.dataset.mode;
        timerState.mode = mode;
        if (mode === "work") timerState.timeLeft = timerState.totalTime = 25 * 60;
        else if (mode === "short") timerState.timeLeft = timerState.totalTime = 5 * 60;
        else if (mode === "long") timerState.timeLeft = timerState.totalTime = 15 * 60;
        updateDisplay();
        state.socket?.emit("timer_sync", { action: "set_mode", mode, time_left: timerState.timeLeft });
      };
    });

    $("#btnTimerStart")?.addEventListener("click", () => {
      if (timerState.isRunning) return;
      timerState.isRunning = true;
      if ($("#timerStatusBadge")) $("#timerStatusBadge").textContent = "Status: Focusing 🎯";
      timerState.interval = setInterval(() => {
        if (timerState.timeLeft > 0) { timerState.timeLeft--; updateDisplay(); }
        else { clearInterval(timerState.interval); timerState.isRunning = false; }
      }, 1000);
      state.socket?.emit("timer_sync", { action: "start", time_left: timerState.timeLeft, mode: timerState.mode });
    });

    $("#btnTimerPause")?.addEventListener("click", () => {
      if (!timerState.isRunning) return;
      clearInterval(timerState.interval);
      timerState.isRunning = false;
      if ($("#timerStatusBadge")) $("#timerStatusBadge").textContent = "Status: Paused ⏸";
      state.socket?.emit("timer_sync", { action: "pause", time_left: timerState.timeLeft, mode: timerState.mode });
    });

    $("#btnTimerReset")?.addEventListener("click", () => {
      clearInterval(timerState.interval);
      timerState.isRunning = false;
      if (timerState.mode === "work") timerState.timeLeft = timerState.totalTime = 25 * 60;
      else if (timerState.mode === "short") timerState.timeLeft = timerState.totalTime = 5 * 60;
      else if (timerState.mode === "long") timerState.timeLeft = timerState.totalTime = 15 * 60;
      updateDisplay();
      if ($("#timerStatusBadge")) $("#timerStatusBadge").textContent = "Status: Ready";
      state.socket?.emit("timer_sync", { action: "reset", time_left: timerState.timeLeft, mode: timerState.mode });
    });

    $("#btnSetCustomMins")?.addEventListener("click", () => {
      const mins = parseInt($("#customMinsInput")?.value || "25", 10);
      if (isNaN(mins) || mins <= 0) return;
      if (timerState.interval) clearInterval(timerState.interval);
      timerState.isRunning = false;
      timerState.totalTime = timerState.timeLeft = mins * 60;
      updateDisplay();
      if ($("#timerStatusBadge")) $("#timerStatusBadge").textContent = `Status: Set to ${mins}m`;
      state.socket?.emit("timer_sync", { action: "set_mode", time_left: timerState.timeLeft });
    });

    $$("#aestheticTemplateRow .tpl-btn").forEach((btn) => {
      btn.onclick = () => {
        $$("#aestheticTemplateRow .tpl-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const theme = btn.dataset.theme;
        const box = $("#studyTimerDisplayContainer");
        if (box) box.className = `aesthetic-timer-box style-${theme} font-garamond glow-on`;
      };
    });

    const audio = $("#syncedStudyAudio");
    $("#btnMusicToggle")?.addEventListener("click", () => {
      if (!audio) return;
      if (audio.paused) {
        const track = $("#musicTrackSelect")?.value || "lofi";
        audio.src = TRACK_URLS[track] || TRACK_URLS.lofi;
        audio.play().then(() => {
          $("#btnMusicToggle").textContent = "⏸ Pause Music";
        }).catch((e) => {
          console.warn("Audio play issue, retrying:", e);
          audio.play().catch(() => {});
        });
        state.socket?.emit("music_sync", { action: "play", track_id: track });
      } else {
        audio.pause();
        $("#btnMusicToggle").textContent = "🎵 Play Music";
        state.socket?.emit("music_sync", { action: "pause" });
      }
    });

    $("#musicVolumeSlider")?.addEventListener("input", (e) => {
      if (audio) audio.volume = parseFloat(e.target.value);
    });

    updateDisplay();
  }

  function handleRemoteTimerSync(payload) {
    if (!payload || !payload.action) return;
    const digits = $("#timerDigits");
    if (payload.action === "start") {
      if (timerState.interval) clearInterval(timerState.interval);
      timerState.isRunning = true;
      if (payload.time_left !== undefined) timerState.timeLeft = payload.time_left;
      if ($("#timerStatusBadge")) $("#timerStatusBadge").textContent = "Status: Partner Focusing 🎯";
      timerState.interval = setInterval(() => {
        if (timerState.timeLeft > 0) {
          timerState.timeLeft--;
          const m = Math.floor(timerState.timeLeft / 60);
          const s = timerState.timeLeft % 60;
          if (digits) digits.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }
      }, 1000);
    } else if (payload.action === "pause") {
      clearInterval(timerState.interval);
      timerState.isRunning = false;
      if ($("#timerStatusBadge")) $("#timerStatusBadge").textContent = "Status: Partner Paused ⏸";
    } else if (payload.action === "reset" || payload.action === "set_mode") {
      clearInterval(timerState.interval);
      timerState.isRunning = false;
      if (payload.time_left !== undefined) timerState.timeLeft = payload.time_left;
      const m = Math.floor(timerState.timeLeft / 60);
      const s = timerState.timeLeft % 60;
      if (digits) digits.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
  }

  function handleRemoteMusicSync(payload) {
    if (!payload || !payload.action) return;
    const audio = $("#syncedStudyAudio");
    if (!audio) return;
    if (payload.action === "play") {
      const track = payload.track_id || "lofi";
      audio.src = TRACK_URLS[track] || TRACK_URLS.lofi;
      audio.play().catch(() => {});
      if ($("#btnMusicToggle")) $("#btnMusicToggle").textContent = "⏸ Pause Music";
    } else if (payload.action === "pause") {
      audio.pause();
      if ($("#btnMusicToggle")) $("#btnMusicToggle").textContent = "🎵 Music";
    }
  }

  function initDocWorkspace() {
    const fileInput = $("#docWorkspaceFileInput");
    fileInput?.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const body = $("#docViewerBody");
        if (body) body.textContent = evt.target.result;
        if ($("#docPageInfo")) $("#docPageInfo").textContent = file.name;
      };
      reader.readAsText(file);
    });

    $("#btnDocHighlight")?.addEventListener("click", () => {
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const color = $("#docHighlightColor")?.value || "#c9a24b";
      const span = document.createElement("mark");
      span.style.background = color;
      span.style.color = "#000";
      span.style.borderRadius = "3px";
      span.style.padding = "0 2px";
      range.surroundContents(span);
    });

    $("#btnDocUnderline")?.addEventListener("click", () => {
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const span = document.createElement("u");
      range.surroundContents(span);
    });

    $("#btnDocAddNote")?.addEventListener("click", () => {
      const noteText = $("#docNoteInput")?.value.trim();
      if (!noteText) return;
      const list = $("#docNotesList");
      if (list) {
        const item = document.createElement("div");
        item.style.background = "rgba(201,162,75,0.15)";
        item.style.borderLeft = "3px solid var(--gold,#c9a24b)";
        item.style.padding = "6px 8px";
        item.style.borderRadius = "4px";
        item.style.fontSize = "0.75rem";
        item.style.color = "#ece6d8";
        item.textContent = noteText;
        list.appendChild(item);
      }
      if ($("#docNoteInput")) $("#docNoteInput").value = "";
      state.socket?.emit("doc_annotation_sync", { action: "add_note", annotation: noteText });
    });
  }

  function initSpotifyPlayer() {
    const iframe = $("#spotifyIframe");
    const input = $("#spotifyUrlInput");
    const btnLoad = $("#btnLoadSpotifyUrl");
    const presets = $$("#spotifyPresetContainer .sp-preset");

    function parseSpotifyEmbed(url) {
      if (!url) return null;
      if (url.includes("spotify.com/embed/")) return url;
      const match = url.match(/spotify\.com\/(playlist|track|album|artist)\/([a-zA-Z0-9]+)/);
      if (match) {
        return `https://open.spotify.com/embed/${match[1]}/${match[2]}?utm_source=generator&theme=0`;
      }
      return null;
    }

    if (btnLoad && input && iframe) {
      btnLoad.onclick = () => {
        const url = input.value.trim();
        const embedUrl = parseSpotifyEmbed(url);
        if (embedUrl) {
          iframe.src = embedUrl;
          state.socket?.emit("spotify_sync", { embed_url: embedUrl });
        } else {
          alert("Invalid Spotify URL. Paste a valid Spotify track, album, or playlist link!");
        }
      };
    }

    presets.forEach((btn) => {
      btn.onclick = () => {
        presets.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const id = btn.dataset.spotifyId;
        const embedUrl = `https://open.spotify.com/embed/playlist/${id}?utm_source=generator&theme=0`;
        if (iframe) iframe.src = embedUrl;
        state.socket?.emit("spotify_sync", { embed_url: embedUrl });
      };
    });
  }

  function handleRemoteDocAnnotationSync(payload) {
    if (!payload || !payload.annotation) return;
    const list = $("#docNotesList");
    if (list) {
      const item = document.createElement("div");
      item.style.background = "rgba(0,168,225,0.15)";
      item.style.borderLeft = "3px solid #00a8e1";
      item.style.padding = "6px 8px";
      item.style.borderRadius = "4px";
      item.style.fontSize = "0.75rem";
      item.style.color = "#ece6d8";
      item.textContent = `${payload.sender_name || "Partner"}: ${payload.annotation}`;
      list.appendChild(item);
    }
  }

  function initRichMediaPicker() {
    const tabs = $$(".picker-tab");
    tabs.forEach((tab) => {
      tab.onclick = () => {
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const t = tab.dataset.tab;
        $("#pickerTab-gifs")?.classList.toggle("hidden", t !== "gifs");
        $("#pickerTab-stickers")?.classList.toggle("hidden", t !== "stickers");
        $("#pickerTab-emojis")?.classList.toggle("hidden", t !== "emojis");
      };
    });

    const emojiGrid = $("#fullEmojiGrid");
    if (emojiGrid && !emojiGrid.children.length) {
      const emojis = ["❤️", "💖", "😍", "😘", "🥰", "😊", "😂", "🤣", "😭", "🥺", "✨", "🔥", "👍", "🙏", "💯", "🎉", "👑", "🍰", "☕", "🍕", "🌸", "🌹", "🧸", "🐱", "🐶", "📚", "🎧", "🎬", "🎨", "🎮", "⭐", "💫"];
      emojis.forEach((em) => {
        const span = document.createElement("span");
        span.textContent = em;
        span.onclick = () => {
          if ($("#composerInput")) $("#composerInput").value += em;
          $("#gifStickerModal")?.classList.remove("open");
        };
        emojiGrid.appendChild(span);
      });
    }

    const stickerGrid = $("#stickerGrid");
    if (stickerGrid && !stickerGrid.children.length) {
      const stickers = [
        "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExOHp1eTZnYXB6ZndkZ29mODl5anlpcnhhM2trbHZzY3FmczNxcWVndyZlcD12MV9zdGlja2Vyc19zZWFyY2gmY3Q9cw/MDJ9IbxxvDUQM/giphy.gif",
        "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExOHp1eTZnYXB6ZndkZ29mODl5anlpcnhhM2trbHZzY3FmczNxcWVndyZlcD12MV9zdGlja2Vyc19zZWFyY2gmY3Q9cw/l41K3tOKuM6tJZuE0/giphy.gif"
      ];
      stickers.forEach((url) => {
        const img = document.createElement("img");
        img.src = url;
        img.style.width = "100%";
        img.style.borderRadius = "8px";
        img.style.cursor = "pointer";
        img.onclick = () => {
          if (window.AppSendMessage) window.AppSendMessage(`![Sticker](${url})`);
          $("#gifStickerModal")?.classList.remove("open");
        };
        stickerGrid.appendChild(img);
      });
    }

    loadGifs("Love");
    $("#btnSearchGifs")?.addEventListener("click", () => {
      const q = $("#gifSearchInput")?.value.trim() || "Love";
      loadGifs(q);
    });
    $$(".gif-tag-btn").forEach((btn) => {
      btn.onclick = () => loadGifs(btn.dataset.tag);
    });
  }

  function loadGifs(query) {
    const grid = $("#gifResultsGrid");
    if (!grid) return;
    const sampleGifs = [
      "https://media.giphy.com/media/3o7TKoWXm3okO1kgHC/giphy.gif",
      "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExOHp1eTZnYXB6ZndkZ29mODl5anlpcnhhM2trbHZzY3FmczNxcWVndyZlcD12MV9zdGlja2Vyc19zZWFyY2gmY3Q9cw/MDJ9IbxxvDUQM/giphy.gif",
      "https://media.giphy.com/media/l41K3tOKuM6tJZuE0/giphy.gif"
    ];
    grid.innerHTML = "";
    sampleGifs.forEach((url) => {
      const img = document.createElement("img");
      img.src = url;
      img.style.width = "100%";
      img.style.height = "70px";
      img.style.objectFit = "cover";
      img.style.borderRadius = "6px";
      img.style.cursor = "pointer";
      img.onclick = () => {
        if (window.AppSendMessage) window.AppSendMessage(`![GIF](${url})`);
        $("#gifStickerModal")?.classList.remove("open");
      };
      grid.appendChild(img);
    });
  }

  function handleRemoteYtSync(payload) {
    if (!payload || !payload.action) return;
    FilmTV.openStage();
  }

  function handleRemoteVideoSync(payload) {
    if (!payload || !payload.action) return;
    FilmTV.openStage();
  }

  function handleRemoteSpotifySync(payload) {
    if (!payload || !payload.embed_url) return;
    const iframe = $("#spotifyIframe");
    if (iframe) iframe.src = payload.embed_url;
    openModal("spotifyModal");
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", () => App.init());