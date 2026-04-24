// App controller: tabs, toolbar wiring, persistence orchestration.

import { Board, createBoardModel } from "./board.js";
import * as db from "./storage.js";

const SWATCH_COLORS = [
  "#1a1a1a", "#ffffff",
  "#dc2626", "#ea580c",
  "#ca8a04", "#16a34a",
  "#0284c7", "#2563eb",
  "#7c3aed", "#db2777",
];

const state = {
  boards: [],      // array of board models (without strokes loaded for list view? we keep full)
  activeId: null,
  board: null,     // active Board instance
  saveTimer: null,
};

const $ = (s) => document.querySelector(s);
const stage = $("#stage");
const canvas = $("#canvas");
const overlay = $("#overlay");
const tabsEl = $("#tabs");
const hintEl = $("#hint");

// --- Init ---
boot().catch(err => {
  console.error(err);
  toast("Fehler beim Start: " + err.message);
});

async function boot() {
  state.board = new Board({
    stage, canvas, overlay,
    onChange: queueSave,
    onRequestText: openTextEditor,
    onHintChange: (empty) => hintEl.classList.toggle("hidden", !empty),
  });

  const boards = await db.listBoards();
  state.boards = boards.sort((a, b) => a.created - b.created || 0);
  const activeId = await db.getMeta("activeId");
  if (!state.boards.length) {
    const b = createBoardModel("Tab 1");
    b.created = Date.now();
    state.boards.push(b);
    await db.saveBoard(b);
    state.activeId = b.id;
    await db.setMeta("activeId", b.id);
  } else {
    state.activeId = (activeId && state.boards.find(b => b.id === activeId)) ? activeId : state.boards[0].id;
  }

  renderTabs();
  await activate(state.activeId);

  wireToolbar();
  wireTopbar();
  wireKeyboard();
  wireDropZone();
  wireTextEditor();
  buildSwatches();

  // guard against accidental reload losing unsaved state
  window.addEventListener("beforeunload", () => { flushSave(); });
}

// --- Tabs ---
function renderTabs() {
  tabsEl.innerHTML = "";
  for (const b of state.boards) {
    const el = document.createElement("button");
    el.className = "tab" + (b.id === state.activeId ? " active" : "");
    el.dataset.id = b.id;
    el.innerHTML = `
      <span class="dot" style="background:${colorForBoard(b.id)}"></span>
      <span class="name">${escapeHtml(b.name)}</span>
      <span class="close" title="Schließen">×</span>`;
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("close")) {
        deleteTab(b.id);
      } else {
        activate(b.id);
      }
    });
    el.addEventListener("dblclick", (e) => {
      if (e.target.classList.contains("close")) return;
      renameTab(b.id);
    });
    tabsEl.appendChild(el);
  }
}

