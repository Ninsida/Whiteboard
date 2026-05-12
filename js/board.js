// Board = one whiteboard tab. Drawing, items, pan/zoom, undo/redo, palm rejection.
// Images are stored inline as base64 data URLs so boards sync trivially.

export function newBoardId() {
  return "b_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function createBoardModel(name = "Tab 1") {
  return {
    id: newBoardId(),
    name,
    bg: "white",
    strokes: [],
    items: [],
    view: { x: 0, y: 0, scale: 1 },
    created: Date.now(),
    updated: Date.now(),
  };
}

const PEN_RECENT_MS = 30_000; // pen counts as "active" for this long after last contact

export class Board {
  constructor({ stage, canvas, overlay, onChange, onRequestText, onHintChange, onPenDetected }) {
    this.stage = stage;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.overlay = overlay;
    this.onChange = onChange || (() => {});
    this.onRequestText = onRequestText || (() => {});
    this.onHintChange = onHintChange || (() => {});
    this.onPenDetected = onPenDetected || (() => {});

    this.model = null;
    this.tool = "pen";
    this.color = "#0f172a";
    this.size = 3;

    this.undoStack = [];
    this.redoStack = [];

    this.activePointers = new Map();
    this.currentStroke = null;
    this.currentStrokePointerId = null;
    this.pinch = null;

    this.lastPenSeen = 0;
    this.palmMode = "auto"; // auto | on | off

    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.needsFullRedraw = false;
    this._rafQueued = false;

    this._bindEvents();
    this._setupResize();
  }

  /* ---------- Loading ---------- */
  setModel(model) {
    this.model = model;
    this.undoStack = [];
    this.redoStack = [];
    this.applyBg();
    this.applyView();
    this.renderOverlay();
    this.fullRedraw();
    this._updateHint();
  }

  applyBg() {
    const bg = this.model?.bg || "white";
    this.stage.classList.remove("bg-white", "bg-grid", "bg-dots", "bg-lines");
    this.stage.classList.add("bg-" + bg);
    this._updateBgScale();
  }
  setBg(bg) { this.model.bg = bg; this.applyBg(); this._dirty(); }

