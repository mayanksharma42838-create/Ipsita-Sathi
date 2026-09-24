/** Shared realtime doodle board. */
const DoodleBoard = (() => {
  let canvas, ctx, drawing = false, last = null;
  let color = "#e91e63";
  let width = 3;
  let tool = "pen";
  let emitStroke = null;

  function init(canvasEl, onStroke) {
    canvas = canvasEl;
    ctx = canvas.getContext("2d");
    emitStroke = onStroke;
    resize();
    window.addEventListener("resize", resize);

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return {
        x: ((t.clientX - r.left) / r.width) * canvas.width,
        y: ((t.clientY - r.top) / r.height) * canvas.height,
      };
    };

    const start = (e) => {
      e.preventDefault();
      drawing = true;
      last = pos(e);
    };
    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const p = pos(e);
      strokeLocal(last, p, color, width, tool);
      if (emitStroke) emitStroke({ from: last, to: p, color, width, tool });
      last = p;
    };
    const end = () => {
      drawing = false;
      last = null;
    };

    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    canvas.addEventListener("touchstart", start, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", end);
  }

  function resize() {
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const img = ctx.getImageData(0, 0, canvas.width || 1, canvas.height || 1);
    canvas.width = w * ratio;
    canvas.height = h * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    try {
      ctx.putImageData(img, 0, 0);
    } catch {
      /* ignore */
    }
  }

  function strokeLocal(from, to, c, w, t) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = w;
    if (t === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = c;
    }
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  function applyRemote(payload) {
    if (!payload || !payload.points) return;
    const { from, to } = payload.points;
    if (!from || !to) return;
    strokeLocal(from, to, payload.color, payload.width, payload.tool);
  }

  function clear() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function setColor(c) {
    color = c;
  }
  function setWidth(w) {
    width = Number(w) || 3;
  }
  function setTool(t) {
    tool = t;
  }

  function toBlob() {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  return { init, applyRemote, clear, setColor, setWidth, setTool, toBlob };
})();
