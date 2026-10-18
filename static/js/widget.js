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

  function initWidget() {
    canvas = document.getElementById("widgetCanvas");
    if (canvas) {
      ctx = canvas.getContext("2d");
      drawWidgetCanvasPlaceholder("✨ Ipsita-Sathi Sync");
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

  function drawWidgetCanvasPlaceholder(text, color = "#ff8fab") {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(18, 24, 38, 0.95)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = color;
    ctx.font = "600 14px Nunito, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  function toggleWidgetOverlay(show) {
    const overlay = document.getElementById("floatingWidgetOverlay");
    if (overlay) {
      overlay.classList.toggle("hidden", !show);
    }
  }

  function sendWidgetUpdate(text) {
    if (!text || !text.trim()) return;
    drawWidgetCanvasPlaceholder(`Partner: ${text.trim()}`);
    const preview = document.getElementById("widgetPreviewText");
    if (preview) preview.textContent = text.trim();

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
          width: 320,
          height: 220,
        });

        const style = document.createElement("style");
        style.textContent = `
          body { margin:0; padding:12px; background:#121826; color:#fff; font-family:sans-serif; display:flex; flex-direction:column; height:100vh; box-sizing:border-box; }
          .title { font-size:12px; color:#ff8fab; font-weight:bold; margin-bottom:6px; }
          .preview { flex:1; background:rgba(255,255,255,0.08); border-radius:8px; padding:10px; font-size:13px; word-break:break-word; overflow:auto; }
          .row { display:flex; gap:6px; margin-top:8px; }
          input { flex:1; padding:6px; border-radius:6px; border:1px solid #ff8fab; background:rgba(0,0,0,0.4); color:#fff; }
          button { padding:6px 12px; border-radius:6px; border:none; background:#ff8fab; color:#121826; font-weight:bold; cursor:pointer; }
        `;
        pipWindow.document.head.appendChild(style);

        const title = pipWindow.document.createElement("div");
        title.className = "title";
        title.textContent = "✨ Ipsita-Sathi Floating Home Screen";

        const preview = pipWindow.document.createElement("div");
        preview.className = "preview";
        preview.id = "pipPreviewText";
        preview.textContent = document.getElementById("widgetPreviewText")?.textContent || "Connected & Synced";

        const row = pipWindow.document.createElement("div");
        row.className = "row";
        const input = pipWindow.document.createElement("input");
        input.placeholder = "Type note...";
        const btn = pipWindow.document.createElement("button");
        btn.textContent = "Send";

        btn.onclick = () => {
          if (input.value.trim()) {
            sendWidgetUpdate(input.value.trim());
            preview.textContent = input.value.trim();
            input.value = "";
          }
        };

        row.appendChild(input);
        row.appendChild(btn);
        pipWindow.document.body.appendChild(title);
        pipWindow.document.body.appendChild(preview);
        pipWindow.document.body.appendChild(row);
      } catch (err) {
        console.warn("PiP not supported or rejected:", err);
      }
    } else {
      alert("Floating overlay enabled on app screen.");
    }
  }

  function handleIncomingWidgetSync(data) {
    if (!data) return;
    const text = data.content || "New sync update";
    drawWidgetCanvasPlaceholder(`${data.sender_name || "Partner"}: ${text}`);

    const preview = document.getElementById("widgetPreviewText");
    if (preview) preview.textContent = `${data.sender_name || "Partner"}: ${text}`;

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