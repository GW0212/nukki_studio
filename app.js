
// Option A: Real mask-based cutout editor (manual only) + Ctrl+Z/Y undo/redo + transparent PNG export.
(() => {
  const $ = (id) => document.getElementById(id);

  const uploadCard = $("uploadCard");
  const editorCard = $("editorCard");
  const dropzone = $("dropzone");
  const fileInput = $("fileInput");
  const btnPick = $("btnPick");

  const view = $("view");
  const vctx = view.getContext("2d", { willReadFrequently: true });

  // Offscreen: base + mask (white=keep, transparent=remove)
  const base = document.createElement("canvas");
  const bctx = base.getContext("2d", { willReadFrequently: true });

  const mask = document.createElement("canvas");
  const mctx = mask.getContext("2d", { willReadFrequently: true });

  // UI
  const tabErase = $("tabErase");
  const tabRestore = $("tabRestore");
  const brushSize = $("brushSize");
  const brushSizeVal = $("brushSizeVal");
  const zoomPct = $("zoomPct");

  // Brush shape buttons
  const shapeButtons = Array.from(document.querySelectorAll(".shape-btn"));
  function setBrushShape(shape){
    brushShape = shape;
    shapeButtons.forEach(btn => {
      const active = btn.dataset.shape === shape;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    draw();
  }
  shapeButtons.forEach(btn => {
    btn.addEventListener("click", () => setBrushShape(btn.dataset.shape));
    // mobile fast tap
    btn.addEventListener("pointerup", (e) => { e.preventDefault(); });
  });


  const btnUndo = $("btnUndo");
  const btnRedo = $("btnRedo");
  const btnBeforeAfter = $("btnBeforeAfter");
  const btnDone = $("btnDone");
  const btnResetTop = $("btnResetTop");

  const btnHelpTop = $("btnHelpTop");
  const helpModal = $("helpModal");
  const helpBackdrop = $("helpBackdrop");
  const btnHelpClose = $("btnHelpClose");
  const confirmOverlay = $("confirmOverlay");
  const confirmYes = $("confirmYes");
  const confirmNo = $("confirmNo");


  // State
  let img = null;
  let mode = "erase"; // erase | restore
  let drawing = false;
  let showOriginal = false;
  let lastPt = null;
  let zoom = 1.0; // 1.0 == 100% (minimum)
  let pan = {x: 0, y: 0};
  const ZOOM_MAX = 6.0;
  let panning = false;
  let panStart = {x:0,y:0};
  let pointerStart = {x:0,y:0};
  let cursor = { x: 0, y: 0, visible: false, inside: false };
  let brushShape = 'circle'; // circle | square | triangle | star

  function updateZoomLabel(){
    if (!zoomPct) return;
    zoomPct.textContent = String(Math.round(zoom * 100));
  }



  function updateCursorFromEvent(e) {
    const p = pointerPos(e);
    cursor.x = p.px;
    cursor.y = p.py;
    cursor.visible = true;
    const hit = viewToImage(p.px, p.py);
    cursor.inside = !!hit.inside;
  }
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  
  // Touch gestures (2-finger): pinch to zoom + drag to pan
  const activePointers = new Map(); // pointerId -> {px, py}
  let pinch = null; // {startDist, startZoom, startPan, startMid:{x,y}, startImg:{ix,iy}}

  function dist(a,b){
    const dx=a.px-b.px, dy=a.py-b.py;
    return Math.hypot(dx,dy);
  }
  function mid(a,b){
    return { x:(a.px+b.px)/2, y:(a.py+b.py)/2 };
  }
// Undo/redo store ImageData of mask only (fast & correct)
  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 30;

  function setMode(next) {
    mode = next;
    tabErase.classList.toggle("active", mode === "erase");
    tabRestore.classList.toggle("active", mode === "restore");
    tabErase.setAttribute("aria-selected", String(mode === "erase"));
    tabRestore.setAttribute("aria-selected", String(mode === "restore"));
  }

  function pushHistory() {
    try {
      const snap = mctx.getImageData(0, 0, mask.width, mask.height);
      undoStack.push(snap);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
      syncHistoryButtons();
    } catch (e) {
      // ignore
    }
  }

  function syncHistoryButtons() {
    btnUndo.disabled = undoStack.length === 0;
    btnRedo.disabled = redoStack.length === 0;
  }

  function undo() {
    if (!undoStack.length) return;
    const current = mctx.getImageData(0, 0, mask.width, mask.height);
    redoStack.push(current);
    const prev = undoStack.pop();
    mctx.putImageData(prev, 0, 0);
    syncHistoryButtons();
    redraw();
  }

  function redo() {
    if (!redoStack.length) return;
    const current = mctx.getImageData(0, 0, mask.width, mask.height);
    undoStack.push(current);
    const next = redoStack.pop();
    mctx.putImageData(next, 0, 0);
    syncHistoryButtons();
    redraw();
  }

  function openHelp(open) {
    helpModal.hidden = !open;
  }

  
  function openConfirmReset() {
    if (!confirmOverlay) return resetAll();
    confirmOverlay.classList.remove("hidden");
  }
  function closeConfirmReset() {
    if (!confirmOverlay) return;
    confirmOverlay.classList.add("hidden");
  }

function resetAll() {
    img = null;
    undoStack.length = 0;
    redoStack.length = 0;
    syncHistoryButtons();
    uploadCard.hidden = false;
    editorCard.hidden = true;
    fileInput.value = "";
    // clear canvases
    [view, base, mask].forEach(c => { c.width = 1; c.height = 1; });
  }

  function fitCanvasToStage() {
    const stage = $("stage");
    const rect = stage.getBoundingClientRect();
    // set view canvas pixel size to stage area for crispness
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    view.width = w;
    view.height = h;
    view.style.width = rect.width + "px";
    view.style.height = rect.height + "px";
  }

  
  function clampPan() {
    const vw = view.width, vh = view.height;
    const iw = base.width, ih = base.height;
    const fit = Math.min(vw / iw, vh / ih);
    const s = fit * zoom;
    const dw = iw * s;
    const dh = ih * s;
    const baseDx = (vw - dw) / 2;
    const baseDy = (vh - dh) / 2;

    // If zoom is at minimum (100%), lock pan to center (no drifting)
    if (zoom <= 1.0001) {
      pan.x = 0;
      pan.y = 0;
      return;
    }

    // Prevent empty space: clamp so image always covers view bounds
    const dxMin = Math.min(0, vw - dw);
    const dxMax = Math.max(0, vw - dw);
    const dyMin = Math.min(0, vh - dh);
    const dyMax = Math.max(0, vh - dh);

    const panMinX = dxMin - baseDx;
    const panMaxX = dxMax - baseDx;
    const panMinY = dyMin - baseDy;
    const panMaxY = dyMax - baseDy;

    pan.x = Math.min(panMaxX, Math.max(panMinX, pan.x));
    pan.y = Math.min(panMaxY, Math.max(panMinY, pan.y));
  }

  function getTransform() {
    const vw = view.width, vh = view.height;
    const iw = base.width, ih = base.height;
    const fit = Math.min(vw / iw, vh / ih);
    const s = fit * zoom;
    const dw = iw * s;
    const dh = ih * s;
    const baseDx = (vw - dw) / 2;
    const baseDy = (vh - dh) / 2;
    const dx = baseDx + pan.x;
    const dy = baseDy + pan.y;
    return {vw, vh, iw, ih, fit, s, dw, dh, baseDx, baseDy, dx, dy};
  }
function redraw() {
    if (!img) {
      vctx.clearRect(0, 0, view.width, view.height);
      return;
    }

    fitCanvasToStage();

    // Compute fit/zoom/pan transform
    const {vw, vh, iw, ih, s: scale, dw, dh, dx, dy} = getTransform();

    vctx.clearRect(0, 0, vw, vh);

    if (showOriginal) {
      vctx.drawImage(base, dx, dy, dw, dh);
      drawCursorOverlay(scale);
      return;
    }

    // draw cutout: base then apply mask with destination-in using an offscreen temp
    const temp = document.createElement("canvas");
    temp.width = iw;
    temp.height = ih;
    const tctx = temp.getContext("2d");

    tctx.clearRect(0, 0, iw, ih);
    tctx.drawImage(base, 0, 0);

    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(mask, 0, 0);

    vctx.drawImage(temp, dx, dy, dw, dh);
    drawCursorOverlay(scale);
  }

  function drawCursorOverlay(scale) {
    if (!cursor.visible || !cursor.inside || !img) return;

    const rImg = Number(brushSize.value);
    const r = Math.max(2 * dpr, rImg * scale);

    const x = cursor.x;
    const y = cursor.y;

    function buildPath(kind, rr) {
      vctx.beginPath();
      if (kind === "square") {
        vctx.rect(x - rr, y - rr, rr * 2, rr * 2);
      } else if (kind === "triangle") {
        const a = rr * 0.8660254038; // sqrt(3)/2
        vctx.moveTo(x, y - rr);
        vctx.lineTo(x - a, y + rr * 0.5);
        vctx.lineTo(x + a, y + rr * 0.5);
        vctx.closePath();
      } else if (kind === "star") {
        const spikes = 5;
        const outer = rr;
        const inner = rr * 0.5;
        let rot = -Math.PI / 2;
        const step = Math.PI / spikes;
        vctx.moveTo(x + Math.cos(rot) * outer, y + Math.sin(rot) * outer);
        for (let i = 0; i < spikes; i++) {
          rot += step;
          vctx.lineTo(x + Math.cos(rot) * inner, y + Math.sin(rot) * inner);
          rot += step;
          vctx.lineTo(x + Math.cos(rot) * outer, y + Math.sin(rot) * outer);
        }
        vctx.closePath();
      } else { // circle
        vctx.arc(x, y, rr, 0, Math.PI * 2);
      }
    }

    vctx.save();
    vctx.globalCompositeOperation = "source-over";

    // Outer stroke for contrast
    buildPath(brushShape, r);
    vctx.lineWidth = Math.max(1.5 * dpr, 2 * dpr);
    vctx.strokeStyle = "rgba(0,0,0,0.55)";
    vctx.stroke();

    // Inner bright stroke
    buildPath(brushShape, Math.max(0, r - 1.5 * dpr));
    vctx.lineWidth = Math.max(1 * dpr, 1.5 * dpr);
    vctx.strokeStyle = "rgba(255,255,255,0.85)";
    vctx.stroke();

    // Tiny center dot (always circle)
    vctx.beginPath();
    vctx.arc(x, y, Math.max(1.2 * dpr, 2), 0, Math.PI * 2);
    vctx.fillStyle = "rgba(255,255,255,0.9)";
    vctx.fill();

    vctx.restore();
  }


  // Convert pointer position on view canvas to image coords (base/mask coords)
  function viewToImage(x, y) {
    const {iw, ih, s: scale, dx, dy} = getTransform();
    const ix = (x - dx) / scale;
    const iy = (y - dy) / scale;
    return { ix, iy, inside: ix >= 0 && iy >= 0 && ix <= iw && iy <= ih };
  }

  function drawPoint(ix, iy) {
    stampAt(ix, iy);
  }

  // Build a brush shape path in IMAGE coordinates
  function buildMaskPath(ctx, kind, x, y, r){
    ctx.beginPath();
    if (kind === "square") {
      ctx.rect(x - r, y - r, r * 2, r * 2);
    } else if (kind === "triangle") {
      const a = r * 0.8660254038; // sqrt(3)/2
      ctx.moveTo(x, y - r);
      ctx.lineTo(x - a, y + r * 0.5);
      ctx.lineTo(x + a, y + r * 0.5);
      ctx.closePath();
    } else if (kind === "star") {
      const spikes = 5;
      const outer = r;
      const inner = r * 0.5;
      let rot = -Math.PI / 2;
      const step = Math.PI / spikes;
      ctx.moveTo(x + Math.cos(rot) * outer, y + Math.sin(rot) * outer);
      for (let i = 0; i < spikes; i++) {
        rot += step;
        ctx.lineTo(x + Math.cos(rot) * inner, y + Math.sin(rot) * inner);
        rot += step;
        ctx.lineTo(x + Math.cos(rot) * outer, y + Math.sin(rot) * outer);
      }
      ctx.closePath();
    } else { // circle
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  function stampAt(ix, iy){
    const r = Number(brushSize.value);
    mctx.save();
    if (mode === "erase") {
      mctx.globalCompositeOperation = "destination-out";
      // fillStyle is ignored for destination-out but set for safety
      mctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      mctx.globalCompositeOperation = "source-over";
      mctx.fillStyle = "#ffffff";
    }
    buildMaskPath(mctx, brushShape, ix, iy, r);
    mctx.fill();
    mctx.restore();
  }

  // Draw continuous stroke between two points (fix dotted gaps on fast drag)
  function drawStroke(x0, y0, x1, y1) {
    const r = Number(brushSize.value);
    // Circle can use a true stroke for perfectly smooth edges.
    if (brushShape === "circle") {
      if (mode === "erase") {
        mctx.save();
        mctx.globalCompositeOperation = "destination-out";
        mctx.lineCap = "round";
        mctx.lineJoin = "round";
        mctx.lineWidth = r * 2;
        mctx.beginPath();
        mctx.moveTo(x0, y0);
        mctx.lineTo(x1, y1);
        mctx.stroke();
        mctx.restore();
      } else {
        mctx.save();
        mctx.globalCompositeOperation = "source-over";
        mctx.strokeStyle = "#ffffff";
        mctx.lineCap = "round";
        mctx.lineJoin = "round";
        mctx.lineWidth = r * 2;
        mctx.beginPath();
        mctx.moveTo(x0, y0);
        mctx.lineTo(x1, y1);
        mctx.stroke();
        mctx.restore();
      }
      return;
    }

    // Non-circular brushes: stamp shape along the segment.
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 0;
    const step = Math.max(1, r * 0.55);
    const n = len > 0 ? Math.ceil(len / step) : 0;
    for (let i = 0; i <= n; i++) {
      const t = n === 0 ? 1 : (i / n);
      stampAt(x0 + dx * t, y0 + dy * t);
    }
  }

  // Pointer events
  function pointerPos(e) {
    const rect = view.getBoundingClientRect();
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    return { px, py };
  }

  function onPointerDown(e) {
    if (!img) return;
    updateCursorFromEvent(e);
    e.preventDefault();

    // Track active pointers (for touch gestures)
    const { px, py } = pointerPos(e);
    activePointers.set(e.pointerId, { px, py });

    // Two-finger gesture on touch: pinch zoom + pan
    if (e.pointerType === "touch" && activePointers.size >= 2) {
      // Stop drawing if it was started by first finger
      drawing = false;
      lastPt = null;
      panning = true;

      const pts = Array.from(activePointers.values());
      const a = pts[0], b = pts[1];
      const m = mid(a, b);

      // Image point under midpoint before gesture starts (for stable zoom anchoring)
      const t = viewToImage(m.x, m.y);
      pinch = {
        startDist: dist(a, b) || 1,
        startZoom: zoom,
        startPan: { x: pan.x, y: pan.y },
        startMid: { x: m.x, y: m.y },
        startImg: { ix: t.ix, iy: t.iy }
      };

      // Capture so we keep getting moves even if fingers drift
      try { view.setPointerCapture(e.pointerId); } catch {}
      return;
    }

    // Right-click drag: pan (desktop)
    if (e.button === 2) {
      if (zoom <= 1.0001) return; // no panning at 100%

      panning = true;
      drawing = false;
      lastPt = null;
      pointerStart = { x: e.clientX * dpr, y: e.clientY * dpr };
      panStart = { x: pan.x, y: pan.y };
      try { view.setPointerCapture(e.pointerId); } catch {}
      return;
    }

    // Left-click drag OR single-finger touch: edit (cutout)
    if (e.button !== 0 && e.pointerType !== "touch") return;

    // If this is touch, don't start drawing when already in pinch
    if (e.pointerType === "touch" && activePointers.size > 1) return;

    drawing = true;
    panning = false;
    pinch = null;
    pushHistory();

    const p = pointerPos(e);
    const hit = viewToImage(p.px, p.py);
    if (hit.inside) {
      drawPoint(hit.ix, hit.iy);
      lastPt = { x: hit.ix, y: hit.iy };
      redraw();
    }

    try { view.setPointerCapture(e.pointerId); } catch {}
  }


  function onPointerMove(e) {
    if (!img) return;
    updateCursorFromEvent(e);

    // Update pointer tracking
    if (activePointers.has(e.pointerId)) {
      const p = pointerPos(e);
      activePointers.set(e.pointerId, { px: p.px, py: p.py });
    }

    // Two-finger pinch/pan (touch)
    if (e.pointerType === "touch" && pinch && activePointers.size >= 2) {
      e.preventDefault();
      const pts = Array.from(activePointers.values());
      const a = pts[0], b = pts[1];

      const curDist = dist(a, b) || 1;
      const ratio = curDist / (pinch.startDist || 1);

      const oldZoom = zoom;
      zoom = Math.min(ZOOM_MAX, Math.max(1.0, pinch.startZoom * ratio));

      const m = mid(a, b);

      // Keep the image point under the midpoint stable while also allowing panning by moving midpoint
      // Compute transform pieces for the NEW zoom but with pan initially at pinch.startPan.
      const tNew = (() => {
        const vw = view.width, vh = view.height;
        const iw = base.width, ih = base.height;
        const fit = Math.min(vw / iw, vh / ih);
        const s = fit * zoom;
        const dw = iw * s, dh = ih * s;
        const baseDx = (vw - dw) / 2, baseDy = (vh - dh) / 2;
        return { s, baseDx, baseDy };
      })();

      // Pan so that startImg maps to current midpoint, plus extra translation from midpoint movement.
      const targetX = m.x;
      const targetY = m.y;

      pan.x = (targetX - (tNew.baseDx + pinch.startImg.ix * tNew.s));
      pan.y = (targetY - (tNew.baseDy + pinch.startImg.iy * tNew.s));

      // Add translation caused by moving midpoint since gesture start (natural pan)
      pan.x += (m.x - pinch.startMid.x);
      pan.y += (m.y - pinch.startMid.y);

      clampPan();
      updateZoomLabel();
      redraw();
      return;
    }

    // Panning with right button (desktop)
    if (panning && e.pointerType !== "touch") {
      e.preventDefault();
      const cx = e.clientX * dpr;
      const cy = e.clientY * dpr;
      const dx = cx - pointerStart.x;
      const dy = cy - pointerStart.y;
      pan.x = panStart.x + dx;
      pan.y = panStart.y + dy;
      clampPan();
      redraw();
      return;
    }

    // Drawing with left button / single-finger touch
    if (!drawing) { redraw(); return; }
    e.preventDefault();
    const { px, py } = pointerPos(e);
    const { ix, iy, inside } = viewToImage(px, py);
    if (inside) {
      if (lastPt) {
        drawStroke(lastPt.x, lastPt.y, ix, iy);
      } else {
        drawPoint(ix, iy);
      }
      lastPt = { x: ix, y: iy };
      redraw();
    }
  }

  function onPointerUp(e) {
    // Clear pointer tracking
    if (e && typeof e.pointerId !== "undefined") {
      activePointers.delete(e.pointerId);
    }

    // If one finger remains after pinch, stop pinch mode
    if (activePointers.size < 2) {
      pinch = null;
    }

    drawing = false;
    panning = false;
    lastPt = null;
  }

  async function exportPNG() {
    if (!img) return;
    const out = document.createElement("canvas");
    out.width = base.width;
    out.height = base.height;
    const octx = out.getContext("2d");
    octx.clearRect(0, 0, out.width, out.height);
    octx.drawImage(base, 0, 0);
    octx.globalCompositeOperation = "destination-in";
    octx.drawImage(mask, 0, 0);

    const blob = await new Promise((res) => out.toBlob(res, "image/png"));
    if (!blob) return;

    // If supported, ONLY save when the user completes the save dialog.
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: "nukkistudio.png",
          types: [{
            description: "PNG 이미지",
            accept: { "image/png": [".png"] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (e) {
        // User cancelled (AbortError) or picker failed -> do nothing (no silent download)
      }
      return;
    }

    // Fallback (only when picker is NOT supported)
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nukkistudio.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function loadImageFromFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    URL.revokeObjectURL(url);
    img = image;

    // Set base/mask canvas sizes to image size
    base.width = img.naturalWidth;
    base.height = img.naturalHeight;
    bctx.clearRect(0, 0, base.width, base.height);
    bctx.drawImage(img, 0, 0);

    mask.width = base.width;
    mask.height = base.height;
    mctx.clearRect(0, 0, mask.width, mask.height);
    // start fully kept: solid white
    mctx.fillStyle = "#ffffff";
    mctx.fillRect(0, 0, mask.width, mask.height);

    undoStack.length = 0;
    redoStack.length = 0;
    syncHistoryButtons();

    uploadCard.hidden = true;
    editorCard.hidden = false;
    setMode("erase");
    brushSizeVal.textContent = brushSize.value;

    zoom = 1.0;
    pan = {x: 0, y: 0};
    clampPan();

    updateZoomLabel();

    redraw();
  }

  // Events: upload
  btnPick.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("click", (e) => {
    if (e.target === btnPick) return;
    fileInput.click();
  });
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    loadImageFromFile(file);
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    loadImageFromFile(file);
  });

  // Events: tools
  tabErase.addEventListener("click", () => setMode("erase"));
  tabRestore.addEventListener("click", () => setMode("restore"));
  brushSize.addEventListener("input", () => {
    brushSizeVal.textContent = brushSize.value;
  });

  // Stage pointer
  view.addEventListener("pointerdown", onPointerDown);
  view.addEventListener("pointerenter", (e) => { if (!img) return; updateCursorFromEvent(e); redraw(); });
  view.addEventListener("pointerleave", () => { cursor.visible = false; redraw(); });
  view.addEventListener("contextmenu", (e)=>e.preventDefault());

  // Mouse wheel zoom (min 100% == 1.0, no further zoom-out)
  view.addEventListener("wheel", (e) => {
    if (!img) return;
    e.preventDefault();

    // Zoom speed
    const delta = Math.sign(e.deltaY);
    const step = 0.12; // 12% per notch-ish
    const oldZoom = zoom;

    if (delta > 0) zoom = Math.max(1.0, zoom * (1 - step));  // zoom out
    else if (delta < 0) zoom = Math.min(ZOOM_MAX, zoom * (1 + step)); // zoom in

    // Clamp: do nothing if unchanged
    if (zoom === oldZoom) return;

    // Keep the point under cursor stable by adjusting pan
    const rect = view.getBoundingClientRect();
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;

    // current transform BEFORE applying new pan (pan is current)
    const t1 = (() => {
      const vw = view.width, vh = view.height;
      const iw = base.width, ih = base.height;
      const fit = Math.min(vw / iw, vh / ih);
      const s = fit * oldZoom;
      const dw = iw * s, dh = ih * s;
      const baseDx = (vw - dw) / 2, baseDy = (vh - dh) / 2;
      return {fit, s, baseDx, baseDy, dx: baseDx + pan.x, dy: baseDy + pan.y};
    })();

    const ix = (px - t1.dx) / t1.s;
    const iy = (py - t1.dy) / t1.s;

    // new base with updated zoom
    const t2 = (() => {
      const vw = view.width, vh = view.height;
      const iw = base.width, ih = base.height;
      const fit = Math.min(vw / iw, vh / ih);
      const s = fit * zoom;
      const dw = iw * s, dh = ih * s;
      const baseDx = (vw - dw) / 2, baseDy = (vh - dh) / 2;
      return {s, baseDx, baseDy};
    })();

    const desiredDx = px - ix * t2.s;
    const desiredDy = py - iy * t2.s;

    pan.x = desiredDx - t2.baseDx;
    pan.y = desiredDy - t2.baseDy;
    clampPan();
    updateZoomLabel();

    redraw();
  }, { passive: false });

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  // Actions
  btnUndo.addEventListener("click", undo);
  btnRedo.addEventListener("click", redo);

  // Before/After press-and-hold
  btnBeforeAfter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    showOriginal = true;
    redraw();
  });
  const releaseBA = () => {
    if (!showOriginal) return;
    showOriginal = false;
    redraw();
  };
  btnBeforeAfter.addEventListener("pointerup", releaseBA);
  btnBeforeAfter.addEventListener("pointerleave", releaseBA);
  btnBeforeAfter.addEventListener("pointercancel", releaseBA);
  window.addEventListener("pointerup", releaseBA);

  btnDone.addEventListener("click", exportPNG);
  btnResetTop.addEventListener("click", openConfirmReset);
  confirmYes.addEventListener("click", () => {
    closeConfirmReset();
    resetAll();
  });
  confirmNo.addEventListener("click", closeConfirmReset);
  confirmOverlay.addEventListener("click", (e) => {
    if (e.target === confirmOverlay) closeConfirmReset();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && confirmOverlay && !confirmOverlay.classList.contains("hidden")) {
      closeConfirmReset();
    }
  });


  // Reset / Help
  btnHelpTop.addEventListener("click", () => openHelp(true));
  helpBackdrop.addEventListener("click", () => openHelp(false));
  btnHelpClose.addEventListener("click", () => openHelp(false));


  // Keyboard shortcuts: Ctrl/Cmd+Z/Y
  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;

    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
  });

  // Resize handling
  window.addEventListener("resize", () => {
    if (!img) return;
    redraw();
  });

  // init
  resetAll();
})();