  /* ---------- View ---------- */
  applyView() {
    const v = this.model.view;
    this.overlay.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.scale})`;
    this._updateBgScale();
    this.fullRedraw();
  }
  _updateBgScale() {
    const bg = this.model?.bg || "white";
    if (bg === "white") return;
    const s = this.model?.view?.scale || 1;
    const x = this.model?.view?.x || 0;
    const y = this.model?.view?.y || 0;
    const base = bg === "dots" ? 24 : bg === "lines" ? 32 : 40;
    const size = base * s;
    this.canvas.style.backgroundSize = `${size}px ${size}px`;
    this.canvas.style.backgroundPosition = `${x}px ${y}px`;
  }
  setZoom(scale, cx, cy) {
    const v = this.model.view;
    const newScale = Math.min(8, Math.max(0.1, scale));
    if (cx == null) { cx = this.canvas.clientWidth / 2; cy = this.canvas.clientHeight / 2; }
    const wx = (cx - v.x) / v.scale;
    const wy = (cy - v.y) / v.scale;
    v.scale = newScale;
    v.x = cx - wx * newScale;
    v.y = cy - wy * newScale;
    this.applyView();
    this._dirty();
  }
  resetZoom() { this.model.view = { x: 0, y: 0, scale: 1 }; this.applyView(); this._dirty(); }
  panBy(dx, dy) { this.model.view.x += dx; this.model.view.y += dy; this.applyView(); }
  s2w(x, y) { const v = this.model.view; return { x: (x - v.x) / v.scale, y: (y - v.y) / v.scale }; }

  /* ---------- Tools ---------- */
  setTool(t) {
    this.tool = t;
    this.stage.classList.remove("cursor-pen", "cursor-erase", "cursor-text", "cursor-hand", "cursor-select");
    const map = { pen: "pen", marker: "pen", eraser: "erase", text: "text", hand: "hand", select: "select" };
    this.stage.classList.add("cursor-" + map[t]);
    if (t !== "select") this._selectItem(null);
  }
  setColor(c) { this.color = c; }
  setSize(s) { this.size = s; }
  setPalmMode(m) { this.palmMode = m; }

  /* ---------- Palm rejection ---------- */
  _isPenActive() {
    return performance.now() - this.lastPenSeen < PEN_RECENT_MS;
  }
  _shouldIgnoreTouch(e) {
    // Only block touch for drawing tools.
    const drawingTool = ["pen", "marker", "eraser", "text"].includes(this.tool);
    if (!drawingTool) return false;
    if (e.pointerType !== "touch") return false;
    // Two-finger gestures always pass through (pinch handler picks them up)
    const otherTouchCount = [...this.activePointers.values()]
      .filter(p => p.type === "touch").length;
    if (otherTouchCount >= 1) return false; // 2nd finger arriving → allow

    if (this.palmMode === "on") return true;
    if (this.palmMode === "off") return false;
    return this._isPenActive();
  }

  /* ---------- Resize ---------- */
  _setupResize() { new ResizeObserver(() => this._resize()).observe(this.stage); this._resize(); }
  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.fullRedraw();
  }

  /* ---------- Events ---------- */
  _bindEvents() {
    const el = this.stage;
    el.addEventListener("pointerdown", e => this._onPointerDown(e));
    el.addEventListener("pointermove", e => this._onPointerMove(e));
    el.addEventListener("pointerup", e => this._onPointerUp(e));
    el.addEventListener("pointercancel", e => this._onPointerUp(e));
    el.addEventListener("pointerleave", e => this._onPointerUp(e));
    el.addEventListener("wheel", e => this._onWheel(e), { passive: false });
    el.addEventListener("contextmenu", e => e.preventDefault());

    el.addEventListener("dblclick", e => {
      if (this.tool === "text") {
        const r = el.getBoundingClientRect();
        const p = this.s2w(e.clientX - r.left, e.clientY - r.top);
        this.onRequestText({ x: p.x, y: p.y });
      }
    });
  }

  _pointerPos(e) {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _onPointerDown(e) {
    if (e.target !== this.canvas && e.target !== this.stage) return;

    // Track pen presence (regardless of whether we draw with it)
    if (e.pointerType === "pen") {
      const wasActive = this._isPenActive();
      this.lastPenSeen = performance.now();
      if (!wasActive) this.onPenDetected(true);
    }

    // Palm rejection: ignore touch if pen is active
    if (this._shouldIgnoreTouch(e)) return;

    this.stage.setPointerCapture?.(e.pointerId);
    const pos = this._pointerPos(e);
    this.activePointers.set(e.pointerId, { ...pos, type: e.pointerType, pressure: e.pressure });

    // Middle/right mouse → pan
    if (e.button === 1 || e.button === 2) {
      this.activePointers.get(e.pointerId).pan = true;
      this.stage.classList.add("dragging");
      return;
    }

    // Two pointers → pinch (works with two fingers OR pen+finger)
    if (this.activePointers.size === 2) {
      // abort any active stroke
      if (this.currentStroke) {
        // discard mid-stroke if it has too few points
        if (this.currentStroke.points.length < 3) {
          this.currentStroke = null;
          this.fullRedraw();
        } else {
          this._commitStroke();
        }
      }
      this._beginPinch();
      return;
    }

    if (this.tool === "hand") {
      this.activePointers.get(e.pointerId).pan = true;
      this.stage.classList.add("dragging");
      return;
    }

    if (this.tool === "select") {
      this._selectItem(null);
      return;
    }

    if (this.tool === "text") {
      const p = this.s2w(pos.x, pos.y);
      this.onRequestText({ x: p.x, y: p.y });
      return;
    }

    // Start stroke
    const world = this.s2w(pos.x, pos.y);
    const pressure = (e.pointerType === "pen" && e.pressure > 0) ? e.pressure : 0.5;
    this.currentStroke = {
      tool: this.tool,
      color: this.color,
      size: this.size,
      points: [{ x: world.x, y: world.y, p: pressure }],
      _t0: performance.now(),
    };
    this.currentStrokePointerId = e.pointerId;
    this._drawStrokeSegment(this.currentStroke, 0, true);
  }

  _onPointerMove(e) {
    if (!this.activePointers.has(e.pointerId)) return;
    if (e.pointerType === "pen") this.lastPenSeen = performance.now();

    const prev = this.activePointers.get(e.pointerId);
    const pos = this._pointerPos(e);
    this.activePointers.set(e.pointerId, { ...prev, ...pos, pressure: e.pressure });

    if (this.activePointers.size >= 2 && this.pinch) { this._updatePinch(); return; }
    if (prev.pan) { this.panBy(pos.x - prev.x, pos.y - prev.y); return; }

    if (this.currentStroke && this.currentStrokePointerId === e.pointerId) {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        const p = this._pointerPos(ev);
        const w = this.s2w(p.x, p.y);
        const pressure = (ev.pointerType === "pen" && ev.pressure > 0) ? ev.pressure : 0.5;
        const pts = this.currentStroke.points;
        const last = pts[pts.length - 1];
        if (Math.hypot(w.x - last.x, w.y - last.y) < 0.5 / this.model.view.scale && pts.length > 1) continue;
        pts.push({ x: w.x, y: w.y, p: pressure });
        this._drawStrokeSegment(this.currentStroke, pts.length - 2, false);
      }
    }
  }

  _onPointerUp(e) {
    if (!this.activePointers.has(e.pointerId)) return;
    this.activePointers.delete(e.pointerId);
    this.stage.classList.remove("dragging");

    if (this.activePointers.size < 2) this.pinch = null;

    if (this.currentStroke && this.currentStrokePointerId === e.pointerId) {
      this._commitStroke();
    }

    if (this.activePointers.size === 0) {
      this.stage.releasePointerCapture?.(e.pointerId);
    }
  }

  _commitStroke() {
    if (!this.currentStroke) return;
    if (this.currentStroke.points.length >= 1) {
      if (this.currentStroke.tool === "eraser") {
        this._applyEraserStroke(this.currentStroke);
      } else {
        this._pushUndo();
        this.model.strokes.push(this._compactStroke(this.currentStroke));
      }
      this._dirty();
    }
    this.currentStroke = null;
    this.currentStrokePointerId = null;
    this._updateHint();
  }

  _beginPinch() {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    this.pinch = {
      d0: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      s0: this.model.view.scale,
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
      vx0: this.model.view.x, vy0: this.model.view.y,
    };
    this.fullRedraw();
  }

  _updatePinch() {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2 || !this.pinch) return;
    const [a, b] = pts;
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const newScale = Math.min(8, Math.max(0.1, this.pinch.s0 * (d / this.pinch.d0)));
    const wx = (this.pinch.cx - this.pinch.vx0) / this.pinch.s0;
    const wy = (this.pinch.cy - this.pinch.vy0) / this.pinch.s0;
    this.model.view.scale = newScale;
    this.model.view.x = cx - wx * newScale;
    this.model.view.y = cy - wy * newScale;
    this.applyView();
  }

  _onWheel(e) {
    e.preventDefault();
    const r = this.stage.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.01);
      this.setZoom(this.model.view.scale * factor, cx, cy);
    } else if (e.shiftKey) {
      this.panBy(-e.deltaY, 0);
    } else {
      const factor = Math.exp(-e.deltaY * 0.002);
      this.setZoom(this.model.view.scale * factor, cx, cy);
    }
  }

  /* ---------- Rendering ---------- */
  _compactStroke(s) {
    return { tool: s.tool, color: s.color, size: s.size,
             points: s.points.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), p: +p.p.toFixed(2) })) };
  }

  fullRedraw() { this.needsFullRedraw = true; this._queueRender(); }
  _queueRender() {
    if (this._rafQueued) return;
    this._rafQueued = true;
    requestAnimationFrame(() => {
      this._rafQueued = false;
      if (this.needsFullRedraw) this._render();
      this.needsFullRedraw = false;
    });
  }

  _render() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const v = this.model.view;
    ctx.setTransform(this.dpr * v.scale, 0, 0, this.dpr * v.scale, this.dpr * v.x, this.dpr * v.y);
    for (const s of this.model.strokes) this._drawStroke(s);
  }

  _drawStroke(s) {
    const ctx = this.ctx;
    const pts = s.points;
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = (s.tool === "marker") ? 0.35 : 1;

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.fillStyle = s.color;
      ctx.arc(pts[0].x, pts[0].y, s.size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    if (s.tool === "pen" || s.tool === "marker") {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const pressure = ((a.p || 0.5) + (b.p || 0.5)) / 2;
        const width = Math.max(0.5, s.size * (0.5 + pressure));
        ctx.lineWidth = s.tool === "marker" ? width * 2 : width;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.quadraticCurveTo(a.x, a.y, mx, my);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    } else {
      ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawStrokeSegment(s, fromIdx, first) {
    const ctx = this.ctx;
    const v = this.model.view;
    ctx.save();
    ctx.setTransform(this.dpr * v.scale, 0, 0, this.dpr * v.scale, this.dpr * v.x, this.dpr * v.y);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";

    if (s.tool === "eraser") {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = "#dc2626";
      ctx.lineWidth = s.size;
    } else if (s.tool === "marker") {
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size * 2;
    } else {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
    }

    const pts = s.points;
    if (first && pts.length === 1) {
      const p = pts[0];
      ctx.beginPath();
      ctx.fillStyle = s.color;
      ctx.arc(p.x, p.y, s.size / 2, 0, Math.PI * 2);
      if (s.tool !== "eraser") ctx.fill();
      ctx.restore();
      return;
    }
    for (let i = Math.max(1, fromIdx + 1); i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (s.tool === "pen" || s.tool === "marker") {
        const pressure = ((a.p || 0.5) + (b.p || 0.5)) / 2;
        const width = Math.max(0.5, s.size * (0.5 + pressure));
        ctx.lineWidth = s.tool === "marker" ? width * 2 : width;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.quadraticCurveTo(a.x, a.y, mx, my);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- Eraser ---------- */
  _applyEraserStroke(stroke) {
    const radius = stroke.size / 2;
    const before = this.model.strokes.length;
    const kept = [];
    for (const s of this.model.strokes) {
      if (this._strokeHitsPath(s, stroke.points, radius + s.size / 2)) continue;
      kept.push(s);
    }
    if (kept.length !== before) {
      this._pushUndo();
      this.model.strokes = kept;
      this.fullRedraw();
    }
  }
  _strokeHitsPath(stroke, erasePts, r) {
    const r2 = r * r;
    for (const a of stroke.points) {
      for (const e of erasePts) {
        if ((a.x - e.x) ** 2 + (a.y - e.y) ** 2 <= r2) return true;
      }
    }
    return false;
  }

  /* ---------- Items ---------- */
  async addImageFromBlob(blob, pos) {
    const dataUrl = await compressImageToDataURL(blob, 1600, 0.85);
    const dim = await imageDimensions(dataUrl);
    return this._addImage(dataUrl, dim.w, dim.h, pos);
  }

  _addImage(dataUrl, naturalW, naturalH, pos) {
    const id = "i_" + Math.random().toString(36).slice(2, 10);
    const maxW = 600, maxH = 600;
    const ratio = Math.min(maxW / naturalW, maxH / naturalH, 1);
    const iw = naturalW * ratio, ih = naturalH * ratio;
    const r = this.stage.getBoundingClientRect();
    const center = pos || this.s2w(r.width / 2, r.height / 2);
    const item = { id, type: "image", dataUrl, x: center.x - iw / 2, y: center.y - ih / 2, w: iw, h: ih };
    this._pushUndo();
    this.model.items.push(item);
    this._renderItem(item);
    this._dirty();
    this._updateHint();
    return item;
  }

  addText({ x, y, text, color, size, comment }) {
    const id = "t_" + Math.random().toString(36).slice(2, 10);
    const item = { id, type: "text", x, y, text, color, size, comment: !!comment };
    this._pushUndo();
    this.model.items.push(item);
    this._renderItem(item);
    this._dirty();
    this._updateHint();
    return item;
  }

  updateText(id, patch) {
    const it = this.model.items.find(i => i.id === id);
    if (!it) return;
    this._pushUndo();
    Object.assign(it, patch);
    const el = this.overlay.querySelector(`[data-id="${id}"]`);
    if (el) this._applyTextStyle(el, it);
    this._dirty();
  }

  deleteItem(id) {
    const idx = this.model.items.findIndex(i => i.id === id);
    if (idx < 0) return;
    this._pushUndo();
    this.model.items.splice(idx, 1);
    const el = this.overlay.querySelector(`[data-id="${id}"]`);
    if (el) el.remove();
    this._dirty();
    this._updateHint();
  }

  renderOverlay() {
    this.overlay.innerHTML = "";
    for (const it of this.model.items) this._renderItem(it);
  }

  _renderItem(it) {
    const el = document.createElement("div");
    el.className = "item " + it.type + (it.comment ? " comment" : "");
    el.dataset.id = it.id;
    el.style.left = it.x + "px";
    el.style.top = it.y + "px";
    el.style.width = it.w ? it.w + "px" : "auto";
    el.style.height = it.h ? it.h + "px" : "auto";
    if (it.type === "image") {
      const img = document.createElement("img");
      img.src = it.dataUrl;
      img.draggable = false;
      el.appendChild(img);
    } else {
      this._applyTextStyle(el, it);
    }
    this._attachItemHandlers(el, it);
    this.overlay.appendChild(el);
  }

  _applyTextStyle(el, it) {
    el.textContent = it.text || "";
    el.style.color = it.color || "#0f172a";
    el.style.fontSize = (it.size || 20) + "px";
    el.classList.toggle("comment", !!it.comment);
  }

  _attachItemHandlers(el, it) {
    let dragging = false, resizing = false, start = null;
    const onDown = (e) => {
      if (this.tool !== "select") return;
      e.stopPropagation();
      const target = e.target;
      if (target.classList.contains("del-handle")) { this.deleteItem(it.id); return; }
      this._selectItem(it.id);
      resizing = target.classList.contains("handle");
      dragging = !resizing;
      start = { x: e.clientX, y: e.clientY,
        ix: it.x, iy: it.y, iw: it.w || el.offsetWidth, ih: it.h || el.offsetHeight };
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e) => {
      if (!dragging && !resizing) return;
      const s = this.model.view.scale;
      const dx = (e.clientX - start.x) / s, dy = (e.clientY - start.y) / s;
      if (dragging) {
        it.x = start.ix + dx; it.y = start.iy + dy;
        el.style.left = it.x + "px"; el.style.top = it.y + "px";
      } else {
        it.w = Math.max(20, start.iw + dx); it.h = Math.max(20, start.ih + dy);
        el.style.width = it.w + "px"; el.style.height = it.h + "px";
      }
    };
    const onUp = () => { if (dragging || resizing) this._dirty(); dragging = resizing = false; };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("dblclick", (e) => {
      if (it.type === "text") { e.stopPropagation(); this.onRequestText({ editId: it.id }); }
    });
  }

  _selectItem(id) {
    this.overlay.querySelectorAll(".item.selected").forEach(e => {
      e.classList.remove("selected");
      e.querySelectorAll(".handle, .del-handle").forEach(h => h.remove());
    });
    if (!id) return;
    const el = this.overlay.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.classList.add("selected");
    const h = document.createElement("div"); h.className = "handle"; el.appendChild(h);
    const d = document.createElement("div"); d.className = "del-handle"; d.textContent = "×"; el.appendChild(d);
  }

  /* ---------- Undo / Redo ---------- */
  _snapshot() {
    return JSON.stringify({ strokes: this.model.strokes, items: this.model.items, bg: this.model.bg });
  }
  _pushUndo() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._snapshot());
    const s = JSON.parse(this.undoStack.pop());
    this.model.strokes = s.strokes; this.model.items = s.items; this.model.bg = s.bg;
    this.applyBg(); this.renderOverlay(); this.fullRedraw();
    this._dirty(); this._updateHint();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snapshot());
    const s = JSON.parse(this.redoStack.pop());
    this.model.strokes = s.strokes; this.model.items = s.items; this.model.bg = s.bg;
    this.applyBg(); this.renderOverlay(); this.fullRedraw();
    this._dirty(); this._updateHint();
  }
  clear() {
    this._pushUndo();
    this.model.strokes = []; this.model.items = [];
    this.renderOverlay(); this.fullRedraw();
    this._dirty(); this._updateHint();
  }

  _dirty() { this.model.updated = Date.now(); this.onChange(); }
  _updateHint() {
    const empty = this.model.strokes.length === 0 && this.model.items.length === 0;
    this.onHintChange(empty);
  }

  /* ---------- Export ---------- */
  async exportPng() {
    const bounds = this._contentBounds();
    if (!bounds) return null;
    const pad = 40;
    const W = Math.max(100, bounds.w + pad * 2), H = Math.max(100, bounds.h + pad * 2);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const isDark = document.documentElement.dataset.theme === "dark";
    ctx.fillStyle = isDark ? "#0f172a" : "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.translate(-bounds.x + pad, -bounds.y + pad);

    for (const it of this.model.items) {
      if (it.type !== "image") continue;
      const img = await loadImage(it.dataUrl);
      ctx.drawImage(img, it.x, it.y, it.w, it.h);
    }
    const prevCtx = this.ctx;
    this.ctx = ctx;
    for (const s of this.model.strokes) this._drawStroke(s);
    this.ctx = prevCtx;
    for (const it of this.model.items) {
      if (it.type !== "text") continue;
      if (it.comment) {
        ctx.fillStyle = "#fef3c7";
        ctx.strokeStyle = "#fbbf24";
        const w = (it.w || 200), h = (it.h || 60);
        ctx.fillRect(it.x, it.y, w, h);
        ctx.strokeRect(it.x, it.y, w, h);
      }
      ctx.fillStyle = it.color || "#0f172a";
      ctx.font = `${it.size || 20}px -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = "top";
      let ly = it.y + 8;
      for (const line of (it.text || "").split("\n")) {
        ctx.fillText(line, it.x + 12, ly);
        ly += (it.size || 20) * 1.35;
      }
    }
    return c.toDataURL("image/png");
  }

  _contentBounds() {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, any = false;
    for (const s of this.model.strokes) {
      for (const p of s.points) {
        any = true;
        minx = Math.min(minx, p.x); miny = Math.min(miny, p.y);
        maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y);
      }
    }
    for (const it of this.model.items) {
      any = true;
      minx = Math.min(minx, it.x); miny = Math.min(miny, it.y);
      maxx = Math.max(maxx, it.x + (it.w || 200));
      maxy = Math.max(maxy, it.y + (it.h || 60));
    }
    return any ? { x: minx, y: miny, w: maxx - minx, h: maxy - miny } : null;
  }
}

/* ---------- Image helpers ---------- */
async function compressImageToDataURL(blob, maxDim = 1600, quality = 0.85) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    let w = img.naturalWidth, h = img.naturalHeight;
    const ratio = Math.min(maxDim / w, maxDim / h, 1);
    w = Math.round(w * ratio); h = Math.round(h * ratio);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    const mime = (blob.type === "image/png" && hasTransparency(c)) ? "image/png" : "image/jpeg";
    return c.toDataURL(mime, quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function hasTransparency(canvas) {
  const ctx = canvas.getContext("2d");
  // sample a few pixels along edges + center
  const w = canvas.width, h = canvas.height;
  const samples = [[0,0],[w-1,0],[0,h-1],[w-1,h-1],[Math.floor(w/2),Math.floor(h/2)]];
  for (const [x,y] of samples) {
    if (ctx.getImageData(x, y, 1, 1).data[3] < 250) return true;
  }
  return false;
}

function imageDimensions(src) {
  return loadImage(src).then(img => ({ w: img.naturalWidth, h: img.naturalHeight }));
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}
