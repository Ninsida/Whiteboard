// Board = one whiteboard tab. Handles drawing, items (images/text), pan/zoom,
// undo/redo, and rendering. The stroke data is kept in the board model so it
// survives reload (redrawn on load). Live drawing is streamed to canvas for
// smoothness. Items (images/text) live in the overlay DOM layer.

import { saveBlob, loadBlob } from "./storage.js";

export function newBoardId() {
  return "b_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function createBoardModel(name = "Tab 1") {
  return {
    id: newBoardId(),
    name,
    bg: "white", // white | grid | dots | lines
    strokes: [],
    items: [],
    view: { x: 0, y: 0, scale: 1 },
    updated: Date.now(),
  };
}

export class Board {
  constructor({ stage, canvas, overlay, onChange, onRequestText, onHintChange }) {
    this.stage = stage;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.overlay = overlay;
    this.onChange = onChange || (() => {});
    this.onRequestText = onRequestText || (() => {});
    this.onHintChange = onHintChange || (() => {});

    this.model = null;
    this.tool = "pen";
    this.color = "#1a1a1a";
    this.size = 3;

    this.undoStack = [];
    this.redoStack = [];

    this.activePointers = new Map(); // id -> {x,y,type,pressure,down}
    this.currentStroke = null;       // stroke in progress
    this.pinch = null;               // {d0, s0, cx, cy}

    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.needsFullRedraw = false;
    this._rafQueued = false;

    this._bindEvents();
    this._setupResize();
  }

  /* ---------- Loading / saving ---------- */
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

  setBg(bg) {
    this.model.bg = bg;
    this.applyBg();
    this._dirty();
  }

