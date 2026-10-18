const PdfDocumentViewer = (() => {
    const COLORS = {
        yellow: "#ffe66d",
        green: "#8de3a0",
        blue: "#75c9ff",
        pink: "#ff91b8",
    };

    let getToken = () => null;
    let pdfDocument = null;
    let pdfLoadingTask = null;
    let pdfLoadingPromise = null;
    let source = null;
    let documentKey = null;
    let pageNumber = 1;
    let annotations = [];
    let mode = null;
    let drag = null;
    let renderTask = null;
    let renderVersion = 0;
    let openVersion = 0;
    let resizeObserver = null;
    let bound = false;

    const $ = (id) => document.getElementById(id);

    function headers(json = false) {
        const result = { "X-Session-Token": getToken() || "" };
        if (json) result["Content-Type"] = "application/json";
        return result;
    }

    function init({ tokenFn }) {
        getToken = typeof tokenFn === "function" ? tokenFn : () => null;
        if (window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        }
        if (bound) return;
        bound = true;

        $("filmtvPreviousPage")?.addEventListener("click", () => changePage(-1));
        $("filmtvNextPage")?.addEventListener("click", () => changePage(1));
        $("filmtvHighlightMode")?.addEventListener("click", () => setMode(mode === "highlight" ? null : "highlight"));
        $("filmtvUnderlineMode")?.addEventListener("click", () => setMode(mode === "underline" ? null : "underline"));
        $("filmtvClearAnnotations")?.addEventListener("click", clearAllAnnotations);
        $("filmtvAnnotationLayer")?.addEventListener("pointerdown", beginMark);
        $("filmtvAnnotationLayer")?.addEventListener("pointermove", updateMark);
        $("filmtvAnnotationLayer")?.addEventListener("pointerup", finishMark);
        $("filmtvAnnotationLayer")?.addEventListener("pointercancel", cancelMark);

        if (window.ResizeObserver) {
            resizeObserver = new ResizeObserver(() => {
                if (pdfDocument) renderPage().catch(showError);
            });
            const viewport = $("filmtvPdfViewport");
            if (viewport) resizeObserver.observe(viewport);
        }
    }

    function setVisible(visible) {
        const viewer = $("filmtvDocumentViewer");
        if (viewer) viewer.hidden = !visible;
        document.body.classList.toggle("pdf-document-open", visible);
        if (!visible) setMode(null);
    }

    function showStatus(message) {
        const status = $("filmtvPdfStatus");
        if (status) status.textContent = message || "";
    }

    function showError(error) {
        const message = error?.message || "Unable to open this PDF.";
        showStatus(message);
        console.error("[FilmTV PDF]", error);
    }

    async function open(state) {
        init({ tokenFn: getToken });
        if (!window.pdfjsLib) {
            throw new Error("PDF viewer failed to load. Check your connection and reload the room.");
        }
        setVisible(true);
        const iframeContainer = $("filmtvIframeContainer");
        if (iframeContainer) iframeContainer.style.display = "none";

        if (source === state.source && pdfDocument) return;
        if (source === state.source && pdfLoadingPromise) {
            await pdfLoadingPromise;
            return;
        }

        close(false);
        const version = ++openVersion;
        source = state.source;
        pageNumber = 1;
        showStatus("Loading PDF...");

        const url = new URL(state.stream_url || "/api/filmtv/stream", window.location.origin).href;
        pdfLoadingTask = window.pdfjsLib.getDocument({
            url,
            httpHeaders: headers(),
            withCredentials: true,
            disableRange: false,
            disableStream: false,
            rangeChunkSize: 1024 * 1024,
        });

        const loadingTask = pdfLoadingTask;
        const loadingPromise = (async () => {
            const loadedDocument = await loadingTask.promise;
            if (version !== openVersion) {
                await loadedDocument.destroy();
                return;
            }
            pdfDocument = loadedDocument;

            const response = await fetch("/api/filmtv/annotations", {
                credentials: "same-origin",
                headers: headers(),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || "Unable to load shared annotations");
            if (version !== openVersion) return;
            documentKey = data.document_key;
            annotations = Array.isArray(data.annotations) ? data.annotations : [];
            await renderPage();
            if (version === openVersion) showStatus("");
        })();
        pdfLoadingPromise = loadingPromise;

        try {
            await loadingPromise;
        } catch (error) {
            if (version === openVersion) {
                close();
                throw error;
            }
        } finally {
            if (pdfLoadingPromise === loadingPromise) pdfLoadingPromise = null;
        }
    }

    function close(hide = true) {
        openVersion += 1;
        renderVersion += 1;
        if (renderTask) {
            try {
                renderTask.cancel();
            } catch { }
        }
        renderTask = null;
        if (pdfLoadingTask) {
            pdfLoadingTask.destroy().catch(() => { });
        }
        pdfLoadingTask = null;
        pdfLoadingPromise = null;
        pdfDocument = null;
        source = null;
        documentKey = null;
        annotations = [];
        pageNumber = 1;
        drag = null;
        const canvas = $("filmtvPdfCanvas");
        const context = canvas?.getContext("2d");
        if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
        const layer = $("filmtvAnnotationLayer");
        if (layer) layer.replaceChildren();
        updatePageControls(0);
        if (hide) setVisible(false);
        showStatus("");
    }

    async function renderPage() {
        if (!pdfDocument) return;
        const version = ++renderVersion;
        if (renderTask) {
            try {
                renderTask.cancel();
            } catch { }
            renderTask = null;
        }

        const canvas = $("filmtvPdfCanvas");
        const pageContainer = $("filmtvPdfPage");
        const viewportContainer = $("filmtvPdfViewport");
        if (!canvas || !pageContainer || !viewportContainer) return;

        const page = await pdfDocument.getPage(pageNumber);
        if (version !== renderVersion) return;
        const initialViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(240, viewportContainer.clientWidth - 32);
        const scale = Math.min(2, availableWidth / initialViewport.width);
        const viewport = page.getViewport({ scale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);

        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        pageContainer.style.width = `${viewport.width}px`;
        pageContainer.style.height = `${viewport.height}px`;

        const context = canvas.getContext("2d", { alpha: false });
        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        renderTask = page.render({ canvasContext: context, viewport });
        try {
            await renderTask.promise;
        } catch (error) {
            if (error?.name !== "RenderingCancelledException") throw error;
            return;
        } finally {
            renderTask = null;
        }
        if (version !== renderVersion) return;
        updatePageControls(pdfDocument.numPages);
        renderAnnotations();
    }

    function updatePageControls(total) {
        const label = $("filmtvPageLabel");
        const previous = $("filmtvPreviousPage");
        const next = $("filmtvNextPage");
        if (label) label.textContent = `Page ${total ? pageNumber : 0} / ${total}`;
        if (previous) previous.disabled = pageNumber <= 1 || total === 0;
        if (next) next.disabled = pageNumber >= total || total === 0;
    }

    async function changePage(delta) {
        if (!pdfDocument) return;
        pageNumber = Math.max(1, Math.min(pdfDocument.numPages, pageNumber + delta));
        showStatus("Rendering page...");
        try {
            await renderPage();
            showStatus("");
        } catch (error) {
            showError(error);
        }
    }

    function setMode(nextMode) {
        mode = nextMode;
        const layer = $("filmtvAnnotationLayer");
        const highlight = $("filmtvHighlightMode");
        const underline = $("filmtvUnderlineMode");
        if (layer) layer.classList.toggle("annotating", Boolean(mode));
        if (highlight) highlight.setAttribute("aria-pressed", String(mode === "highlight"));
        if (underline) underline.setAttribute("aria-pressed", String(mode === "underline"));
    }

    function pointerPosition(event) {
        const canvas = $("filmtvPdfCanvas");
        const rect = canvas?.getBoundingClientRect();
        if (!rect?.width || !rect.height) return null;
        return {
            x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
        };
    }

    function beginMark(event) {
        if (!mode || !pdfDocument || event.button !== 0) return;
        const point = pointerPosition(event);
        if (!point) return;
        event.preventDefault();
        drag = { ...point, kind: mode, pointerId: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
        drawPreview(point);
    }

    function updateMark(event) {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const point = pointerPosition(event);
        if (point) drawPreview(point);
    }

    function drawPreview(point) {
        const layer = $("filmtvAnnotationLayer");
        if (!layer || !drag) return;
        let preview = layer.querySelector(".filmtv-document-mark.preview");
        if (!preview) {
            preview = document.createElement("div");
            preview.className = `filmtv-document-mark preview ${drag.kind}`;
            layer.appendChild(preview);
        }
        const left = Math.min(drag.x, point.x);
        const top = Math.min(drag.y, point.y);
        const width = Math.abs(point.x - drag.x);
        const height = Math.abs(point.y - drag.y);
        const color = COLORS[$("filmtvAnnotationColor")?.value] || COLORS.yellow;
        Object.assign(preview.style, {
            left: `${left * 100}%`,
            top: `${top * 100}%`,
            width: `${width * 100}%`,
            height: `${Math.max(height, 0.004) * 100}%`,
            backgroundColor: color,
            color,
        });
    }

    async function finishMark(event) {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const start = drag;
        const point = pointerPosition(event);
        cancelMark(event);
        if (!point) return;

        const x = Math.min(start.x, point.x);
        const y = Math.min(start.y, point.y);
        const width = Math.abs(point.x - start.x);
        const rawHeight = Math.abs(point.y - start.y);
        const height = Math.min(Math.max(rawHeight, 0.004), 1 - y);
        if (width < 0.003 || height < 0.003) return;

        showStatus("Saving mark...");
        try {
            const response = await fetch("/api/filmtv/annotations", {
                method: "POST",
                credentials: "same-origin",
                headers: headers(true),
                body: JSON.stringify({
                    page_number: pageNumber,
                    kind: start.kind,
                    x,
                    y,
                    width: Math.min(width, 1 - x),
                    height,
                    color: $("filmtvAnnotationColor")?.value || "yellow",
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || "Unable to save mark");
            receiveAnnotation(data.annotation);
            showStatus("");
        } catch (error) {
            showError(error);
        }
    }

    function cancelMark(event) {
        if (drag && event.pointerId !== undefined && drag.pointerId !== event.pointerId) return;
        drag = null;
        $("filmtvAnnotationLayer")?.querySelector(".preview")?.remove();
    }

    function renderAnnotations() {
        const layer = $("filmtvAnnotationLayer");
        if (!layer) return;
        layer.querySelectorAll(".filmtv-document-mark:not(.preview)").forEach((mark) => mark.remove());
        for (const annotation of annotations) {
            if (annotation.page_number !== pageNumber) continue;
            const mark = document.createElement("div");
            mark.className = `filmtv-document-mark ${annotation.kind}`;
            const color = COLORS[annotation.color] || COLORS.yellow;
            Object.assign(mark.style, {
                left: `${annotation.x * 100}%`,
                top: `${annotation.y * 100}%`,
                width: `${annotation.width * 100}%`,
                height: `${annotation.height * 100}%`,
                backgroundColor: annotation.kind === "highlight" ? color : "transparent",
                color,
            });
            mark.title = `${annotation.kind} by room member`;
            layer.appendChild(mark);
        }
    }

    function receiveAnnotation(annotation) {
        if (!annotation || annotation.document_key !== documentKey) return;
        if (annotations.some((item) => item.id === annotation.id)) return;
        annotations.push(annotation);
        if (annotation.page_number === pageNumber) renderAnnotations();
    }

    function clearRemoteAnnotations(payload) {
        if (!payload || payload.document_key !== documentKey) return;
        annotations = [];
        renderAnnotations();
    }

    async function clearAllAnnotations() {
        if (!documentKey) return;
        showStatus("Clearing marks...");
        try {
            const response = await fetch("/api/filmtv/annotations", {
                method: "DELETE",
                credentials: "same-origin",
                headers: headers(),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || "Unable to clear marks");
            annotations = [];
            renderAnnotations();
            showStatus("");
        } catch (error) {
            showError(error);
        }
    }

    return {
        init,
        open,
        close,
        receiveAnnotation,
        clearRemoteAnnotations,
    };
})();