/**
 * Home Screen Floating Extension Widget Controller
 * Supports Picture-in-Picture (PiP) and live real-time canvas / chat sync.
 */

(function () {
  "use strict";

  let pipWindow = null;
  let isWidgetEnabled = false;
  let canvas = null;
  let ctx = null;
  let isDrawing = false;
  let drawColor = "#c9a24b";

  function initWidget() {
    canvas = document.getElementById("widgetCanvas");
    if (canvas) {
      ctx = canvas.getContext("2d");
      clearWidgetCanvas();
      bindDrawingCanvas();
    }

    // Tab Switching
    document.querySelectorAll(".widget-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".widget-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const targetTab = tab.dataset.tab;
        document.querySelectorAll(".widget-tab-content").forEach((c) => c.classList.add("hidden"));
        const activeContent = document.getElementById(`widgetTab-${targetTab}`);
        if (activeContent) activeContent.classList.remove("hidden");
      });
    });

    // Color Swatches
    document.querySelectorAll(".widget-color-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".widget-color-btn").forEach((b) => b.style.border = "none");
        btn.style.border = "2px solid #fff";
        drawColor = btn.dataset.color || "#ff8fab";
      });
    });

    // Clear & Send Drawing Buttons
    const btnClearDraw = document.getElementById("btnWidgetClearDraw");
    if (btnClearDraw) btnClearDraw.addEventListener("click", clearWidgetCanvas);

    const btnSendDraw = document.getElementById("btnWidgetSendDraw");
    if (btnSendDraw) {
      btnSendDraw.addEventListener("click", sendWidgetDrawing);
    }

    // Online Photo Search
    const btnSearchPhotos = document.getElementById("btnWidgetSearchPhotos");
    const inputPhotoSearch = document.getElementById("widgetPhotoSearchInput");
    if (btnSearchPhotos && inputPhotoSearch) {
      btnSearchPhotos.addEventListener("click", () => searchOnlinePhotos(inputPhotoSearch.value));
      inputPhotoSearch.addEventListener("keydown", (e) => {
        if (e.key === "Enter") searchOnlinePhotos(inputPhotoSearch.value);
      });
    }

    const toggle = document.getElementById("toggleFloatingWidget");
    if (toggle) {
      const saved = localStorage.getItem("floating_widget_enabled") === "1";
      toggle.checked = saved;
      isWidgetEnabled = saved;
      toggleWidgetOverlay(saved);

      toggle.addEventListener("change", (e) => {
        isWidgetEnabled = e.target.checked;
        localStorage.setItem("floating_widget_enabled", isWidgetEnabled ? "1" : "0");
        toggleWidgetOverlay(isWidgetEnabled);
      });
    }

    const btnPip = document.getElementById("btnWidgetPip");
    if (btnPip) {
      btnPip.addEventListener("click", requestFloatingPipWindow);
    }

    const btnClose = document.getElementById("btnWidgetClose");
    if (btnClose) {
      btnClose.addEventListener("click", () => {
        toggleWidgetOverlay(false);
        const toggle = document.getElementById("toggleFloatingWidget");
        if (toggle) toggle.checked = false;
        localStorage.setItem("floating_widget_enabled", "0");
      });
    }

    const btnSend = document.getElementById("btnWidgetSend");
    const input = document.getElementById("widgetInput");
    if (btnSend && input) {
      btnSend.addEventListener("click", () => {
        sendWidgetUpdate(input.value);
        input.value = "";
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          sendWidgetUpdate(input.value);
          input.value = "";
        }
      });
    }
  }

  function clearWidgetCanvas() {
    if (!ctx || !canvas) return;
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function bindDrawingCanvas() {
    if (!canvas || !ctx) return;

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    const startDraw = (e) => {
      isDrawing = true;
      const pos = getPos(e);
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    };

    const draw = (e) => {
      if (!isDrawing) return;
      e.preventDefault();
      const pos = getPos(e);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    };

    const stopDraw = () => {
      isDrawing = false;
    };

    canvas.addEventListener("mousedown", startDraw);
    canvas.addEventListener("mousemove", draw);
    canvas.addEventListener("mouseup", stopDraw);
    canvas.addEventListener("mouseleave", stopDraw);

    canvas.addEventListener("touchstart", startDraw, { passive: false });
    canvas.addEventListener("touchmove", draw, { passive: false });
    canvas.addEventListener("touchend", stopDraw);
  }

  function sendWidgetDrawing() {
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");

    if (window.AppSendMessage) {
      window.AppSendMessage(`[Drawing Sent]`);
    }

    const socket = window.appSocket || window.AppSocket;
    if (socket && socket.connected) {
      socket.emit("widget_sync", {
        type: "drawing",
        content: dataUrl,
      });
    }

    const preview = document.getElementById("widgetPreviewText");
    if (preview) preview.textContent = "🎨 Sent drawing to partner!";
  }

  async function searchOnlinePhotos(query) {
    const grid = document.getElementById("widgetPhotoResults");
    if (!grid) return;
    const q = (query || "love").trim();
    grid.innerHTML = '<div style="font-size:11px;color:#ff8fab;grid-column:1/-1;text-align:center;">Searching photos...</div>';

    try {
      const sampleQueries = [q, `${q} cute`, `${q} aesthetic`, `${q} couple`, `${q} art`, `${q} nature`];
      grid.innerHTML = "";

      sampleQueries.slice(0, 6).forEach((term, idx) => {
        const imgUrl = `https://picsum.photos/seed/${encodeURIComponent(q + idx)}/300/300`;
        const img = document.createElement("img");
        img.src = imgUrl;
        img.alt = term;
        img.style.cssText = "width:100%;height:45px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid rgba(255,143,171,0.3);";
        img.onclick = () => sendOnlinePhotoToPartner(imgUrl, term);
        grid.appendChild(img);
      });
    } catch (err) {
      grid.innerHTML = '<div style="font-size:11px;color:#ff4d4d;grid-column:1/-1;text-align:center;">Error searching photos</div>';
    }
  }

  function sendOnlinePhotoToPartner(imgUrl, term) {
    if (window.AppSendMessage) {
      window.AppSendMessage(`[Photo] ${imgUrl}`);
    }

    const socket = window.appSocket || window.AppSocket;
    if (socket && socket.connected) {
      socket.emit("widget_sync", {
        type: "photo",
        content: imgUrl,
        term: term
      });
    }

    const preview = document.getElementById("widgetPreviewText");
    if (preview) preview.textContent = `🖼️ Sent photo to partner!`;
  }

  function toggleWidgetOverlay(show) {
    const overlay = document.getElementById("floatingWidgetOverlay");
    if (overlay) {
      overlay.classList.toggle("hidden", !show);
    }
  }

  function sendWidgetUpdate(text) {
    if (!text || !text.trim()) return;
    const preview = document.getElementById("widgetPreviewText");
    if (preview) preview.textContent = text.trim();

    if (window.AppSendMessage) {
      window.AppSendMessage(text.trim());
    }

    const socket = window.appSocket || window.AppSocket;
    if (socket && socket.connected) {
      socket.emit("widget_sync", {
        type: "note",
        content: text.trim(),
      });
    }
  }

  async function requestFloatingPipWindow() {
    if ("documentPictureInPicture" in window) {
      try {
        pipWindow = await window.documentPictureInPicture.requestWindow({
          width: 360,
          height: 260,
        });

        const style = document.createElement("style");
        style.textContent = `
          body { margin:0; padding:12px; background:#0a0908; color:#efe9da; font-family:sans-serif; display:flex; flex-direction:column; height:100vh; box-sizing:border-box; border:1px solid rgba(201,162,75,0.4); border-radius:12px; }
          .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
          .title { font-size:13px; color:#ecd593; font-weight:bold; }
          .preview { flex:1; background:rgba(255,255,255,0.08); border-radius:8px; padding:10px; font-size:13px; word-break:break-word; overflow-y:auto; border:1px solid rgba(201,162,75,0.2); }
          .row { display:flex; gap:6px; margin-top:8px; }
          input { flex:1; padding:6px 10px; border-radius:6px; border:1px solid #c9a24b; background:rgba(0,0,0,0.6); color:#fff; font-size:12px; }
          button { padding:6px 12px; border-radius:6px; border:none; background:linear-gradient(135deg, #ecd593, #c9a24b); color:#0a0908; font-weight:bold; cursor:pointer; font-size:12px; }
        `;
        pipWindow.document.head.appendChild(style);

        const header = pipWindow.document.createElement("div");
        header.className = "header";
        const title = pipWindow.document.createElement("div");
        title.className = "title";
        title.textContent = "✨ Sathi Floating Sync";
        header.appendChild(title);

        const preview = pipWindow.document.createElement("div");
        preview.className = "preview";
        preview.id = "pipPreviewText";
        preview.textContent = document.getElementById("widgetPreviewText")?.textContent || "Connected & Synced";

        const row = pipWindow.document.createElement("div");
        row.className = "row";
        const input = pipWindow.document.createElement("input");
        input.placeholder = "Send quick note to partner...";
        const btn = pipWindow.document.createElement("button");
        btn.textContent = "Send";

        btn.onclick = () => {
          if (input.value.trim()) {
            sendWidgetUpdate(input.value.trim());
            preview.textContent = `Me: ${input.value.trim()}`;
            input.value = "";
          }
        };

        row.appendChild(input);
        row.appendChild(btn);
        pipWindow.document.body.appendChild(header);
        pipWindow.document.body.appendChild(preview);
        pipWindow.document.body.appendChild(row);
      } catch (err) {
        console.warn("Document PiP error, engaging fallback:", err);
        fallbackVideoPip();
      }
    } else {
      fallbackVideoPip();
    }
  }

  function fallbackVideoPip() {
    try {
      const pipCanvas = document.createElement("canvas");
      pipCanvas.width = 300;
      pipCanvas.height = 180;
      const pCtx = pipCanvas.getContext("2d");
      pCtx.fillStyle = "#0a0908";
      pCtx.fillRect(0, 0, 300, 180);
      pCtx.fillStyle = "#ecd593";
      pCtx.font = "bold 14px sans-serif";
      pCtx.fillText("✨ Sathi Floating Sync", 15, 30);
      pCtx.fillStyle = "#ffffff";
      pCtx.font = "12px sans-serif";
      const text = document.getElementById("widgetPreviewText")?.textContent || "Connected & Synced";
      pCtx.fillText(text.slice(0, 35), 15, 70);

      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = pipCanvas.captureStream(10);
      video.play();
      video.requestPictureInPicture().catch(() => {
        alert("Floating widget overlay is active on your screen.");
      });
    } catch (e) {
      alert("Floating overlay enabled on screen.");
    }
  }

  function handleIncomingWidgetSync(data) {
    if (!data) return;
    const text = data.content || "New sync update";

    const preview = document.getElementById("widgetPreviewText");
    if (preview) {
      if (data.type === "photo") {
        preview.textContent = `${data.sender_name || "Partner"} sent a photo!`;
      } else if (data.type === "drawing") {
        preview.textContent = `${data.sender_name || "Partner"} sent a drawing!`;
      } else {
        preview.textContent = `${data.sender_name || "Partner"}: ${text}`;
      }
    }

    if (pipWindow && pipWindow.document) {
      const pipPreview = pipWindow.document.getElementById("pipPreviewText");
      if (pipPreview) pipPreview.textContent = `${data.sender_name || "Partner"}: ${text}`;
    }
  }

  document.addEventListener("DOMContentLoaded", initWidget);

  window.FloatingWidget = {
    handleIncomingWidgetSync,
  };
})();