  /* ---------- View (pan/zoom) ---------- */
  applyView() {
    const v = this.model.view;
    this.overlay.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.scale})`;
    this._updateBgScale();
    this.fullRedraw();
  }

  _updateBgScale() {
    const bg = this.model?.bg || "white";
    const s = this.model?.view?.scale || 1;
    const x = this.model?.view?.x || 0;
    const y = this.model?.view?.y || 0;
    if (bg === "white") return;
    const base = bg === "dots" ? 24 : bg === "lines" ? 32 : 40;
    const size = base * s;
    this.canvas.style.backgroundSize = `${size}px ${size}px`;
    this.canvas.style.backgroundPosition = `${x}px ${y}px`;
    this.stage.style.setProperty("--grid", size + "px");
  }

  setZoom(scale, cx, cy) {
    const v = this.model.view;
    const oldScale = v.scale;
    const newScale = Math.min(8, Math.max(0.1, scale));
    if (cx == null) { cx = this.canvas.clientWidth / 2; cy = this.canvas.clientHeight / 2; }
    // zoom around point: world coordinate at cursor must stay fixed
    const wx = (cx - v.x) / oldScale;
    const wy = (cy - v.y) / oldScale;
    v.scale = newScale;
    v.x = cx - wx * newScale;
    v.y = cy - wy * newScale;
    this.applyView();
    this._dirty();
  }

  resetZoom() {
    this.model.view = { x: 0, y: 0, scale: 1 };
    this.applyView();
    this._dirty();
  }

  panBy(dx, dy) {
    this.model.view.x += dx;
    this.model.view.y += dy;
    this.applyView();
  }

  // screen -> world coords
  s2w(x, y) {
    const v = this.model.view;
    return { x: (x - v.x) / v.scale, y: (y - v.y) / v.scale };
  }

  /* ---------- Tools ---------- */
  setTool(t) {
    this.tool = t;
    this.stage.classList.remove("cursor-pen", "cursor-erase", "cursor-text", "cursor-hand", "cursor-select");
    const map = { pen: "pen", marker: "pen", eraser: "erase", text: "text", hand: "hand", select: "select" };
    this.stage.classList.add("cursor-" + map[t]);
    // deselect when switching away from select tool
    if (t !== "select") this._selectItem(null);
  }
  setColor(c) { this.color = c; }
  setSize(s) { this.size = s; }

  /* ---------- Drawing / events ---------- */
  _setupResize() {
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(this.stage);
    this._resize();
  }

  _resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.fullRedraw();
  }

  _bindEvents() {
    const el = this.stage;
    el.addEventListener("pointerdown", e => this._onPointerDown(e));
    el.addEventListener("pointermove", e => this._onPointerMove(e));
    el.addEventListener("pointerup", e => this._onPointerUp(e));
    el.addEventListener("pointercancel", e => this._onPointerUp(e));
    el.addEventListener("pointerleave", e => this._onPointerUp(e));

    el.addEventListener("wheel", e => this._onWheel(e), { passive: false });
    el.addEventListener("contextmenu", e => e.preventDefault());

    // double-tap/click on empty area while text tool = add text
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
    // Ignore clicks on overlay items; they handle themselves.
    if (e.target !== this.canvas && e.target !== this.stage) return;

    this.stage.setPointerCapture?.(e.pointerId);
    const pos = this._pointerPos(e);
    this.activePointers.set(e.pointerId, { ...pos, type: e.pointerType, pressure: e.pressure });

    // Middle mouse or right button = pan
    if (e.button === 1 || e.button === 2) {
      this.activePointers.get(e.pointerId).pan = true;
      this.stage.classList.add("dragging");
      return;
    }

    // Two-finger pinch/pan start
    if (this.activePointers.size === 2) {
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

    // start stroke (pen/marker/eraser)
    const world = this.s2w(pos.x, pos.y);
    const pressure = (e.pointerType === "pen" && e.pressure > 0) ? e.pressure : 0.5;
    this.currentStroke = {
      tool: this.tool,
      color: this.color,
      size: this.size,
      points: [{ x: world.x, y: world.y, p: pressure, t: 0 }],
      _t0: performance.now(),
    };
    this._drawStrokeSegment(this.currentStroke, 0, true);
  }

  _onPointerMove(e) {
    if (!this.activePointers.has(e.pointerId)) return;
    const prev = this.activePointers.get(e.pointerId);
    const pos = this._pointerPos(e);
    this.activePointers.set(e.pointerId, { ...prev, ...pos, pressure: e.pressure });

    // pinch / two-finger
    if (this.activePointers.size >= 2 && this.pinch) {
      this._updatePinch();
      return;
    }

    // pan
    if (prev.pan) {
      this.panBy(pos.x - prev.x, pos.y - prev.y);
      return;
    }

    // draw
    if (this.currentStroke) {
      // use coalesced events for smoother strokes on stylus
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        const p = this._pointerPos(ev);
        const w = this.s2w(p.x, p.y);
        const pressure = (ev.pointerType === "pen" && ev.pressure > 0) ? ev.pressure : 0.5;
        const t = performance.now() - this.currentStroke._t0;
        const pts = this.currentStroke.points;
        // simple distance filter to keep point count sane
        const last = pts[pts.length - 1];
        if (Math.hypot(w.x - last.x, w.y - last.y) < 0.5 / this.model.view.scale && pts.length > 1) continue;
        pts.push({ x: w.x, y: w.y, p: pressure, t });
        this._drawStrokeSegment(this.currentStroke, pts.length - 2, false);
      }
    }
  }

  _onPointerUp(e) {
    if (!this.activePointers.has(e.pointerId)) return;
    this.activePointers.delete(e.pointerId);
    this.stage.classList.remove("dragging");

    if (this.activePointers.size < 2) this.pinch = null;

    if (this.currentStroke && this.activePointers.size === 0) {
      // commit stroke
      if (this.currentStroke.points.length >= 2) {
        if (this.currentStroke.tool === "eraser") {
          this._applyEraserStroke(this.currentStroke);
        } else {
          this._pushUndo();
          this.model.strokes.push(this._compactStroke(this.currentStroke));
        }
        this._dirty();
      }
      this.currentStroke = null;
      this._updateHint();
    }

    if (this.activePointers.size === 0) {
      this.stage.releasePointerCapture?.(e.pointerId);
    }
  }

  _beginPinch() {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    this.pinch = {
      d0: Math.hypot(b.x - a.x, b.y - a.y),
      s0: this.model.view.scale,
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      vx0: this.model.view.x,
      vy0: this.model.view.y,
    };
    // abandon any in-progress stroke so pinch doesn't also draw
    if (this.currentStroke) this.currentStroke = null;
    this.fullRedraw();
  }

  _updatePinch() {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2 || !this.pinch) return;
    const [a, b] = pts;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const scale = this.pinch.s0 * (d / this.pinch.d0);
    const newScale = Math.min(8, Math.max(0.1, scale));
    // first translate by midpoint delta, then scale around pinch.cx/cy
    const dx = cx - this.pinch.cx;
    const dy = cy - this.pinch.cy;
    // world point under pinch center at start
    const wx = (this.pinch.cx - this.pinch.vx0) / this.pinch.s0;
    const wy = (this.pinch.cy - this.pinch.vy0) / this.pinch.s0;
    this.model.view.scale = newScale;
    this.model.view.x = cx - wx * newScale + 0;
    this.model.view.y = cy - wy * newScale + 0;
    // apply translation from pinch movement
    this.model.view.x += 0; this.model.view.y += 0;
    this.applyView();
  }

  _onWheel(e) {
    e.preventDefault();
    const r = this.stage.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey) {
      // pinch-zoom trackpad or ctrl+wheel
      const factor = Math.exp(-e.deltaY * 0.01);
      this.setZoom(this.model.view.scale * factor, cx, cy);
    } else if (e.shiftKey) {
      this.panBy(-e.deltaY, 0);
    } else {
      // plain scroll wheel = zoom around cursor (feels right for whiteboards)
      const factor = Math.exp(-e.deltaY * 0.002);
      this.setZoom(this.model.view.scale * factor, cx, cy);
    }
  }

  /* ---------- Rendering ---------- */
  _compactStroke(s) {
    return { tool: s.tool, color: s.color, size: s.size, points: s.points.map(p => ({ x: p.x, y: p.y, p: p.p })) };
  }

  fullRedraw() {
    this.needsFullRedraw = true;
    this._queueRender();
  }

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
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const v = this.model.view;
    ctx.setTransform(this.dpr * v.scale, 0, 0, this.dpr * v.scale, this.dpr * v.x, this.dpr * v.y);
    for (const s of this.model.strokes) this._drawStroke(s);
  }

  _drawStroke(s) {
    const ctx = this.ctx;
    const pts = s.points;
    if (pts.length < 2) {
      ctx.beginPath();
      ctx.fillStyle = s.color;
      ctx.arc(pts[0].x, pts[0].y, s.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = s.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.tool === "marker") {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = s.size * 2;
    } else {
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    // use pressure to vary width (pen/marker). Draw each segment with smoothing.
    if (s.tool === "pen" || s.tool === "marker") {
      // simple variable-width using mid-point quads
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const pressure = ((a.p || 0.5) + (b.p || 0.5)) / 2;
        const width = Math.max(0.5, s.size * (0.5 + pressure));
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        ctx.quadraticCurveTo(a.x, a.y, mx, my);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    } else {
      ctx.lineWidth = s.size;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Incrementally draw only the latest segment so we don't redraw everything on each move.
  _drawStrokeSegment(s, fromIdx, first) {
    const ctx = this.ctx;
    const v = this.model.view;
    ctx.save();
    ctx.setTransform(this.dpr * v.scale, 0, 0, this.dpr * v.scale, this.dpr * v.x, this.dpr * v.y);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";

    if (s.tool === "eraser") {
      // live preview: show as soft red
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
      const a = pts[i - 1];
      const b = pts[i];
      if (s.tool === "pen" || s.tool === "marker") {
        const pressure = ((a.p || 0.5) + (b.p || 0.5)) / 2;
        const width = Math.max(0.5, s.size * (0.5 + pressure));
        ctx.lineWidth = s.tool === "marker" ? width * 2 : width;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      ctx.quadraticCurveTo(a.x, a.y, mx, my);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- Eraser ---------- */
  _applyEraserStroke(stroke) {
    const r = stroke.size / 2;
    const before = this.model.strokes.length;
    const kept = [];
    for (const s of this.model.strokes) {
      if (this._strokeHitsPath(s, stroke.points, r + s.size / 2)) continue;
      kept.push(s);
    }
    if (kept.length !== before) {
      this._pushUndo();
      this.model.strokes = kept;
      this.fullRedraw();
    }
  }

  _strokeHitsPath(stroke, erasePts, radius) {
    const pts = stroke.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      for (const e of erasePts) {
        if ((a.x - e.x) ** 2 + (a.y - e.y) ** 2 <= radius * radius) return true;
      }
    }
    return false;
  }

  /* ---------- Items (images, text) ---------- */
  async addImageFromBlob(blob, pos) {
    const id = "i_" + Math.random().toString(36).slice(2, 10);
    await saveBlob(id, blob);
    const url = URL.createObjectURL(blob);
    const { w, h } = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = rej;
      img.src = url;
    });
    // limit initial size
    const maxW = 600, maxH = 600;
    let iw = w, ih = h;
    const ratio = Math.min(maxW / w, maxH / h, 1);
    iw = w * ratio; ih = h * ratio;
    const r = this.stage.getBoundingClientRect();
    const center = pos || this.s2w(r.width / 2, r.height / 2);
    const item = {
      id,
      type: "image",
      blobId: id,
      x: center.x - iw / 2,
      y: center.y - ih / 2,
      w: iw, h: ih,
      rotation: 0,
    };
    this._pushUndo();
    this.model.items.push(item);
    this._renderItem(item, url);
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

  async renderOverlay() {
    this.overlay.innerHTML = "";
    for (const it of this.model.items) {
      if (it.type === "image") {
        const blob = await loadBlob(it.blobId);
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        this._renderItem(it, url);
      } else {
        this._renderItem(it);
      }
    }
  }

  _renderItem(it, imgUrl) {
    const el = document.createElement("div");
    el.className = "item " + it.type + (it.comment ? " comment" : "");
    el.dataset.id = it.id;
    el.style.left = it.x + "px";
    el.style.top = it.y + "px";
    el.style.width = it.w ? it.w + "px" : "auto";
    el.style.height = it.h ? it.h + "px" : "auto";
    if (it.type === "image") {
      const img = document.createElement("img");
      img.src = imgUrl;
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
    el.style.color = it.color || "#1a1a1a";
    el.style.fontSize = (it.size || 20) + "px";
    el.classList.toggle("comment", !!it.comment);
  }

  _attachItemHandlers(el, it) {
    let dragging = false, resizing = false, start = null;
    const onDown = (e) => {
      if (this.tool !== "select") return;
      e.stopPropagation();
      const target = e.target;
      if (target.classList.contains("del-handle")) {
        this.deleteItem(it.id);
        return;
      }
      this._selectItem(it.id);
      resizing = target.classList.contains("handle");
      dragging = !resizing;
      start = {
        x: e.clientX, y: e.clientY,
        ix: it.x, iy: it.y, iw: it.w || el.offsetWidth, ih: it.h || el.offsetHeight,
      };
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e) => {
      if (!dragging && !resizing) return;
      const s = this.model.view.scale;
      const dx = (e.clientX - start.x) / s;
      const dy = (e.clientY - start.y) / s;
      if (dragging) {
        it.x = start.ix + dx;
        it.y = start.iy + dy;
        el.style.left = it.x + "px";
        el.style.top = it.y + "px";
      } else if (resizing) {
        it.w = Math.max(20, start.iw + dx);
        it.h = Math.max(20, start.ih + dy);
        el.style.width = it.w + "px";
        el.style.height = it.h + "px";
      }
    };
    const onUp = () => {
      if (dragging || resizing) this._dirty();
      dragging = resizing = false;
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);

    el.addEventListener("dblclick", (e) => {
      if (it.type === "text") {
        e.stopPropagation();
        this.onRequestText({ editId: it.id });
      }
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
    const h = document.createElement("div");
    h.className = "handle";
    el.appendChild(h);
    const d = document.createElement("div");
    d.className = "del-handle";
    d.textContent = "×";
    el.appendChild(d);
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
    this.applyBg();
    this.renderOverlay();
    this.fullRedraw();
    this._dirty();
    this._updateHint();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snapshot());
    const s = JSON.parse(this.redoStack.pop());
    this.model.strokes = s.strokes; this.model.items = s.items; this.model.bg = s.bg;
    this.applyBg();
    this.renderOverlay();
    this.fullRedraw();
    this._dirty();
    this._updateHint();
  }

  clear() {
    this._pushUndo();
    this.model.strokes = [];
    this.model.items = [];
    this.renderOverlay();
    this.fullRedraw();
    this._dirty();
    this._updateHint();
  }

  _dirty() {
    this.model.updated = Date.now();
    this.onChange();
  }

  _updateHint() {
    const empty = this.model.strokes.length === 0 && this.model.items.length === 0;
    this.onHintChange(empty);
  }

  /* ---------- Export ---------- */
  async exportPng() {
    // Build an offscreen canvas sized to content bounding box.
    const bounds = this._contentBounds();
    if (!bounds) return null;
    const pad = 40;
    const W = Math.max(100, bounds.w + pad * 2);
    const H = Math.max(100, bounds.h + pad * 2);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.translate(-bounds.x + pad, -bounds.y + pad);

    // items first (images/text below strokes so you can annotate on top),
    // actually order: images bottom, strokes middle, text top.
    for (const it of this.model.items) {
      if (it.type !== "image") continue;
      const blob = await loadBlob(it.blobId);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });
      ctx.drawImage(img, it.x, it.y, it.w, it.h);
      URL.revokeObjectURL(url);
    }
    // strokes
    const prev = [this.ctx, this.canvas];
    this.ctx = ctx;
    for (const s of this.model.strokes) this._drawStroke(s);
    this.ctx = prev[0];
    // text items
    for (const it of this.model.items) {
      if (it.type !== "text") continue;
      if (it.comment) {
        ctx.fillStyle = "#fef3c7";
        ctx.strokeStyle = "#fbbf24";
        const w = (it.w || 200), h = (it.h || 60);
        ctx.fillRect(it.x, it.y, w, h);
        ctx.strokeRect(it.x, it.y, w, h);
      }
      ctx.fillStyle = it.color || "#1a1a1a";
      ctx.font = `${it.size || 20}px -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textBaseline = "top";
      const lines = (it.text || "").split("\n");
      let ly = it.y + 8;
      for (const line of lines) { ctx.fillText(line, it.x + 12, ly); ly += (it.size || 20) * 1.3; }
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
    if (!any) return null;
    return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
  }
}
