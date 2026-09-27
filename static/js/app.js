/* global CryptoClient, OfflineStore, PrivacyGuard, DoodleBoard, FilmTV, io */

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
      credentials: "include", // Essential for maintaining session cookies with backend
      headers: { ...headers(!(opts.body instanceof FormData)), ...(opts.headers || {}) },
    });

    let data;
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok) {
      // Graceful error payload mapping instead of unhandled crash
      const errorMsg = data.error || `Request failed (${res.status})`;
      throw new Error(errorMsg);
    }
    return data;
  }



  function showAuthError(msg) {
    const el = $("#authError");
    if (el) el.textContent = msg || "";
  }

  function genRoomId() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let res = "room-";
    for (let i = 0; i < 8; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
    return res;
  }

  function validateCreate() {
    const id = $("#createRoomId")?.value.trim();
    const pw = $("#createPassword")?.value;
    const name = $("#createName")?.value.trim();
    let err = "";
    if (!id) err = "Room ID is required";
    else if (id.length < 4) err = "Room ID too short";
    else if (!pw) err = "Password is required";
    else if (pw.length < 12) err = "Password must be at least 12 characters";
    else if (!name) err = "Display name is required";
    showAuthError(err);
    return !err;
  }

  async function createRoom() {
    if (!validateCreate()) return;
    showAuthError("");
    const roomId = $("#createRoomId").value.trim();
    const password = $("#createPassword").value;
    const displayName = $("#createName").value.trim() || "Partner 1";
    try {
      const data = await fetch("/api/auth/create-room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room_id: roomId, password, display_name: displayName }),
      }).then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Create failed");
        return j;
      });
      await enterRoom(data, password);
    } catch (e) {
      showAuthError(e.message);
    }
  }

  async function joinRoom() {
    showAuthError("");
    const roomId = $("#joinRoomId").value.trim();
    const password = $("#joinPassword").value;
    const displayName = $("#joinName").value.trim() || "Partner 2";
    const saved = OfflineStore.getSession();
    const resumeToken =
      saved && saved.token && saved.roomId === roomId && saved.displayName === displayName
        ? saved.token
        : undefined;
    try {
      const payload = { room_id: roomId, password, display_name: displayName };
      if (resumeToken) payload.resume_token = resumeToken;
      const data = await fetch("/api/auth/join-room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Join failed");
        return j;
      });
      await enterRoom(data, password);
    } catch (e) {
      showAuthError(e.message);
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
    state.roomId = null;
    state.password = null;
    state.key = null;
    document.body.classList.remove("filmtv-open", "theater-mode");
    $("#chatView")?.classList.remove("active");
    $("#authView")?.classList.remove("hidden");
    closeModal("settingsModal");
  }

  async function enterRoom(data, password) {
    state.token = data.session_token;
    state.memberId = data.member_id;
    state.displayName = data.display_name;
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
    });

    $("#authView")?.classList.add("hidden");
    $("#chatView")?.classList.add("active");
    if ($("#roomLabel")) $("#roomLabel").textContent = state.roomId;
    if ($("#meLabel")) $("#meLabel").textContent = state.displayName;

    initFilmTV();
    initZoom();
    connectSocket();
    await loadMessages();
    await loadGallery();
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
      if (data.state) await FilmTV.loadState(data.state);
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
      // Removed restrictive hostname checks to allow all platforms (YouTube, etc.)
    } catch {
      setFilmTVError("Invalid URL format.");
      return;
    }
    try {
      const data = await api("/api/filmtv/load", {
        method: "POST",
        body: JSON.stringify({ url, title: title || undefined }),
      });
      if (data.ok && data.state) {
        await FilmTV.loadState(data.state, state.memberId);
        urlInput.value = "";
      }
    } catch (e) {
      setFilmTVError(e.message);
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

      if (data.ok && data.state) {
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
      await FilmTV.loadState(data.state);
      if ($("#filmtvUrl")) $("#filmtvUrl").value = "";
    } catch (e) {
      setFilmTVError(e.message);
    }
  }

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    state.socket = io({ auth: { token: state.token } });
    FilmTV.setSocket(state.socket);

    state.socket.on("new_message", (msg) => {
      renderMessage(msg);
      if (msg.media_url) loadGallery();
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
    state.socket.on("filmtv_control", (payload) => FilmTV.applyRemoteControl(payload));
    state.socket.on("filmtv_state", (payload) => {
      if (payload && payload.state) FilmTV.loadState(payload.state, state.memberId);
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

  async function renderMessage(m, scroll = true) {
    if (document.querySelector(`[data-msg-id="${m.id}"]`)) return;
    const div = document.createElement("div");
    div.className = `msg ${m.sender_id === state.memberId ? "me" : "them"}`;
    div.dataset.msgId = m.id;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = m.sender_name || "Partner";
    div.appendChild(meta);

    const plain = state.key ? await CryptoClient.decryptText(state.key, m.ciphertext) : null;
    const body = document.createElement("div");
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
    const text = input.value.trim();
    if (!text || !state.key) return;
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
        // Fallback generator if backend search route encounters any limit
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

    // Ensure sandbox has no allow-same-origin if allow-scripts is present
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
    const roomIdInput = $("#createRoomId");
    if (roomIdInput) roomIdInput.value = genRoomId();

    $("#createRoomId")?.addEventListener("input", validateCreate);
    $("#createPassword")?.addEventListener("input", validateCreate);
    $("#createName")?.addEventListener("input", validateCreate);

    $$(".tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$
          (".tabs button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const tab = btn.dataset.tab;
        const createForm = $("#createForm");
        const joinForm = $("#joinForm");
        if (createForm) createForm.style.display = tab === "create" ? "block" : "none";
        if (joinForm) joinForm.style.display = tab === "join" ? "block" : "none";
      });
    });

    $("#btnCreate")?.addEventListener("click", createRoom);
    $("#btnJoin")?.addEventListener("click", joinRoom);
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

    $("#btnSettings")?.addEventListener("click", () => {
      const settingsName = $("#settingsName");
      if (settingsName) settingsName.value = state.displayName || "";
      openModal("settingsModal");
    });

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
    $("#btnTheater")?.addEventListener("click", () => FilmTV.toggleTheater());
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
    $("#btnFilmTVClear")?.addEventListener("click", () => clearFilmTV()); $$("[data-close]").forEach((b) =>
      b.addEventListener("click", () => closeModal(b.dataset.close))
    );

    $("#btnSaveName")?.addEventListener("click", () =>
      updateDisplayName().catch((e) => alert(e.message))
    );

    const onLogout = () => logout().catch((e) => alert(e.message || "Logout failed"));
    $("#btnLogout")?.addEventListener("click", onLogout);
    $("#btnLogoutTop")?.addEventListener("click", onLogout); $$(".theme-swatch").forEach((el) => {
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
      const password = prompt("Enter room password to unlock encrypted messages:");
      if (!password) return;
      state.token = data.session_token;
      state.memberId = data.member_id;
      state.displayName = data.display_name;
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

      $("#authView")?.classList.add("hidden");
      $("#chatView")?.classList.add("active");
      if ($("#roomLabel")) $("#roomLabel").textContent = state.roomId;
      if ($("#meLabel")) $("#meLabel").textContent = state.displayName;

      initFilmTV();
      initZoom();
      connectSocket();
      await loadMessages();
      await loadGallery();
      try {
        const me = await api("/api/auth/me");
        if (me.filmtv) await FilmTV.loadState(me.filmtv, state.memberId);
      } catch {
        /* optional */
      }
    } catch {
      /* stay on auth */
    }
  }

  function init() {
    PrivacyGuard.init();
    bindUI();
    initFilmTV();
    initZoom();
    tryRestore();
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", () => App.init());