function colorForBoard(id) {
  // stable pseudo-color per tab
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 55%)`;
}

async function activate(id) {
  flushSave();
  const model = state.boards.find(b => b.id === id);
  if (!model) return;
  state.activeId = id;
  await db.setMeta("activeId", id);
  state.board.setModel(model);
  renderTabs();
}

async function newTab() {
  flushSave();
  const name = "Tab " + (state.boards.length + 1);
  const b = createBoardModel(name);
  b.created = Date.now();
  state.boards.push(b);
  await db.saveBoard(b);
  await activate(b.id);
}

async function deleteTab(id) {
  if (state.boards.length <= 1) {
    toast("Mindestens ein Tab muss bleiben");
    return;
  }
  const b = state.boards.find(x => x.id === id);
  if (!b) return;
  if (!confirm(`Tab "${b.name}" wirklich löschen?`)) return;
  state.boards = state.boards.filter(x => x.id !== id);
  await db.deleteBoard(id);
  if (state.activeId === id) {
    await activate(state.boards[0].id);
  } else {
    renderTabs();
  }
  db.gcBlobs();
}

async function renameTab(id) {
  const b = state.boards.find(x => x.id === id);
  if (!b) return;
  const name = prompt("Tab umbenennen:", b.name);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  b.name = trimmed.slice(0, 40);
  await db.saveBoard(b);
  renderTabs();
}

async function duplicateTab(id) {
  const src = state.boards.find(x => x.id === id);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = createBoardModel().id;
  copy.name = src.name + " (Kopie)";
  copy.created = Date.now();
  // reuse blob ids — blobs are shared, GC handles lifetime once BOTH boards drop refs
  state.boards.push(copy);
  await db.saveBoard(copy);
  await activate(copy.id);
}

// --- Saving ---
function queueSave() {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 400);
}
async function flushSave() {
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  const b = state.boards.find(x => x.id === state.activeId);
  if (!b) return;
  try { await db.saveBoard(b); } catch (e) { console.warn("save failed", e); }
}

// --- Toolbar ---
function wireToolbar() {
  document.querySelectorAll(".tool[data-tool]").forEach(btn => {
    btn.addEventListener("click", () => selectTool(btn.dataset.tool));
  });
  selectTool("pen");

  const color = $("#colorPicker");
  color.addEventListener("input", () => {
    state.board.setColor(color.value);
    updateSwatchActive(color.value);
    updateSizePreview();
  });

  const size = $("#sizeSlider");
  size.addEventListener("input", () => {
    state.board.setSize(+size.value);
    updateSizePreview();
  });
  updateSizePreview();

  $("#imgBtn").addEventListener("click", () => $("#imgInput").click());
  $("#imgInput").addEventListener("change", async (e) => {
    for (const f of e.target.files) {
      if (f.type.startsWith("image/")) {
        await state.board.addImageFromBlob(f);
      } else {
        toast(`"${f.name}" wird nicht als Bild unterstützt.`);
      }
    }
    e.target.value = "";
  });
}

function selectTool(t) {
  state.board.setTool(t);
  document.querySelectorAll(".tool[data-tool]").forEach(b =>
    b.classList.toggle("active", b.dataset.tool === t));
  const app = document.getElementById("app");
  app.className = ""; // clear
  app.classList.add("tool-" + t);
}

function buildSwatches() {
  const wrap = $("#swatches");
  wrap.innerHTML = "";
  for (const c of SWATCH_COLORS) {
    const s = document.createElement("div");
    s.className = "swatch";
    s.style.background = c;
    s.dataset.color = c;
    s.addEventListener("click", () => {
      $("#colorPicker").value = c;
      state.board.setColor(c);
      updateSwatchActive(c);
      updateSizePreview();
    });
    wrap.appendChild(s);
  }
  updateSwatchActive("#1a1a1a");
}

function updateSwatchActive(color) {
  document.querySelectorAll(".swatch").forEach(s =>
    s.classList.toggle("active", s.dataset.color.toLowerCase() === color.toLowerCase()));
}

function updateSizePreview() {
  const size = +$("#sizeSlider").value;
  const preview = $("#sizePreview");
  preview.style.setProperty("--size", Math.min(36, size) + "px");
  preview.style.color = $("#colorPicker").value;
}

// --- Topbar ---
function wireTopbar() {
  $("#newTabBtn").addEventListener("click", newTab);
  $("#undoBtn").addEventListener("click", () => state.board.undo());
  $("#redoBtn").addEventListener("click", () => state.board.redo());
  $("#zoomInBtn").addEventListener("click", () => state.board.setZoom(state.board.model.view.scale * 1.2));
  $("#zoomOutBtn").addEventListener("click", () => state.board.setZoom(state.board.model.view.scale / 1.2));
  $("#zoomResetBtn").addEventListener("click", () => state.board.resetZoom());

  $("#exportPngBtn").addEventListener("click", async () => {
    const url = await state.board.exportPng();
    if (!url) { toast("Nichts zu exportieren"); return; }
    const a = document.createElement("a");
    const b = state.boards.find(x => x.id === state.activeId);
    a.download = (b ? b.name : "whiteboard") + ".png";
    a.href = url;
    a.click();
  });

  $("#exportJsonBtn").addEventListener("click", async () => {
    const b = state.boards.find(x => x.id === state.activeId);
    if (!b) return;
    // embed blobs as base64 for portability
    const exp = JSON.parse(JSON.stringify(b));
    exp.blobs = {};
    for (const it of exp.items) {
      if (it.blobId && !exp.blobs[it.blobId]) {
        const blob = await db.loadBlob(it.blobId);
        if (blob) exp.blobs[it.blobId] = await blobToDataURL(blob);
      }
    }
    const blob = new Blob([JSON.stringify(exp)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = b.name + ".json";
    a.click();
    URL.revokeObjectURL(url);
  });

  $("#importJsonBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (!obj.id || !obj.name) throw new Error("Ungültiges Format");
      obj.id = createBoardModel().id; // new id to avoid clashes
      obj.created = Date.now();
      if (obj.blobs) {
        for (const [bid, url] of Object.entries(obj.blobs)) {
          const blob = await dataURLToBlob(url);
          // need to replace the blob id to something fresh? safer to keep original id
          await db.saveBlob(bid, blob);
        }
        delete obj.blobs;
      }
      state.boards.push(obj);
      await db.saveBoard(obj);
      await activate(obj.id);
      toast("Importiert");
    } catch (err) {
      toast("Import fehlgeschlagen: " + err.message);
    }
    e.target.value = "";
  });

  const menu = $("#menu");
  $("#menuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== $("#menuBtn")) menu.classList.add("hidden");
  });
  menu.addEventListener("click", async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    menu.classList.add("hidden");
    const b = state.boards.find(x => x.id === state.activeId);
    switch (act) {
      case "rename": renameTab(state.activeId); break;
      case "duplicate": duplicateTab(state.activeId); break;
      case "clear":
        if (confirm(`Alles in "${b.name}" löschen?`)) state.board.clear();
        break;
      case "delete": deleteTab(state.activeId); break;
      case "bg-white": state.board.setBg("white"); break;
      case "bg-grid": state.board.setBg("grid"); break;
      case "bg-dots": state.board.setBg("dots"); break;
      case "bg-lines": state.board.setBg("lines"); break;
      case "about":
        alert("Whiteboard — läuft komplett im Browser, Daten bleiben lokal gespeichert (IndexedDB). Stylus/Tablet via Pointer Events mit Druck. Tastenkürzel: P Stift, M Marker, E Radierer, T Text, V Auswahl, H verschieben, Strg+Z Undo, Strg+Y Redo, Strg+S Speichern, Leertaste halten = verschieben.");
        break;
    }
  });
}

// --- Keyboard ---
function wireKeyboard() {
  document.addEventListener("keydown", (e) => {
    // ignore when typing in inputs
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) state.board.redo(); else state.board.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      state.board.redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault(); flushSave(); toast("Gespeichert");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
      e.preventDefault(); newTab(); return;
    }

    if (e.code === "Space") {
      if (!state.spaceDown) {
        state.prevTool = state.board.tool;
        selectTool("hand");
        state.spaceDown = true;
      }
      e.preventDefault();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      const sel = overlay.querySelector(".item.selected");
      if (sel) {
        e.preventDefault();
        state.board.deleteItem(sel.dataset.id);
      }
      return;
    }
    const map = { p: "pen", m: "marker", e: "eraser", t: "text", v: "select", h: "hand" };
    const k = e.key.toLowerCase();
    if (map[k]) { selectTool(map[k]); }
  });
  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && state.spaceDown) {
      state.spaceDown = false;
      if (state.prevTool) selectTool(state.prevTool);
    }
  });
}

// --- Drop zone ---
function wireDropZone() {
  let overlayEl = null;
  stage.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!overlayEl) {
      overlayEl = document.createElement("div");
      overlayEl.className = "drop-overlay";
      overlayEl.textContent = "Datei hier ablegen …";
      stage.appendChild(overlayEl);
    }
  });
  stage.addEventListener("dragleave", (e) => {
    if (e.target === stage && overlayEl) { overlayEl.remove(); overlayEl = null; }
  });
  stage.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    const r = stage.getBoundingClientRect();
    const pos = state.board.s2w(e.clientX - r.left, e.clientY - r.top);
    const files = [...(e.dataTransfer?.files || [])];
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        await state.board.addImageFromBlob(f, pos);
      } else {
        toast(`"${f.name}" ist kein Bild — wird ignoriert.`);
      }
    }
  });
  // paste images from clipboard
  document.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        await state.board.addImageFromBlob(blob);
      }
    }
  });
}

function hasFiles(e) {
  const t = e.dataTransfer;
  if (!t) return false;
  return [...(t.items || [])].some(i => i.kind === "file");
}

// --- Text editor modal ---
function openTextEditor({ x, y, editId }) {
  const el = $("#textEditor");
  const ta = el.querySelector("textarea");
  const colorI = $("#textColor");
  const sizeI = $("#textSize");
  const commentI = $("#textIsComment");

  let editItem = null;
  if (editId) {
    editItem = state.board.model.items.find(i => i.id === editId);
    if (!editItem) return;
    ta.value = editItem.text || "";
    colorI.value = editItem.color || "#1a1a1a";
    sizeI.value = editItem.size || 20;
    commentI.checked = !!editItem.comment;
  } else {
    ta.value = "";
    colorI.value = state.board.color;
    sizeI.value = 20;
    commentI.checked = false;
  }

  el.classList.remove("hidden");
  setTimeout(() => ta.focus(), 10);

  const save = () => {
    const text = ta.value.trim();
    el.classList.add("hidden");
    if (!text && !editItem) return;
    if (editItem) {
      if (!text) { state.board.deleteItem(editItem.id); return; }
      state.board.updateText(editItem.id, {
        text, color: colorI.value, size: +sizeI.value, comment: commentI.checked,
      });
    } else {
      state.board.addText({
        x, y, text, color: colorI.value, size: +sizeI.value, comment: commentI.checked,
      });
    }
    cleanup();
  };
  const cancel = () => { el.classList.add("hidden"); cleanup(); };
  const onKey = (e) => {
    if (e.key === "Escape") cancel();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
  };

  function cleanup() {
    $("#textSave").removeEventListener("click", save);
    $("#textCancel").removeEventListener("click", cancel);
    ta.removeEventListener("keydown", onKey);
  }

  $("#textSave").addEventListener("click", save);
  $("#textCancel").addEventListener("click", cancel);
  ta.addEventListener("keydown", onKey);
}

function wireTextEditor() {
  // one-time nothing (handlers attached per-open), but keep for clarity
}

// --- Utils ---
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 1800);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function dataURLToBlob(url) {
  const res = await fetch(url);
  return res.blob();
}
