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

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

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
      } catch (e) {}
    }
  }

  function leaveRoom() {
    localStorage.removeItem("sathi_user_session");
    logout().catch(() => {});
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
                  id: "ipsita_messages",
                  name: "Ipsita-Sathi Messages",
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
                channelId: "ipsita_messages",
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

    state.socket.on("netflix_play", (payload) => {
      FilmTV.openStage();
      const netflixContainer = $("#netflixContainer");
      if (netflixContainer) netflixContainer.style.display = "block";
      const empty = $("#filmtvEmpty");
      if (empty) empty.style.display = "none";
      const statusText = $("#netflixStatusText");
      const embeddedFrame = $("#netflixEmbeddedFrame");
      if (payload && payload.url) {
        const proxyUrl = `/api/filmtv/stream_proxy?target=${encodeURIComponent(payload.url)}`;
        if (embeddedFrame && embeddedFrame.src !== proxyUrl) {
          embeddedFrame.src = proxyUrl;
        }
        if (statusText) statusText.textContent = `🍿 Co-Watching in-app: Netflix Watch Party`;
      } else if (statusText) {
        statusText.textContent = "▶️ Partner started playback";
      }
      if (window.showWaNotification && payload.sender_name) {
        window.showWaNotification(payload.sender_name, "🍿 Started Netflix Watch Party!");
      }
    });

    state.socket.on("netflix_pause", (payload) => {
      const statusText = $("#netflixStatusText");
      if (statusText) statusText.textContent = "⏸️ Partner paused playback";
      if (window.showWaNotification && payload.sender_name) {
        window.showWaNotification(payload.sender_name, "⏸️ Paused Netflix Watch Party");
      }
    });

    state.socket.on("netflix_seek", (payload) => {
      if (window.showWaNotification && payload.sender_name) {
        window.showWaNotification(payload.sender_name, `⏩ Seeked Netflix Watch Party to ${payload.position}s`);
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
    state.socket.on("filmtv_annotation_added", (annotation) => {
      PdfDocumentViewer.receiveAnnotation(annotation);
    });
    state.socket.on("filmtv_annotations_cleared", (payload) => {
      PdfDocumentViewer.clearRemoteAnnotations(payload);
    });

    state.socket.on("connect", () => {
      state.socket.emit("filmtv_request_sync", { token: state.token });
    });
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
    const res = await fetch(m.media_url, { headers: headers(false) });
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
    const res = await fetch(m.media_url, { headers: headers(false) });
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

    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-forms");
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

  function bindUI() {
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

    $("#btnSettings")?.addEventListener("click", () => {
      const settingsName = $("#settingsName");
      if (settingsName) settingsName.value = state.displayName || "";
      openModal("settingsModal");
    });

    $("#btnGames")?.addEventListener("click", () => openModal("gamesModal"));
    $("#btnTheme")?.addEventListener("click", () => openModal("themeModal"));
    $("#btnDoodle")?.addEventListener("click", () => openModal("doodleModal"));
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
    $("#btnNetflixParty")?.addEventListener("click", () => {
      FilmTV.openStage();
      const netflixContainer = $("#netflixContainer");
      const empty = $("#filmtvEmpty");
      const iframeContainer = $("#filmtvIframeContainer");
      const videoEl = $("#filmtvVideo");
      if (videoEl) videoEl.style.display = "none";
      if (iframeContainer) iframeContainer.style.display = "none";
      if (empty) empty.style.display = "none";
      if (netflixContainer) {
        const isHidden = netflixContainer.style.display === "none";
        netflixContainer.style.display = isHidden ? "block" : "none";
        if (!isHidden && empty) empty.style.display = "flex";
      }
    });

    $("#btnSyncNetflixUrl")?.addEventListener("click", () => {
      const urlInput = $("#netflixUrlInput");
      const statusText = $("#netflixStatusText");
      const embeddedFrame = $("#netflixEmbeddedFrame");
      const url = urlInput ? urlInput.value.trim() : "";
      if (!url) {
        alert("Please enter a valid Netflix watch URL (e.g. https://www.netflix.com/watch/...)");
        return;
      }
      const proxyUrl = `/api/filmtv/stream_proxy?target=${encodeURIComponent(url)}`;
      if (embeddedFrame) embeddedFrame.src = proxyUrl;
      if (statusText) statusText.textContent = `🍿 Synced In-App Watch Party`;
      if (state.socket) {
        state.socket.emit("netflix_play", { url: url, position: 0 });
      }
    });

    $("#btnNetflixPlay")?.addEventListener("click", () => {
      const urlInput = $("#netflixUrlInput");
      const url = urlInput ? urlInput.value.trim() : "";
      if (state.socket) state.socket.emit("netflix_play", { url, position: 0 });
    });

    $("#btnNetflixPause")?.addEventListener("click", () => {
      if (state.socket) state.socket.emit("netflix_pause", { position: 0 });
    });

    $("#btnTheater")?.addEventListener("click", () => FilmTV.toggleTheater());
    $("#btnFilmTVFullscreen")?.addEventListener("click", () =>
      FilmTV.toggleFullscreen().catch((e) => setFilmTVError(e.message))
    );
    $("#btnFilmTVMessages")?.addEventListener("click", () => FilmTV.toggleMessages());
    $("#btnFilmTVLoad")?.addEventListener("click", () => loadFilmTVUrl());

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
      try { Notification.requestPermission(); } catch (e) {}
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

  return { init };
})();

document.addEventListener("DOMContentLoaded", () => App.init());