// App controller: tabs, toolbar, theme, sync, text editor, drag-drop.

import { Board, createBoardModel } from "./board.js";
import * as db from "./storage.js";
import * as sync from "./sync.js";

const SWATCH_COLORS = [
  "#0f172a", "#ffffff",
  "#dc2626", "#ea580c",
  "#ca8a04", "#16a34a",
  "#0284c7", "#2563eb",
  "#7c3aed", "#db2777",
];

const $ = (s) => document.querySelector(s);

const state = {
  boards: [],
  activeId: null,
  board: null,
  saveTimer: null,
  palmMode: "auto", // auto | on | off
  penEverSeen: false,
};

boot().catch(err => {
  console.error(err);
  toast("Fehler beim Start: " + err.message);
});

async function boot() {
  applyStoredTheme();

  state.board = new Board({
    stage: $("#stage"),
    canvas: $("#canvas"),
    overlay: $("#overlay"),
    onChange: onBoardChange,
    onRequestText: openTextEditor,
    onHintChange: (empty) => $("#hint").classList.toggle("hidden", !empty),
    onPenDetected: onPenDetected,
  });

  // load boards
  let boards = await db.listBoards();
  // strip any legacy `blobId` items (no longer supported) so they don't break rendering
  for (const b of boards) {
    if (b.items) b.items = b.items.filter(it => it.type !== "image" || it.dataUrl);
  }
  state.boards = boards.sort((a, b) => (a.created || 0) - (b.created || 0));
  if (!state.boards.length) {
    const b = createBoardModel("Tab 1");
    state.boards.push(b);
    await db.saveBoard(b);
  }
  const stored = await db.getMeta("activeId");
  state.activeId = (stored && state.boards.find(b => b.id === stored)) ? stored : state.boards[0].id;

  renderTabs();
  await activate(state.activeId);

  wireToolbar();
  wireTopbar();
  wireKeyboard();
  wireDropZone();
  wireMenu();
  wireSyncDialog();
  wireTextDialog();
  buildSwatches();

  await maybeAutoConnectSync();

  window.addEventListener("beforeunload", () => { flushSave(); sync.flushWrites?.(); });
}

/* ---------- Theme ---------- */
function applyStoredTheme() {
  const t = localStorage.getItem("wb-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = t;
  updateThemeIcon(t);
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("wb-theme", next);
  updateThemeIcon(next);
}
function updateThemeIcon(theme) {
  const icon = $("#themeIcon");
  if (!icon) return;
  if (theme === "dark") {
    icon.innerHTML = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2 M12 20v2 M4.93 4.93l1.41 1.41 M17.66 17.66l1.41 1.41 M2 12h2 M20 12h2 M4.93 19.07l1.41-1.41 M17.66 6.34l1.41-1.41"/>';
  } else {
    icon.innerHTML = '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>';
  }
}

/* ---------- Tabs ---------- */
function renderTabs() {
  const tabsEl = $("#tabs");
  tabsEl.innerHTML = "";
  for (const b of state.boards) {
    const el = document.createElement("button");
    el.className = "tab" + (b.id === state.activeId ? " active" : "");
    el.dataset.id = b.id;
    el.innerHTML = `
      <span class="dot" style="background:${colorForBoard(b.id)}"></span>
      <span class="name"></span>
      <span class="close" title="Schließen">×</span>`;
    el.querySelector(".name").textContent = b.name;
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("close")) deleteTab(b.id);
      else activate(b.id);
    });
    el.addEventListener("dblclick", (e) => {
      if (e.target.classList.contains("close")) return;
      renameTab(b.id);
    });
    tabsEl.appendChild(el);
  }
}
function colorForBoard(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 55%)`;
}

async function activate(id) {
  await flushSave();
  const model = state.boards.find(b => b.id === id);
  if (!model) return;
  state.activeId = id;
  await db.setMeta("activeId", id);
  state.board.setModel(model);
  renderTabs();
}
async function newTab() {
  await flushSave();
  const b = createBoardModel("Tab " + (state.boards.length + 1));
  state.boards.push(b);
  await db.saveBoard(b);
  if (sync.isEnabled()) sync.pushBoard(b);
  await activate(b.id);
}
async function deleteTab(id) {
  if (state.boards.length <= 1) { toast("Mindestens ein Tab muss bleiben"); return; }
  const b = state.boards.find(x => x.id === id);
  if (!b) return;
  if (!confirm(`Tab "${b.name}" wirklich löschen?`)) return;
  state.boards = state.boards.filter(x => x.id !== id);
  await db.deleteBoard(id);
  if (sync.isEnabled()) sync.deleteBoardRemote(id);
  if (state.activeId === id) await activate(state.boards[0].id);
  else renderTabs();
}
async function renameTab(id) {
  const b = state.boards.find(x => x.id === id);
  if (!b) return;
  const name = prompt("Tab umbenennen:", b.name);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  b.name = trimmed.slice(0, 40);
  b.updated = Date.now();
  await db.saveBoard(b);
  if (sync.isEnabled()) sync.pushBoard(b);
  renderTabs();
}
async function duplicateTab(id) {
  const src = state.boards.find(x => x.id === id);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = createBoardModel().id;
  copy.name = src.name + " (Kopie)";
  copy.created = Date.now();
  copy.updated = Date.now();
  state.boards.push(copy);
  await db.saveBoard(copy);
  if (sync.isEnabled()) sync.pushBoard(copy);
  await activate(copy.id);
}

/* ---------- Save / sync orchestration ---------- */
function onBoardChange() {
  queueSave();
}
function queueSave() {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 350);
}
async function flushSave() {
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  const b = state.boards.find(x => x.id === state.activeId);
  if (!b) return;
  try {
    await db.saveBoard(b);
    if (sync.isEnabled()) sync.pushBoard(b);
  } catch (e) { console.warn("save failed", e); }
}

/* ---------- Pen detection ---------- */
function onPenDetected(active) {
  state.penEverSeen = state.penEverSeen || active;
  $("#penBadge").classList.toggle("visible", active && state.palmMode !== "off");
}

/* ---------- Toolbar ---------- */
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
      if (f.type.startsWith("image/")) await state.board.addImageFromBlob(f);
      else toast(`"${f.name}" wird nicht als Bild unterstützt.`);
    }
    e.target.value = "";
  });
}
function selectTool(t) {
  state.board.setTool(t);
  document.querySelectorAll(".tool[data-tool]").forEach(b =>
    b.classList.toggle("active", b.dataset.tool === t));
  const app = $("#app");
  app.classList.remove("tool-pen", "tool-marker", "tool-eraser", "tool-text", "tool-select", "tool-hand");
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
  updateSwatchActive("#0f172a");
}
function updateSwatchActive(color) {
  document.querySelectorAll(".swatch").forEach(s =>
    s.classList.toggle("active", s.dataset.color.toLowerCase() === color.toLowerCase()));
}
function updateSizePreview() {
  const sz = +$("#sizeSlider").value;
  const preview = $("#sizePreview");
  preview.style.setProperty("--size", Math.min(36, sz) + "px");
  preview.style.color = $("#colorPicker").value;
}

/* ---------- Topbar ---------- */
function wireTopbar() {
  $("#newTabBtn").addEventListener("click", newTab);
  $("#undoBtn").addEventListener("click", () => state.board.undo());
  $("#redoBtn").addEventListener("click", () => state.board.redo());
  $("#zoomInBtn").addEventListener("click", () => state.board.setZoom(state.board.model.view.scale * 1.2));
  $("#zoomOutBtn").addEventListener("click", () => state.board.setZoom(state.board.model.view.scale / 1.2));
  $("#zoomResetBtn").addEventListener("click", () => state.board.resetZoom());
  $("#themeBtn").addEventListener("click", toggleTheme);
  $("#syncStatus").addEventListener("click", openSyncDialog);
}

/* ---------- Menu ---------- */
function wireMenu() {
  const menu = $("#menu");
  $("#menuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
    updatePalmStateLabel();
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== $("#menuBtn")) menu.classList.add("hidden");
  });
  menu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act !== "palm") menu.classList.add("hidden");
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
      case "sync": openSyncDialog(); break;
      case "export-png": await doExportPng(b); break;
      case "export-json": await doExportJson(b); break;
      case "import-json": $("#importFile").click(); break;
      case "palm": cyclePalmMode(); break;
      case "about":
        alert("Whiteboard — läuft komplett im Browser. Daten lokal in IndexedDB + optional via Firebase synchronisiert.\n\nTastenkürzel:\nP Stift · M Marker · E Radierer · T Text · V Auswahl · H Verschieben\nCtrl+Z / Ctrl+Shift+Z Undo/Redo · Ctrl+S Speichern · Ctrl+T neuer Tab · Leertaste = Verschieben");
        break;
    }
  });
  $("#importFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (!obj.id || !obj.name) throw new Error("Ungültiges Format");
      obj.id = createBoardModel().id;
      obj.created = Date.now();
      obj.updated = Date.now();
      state.boards.push(obj);
      await db.saveBoard(obj);
      if (sync.isEnabled()) sync.pushBoard(obj);
      await activate(obj.id);
      toast("Importiert");
    } catch (err) {
      toast("Import fehlgeschlagen: " + err.message);
    }
    e.target.value = "";
  });
}

function cyclePalmMode() {
  const order = ["auto", "on", "off"];
  const idx = order.indexOf(state.palmMode);
  state.palmMode = order[(idx + 1) % 3];
  state.board.setPalmMode(state.palmMode);
  updatePalmStateLabel();
  if (state.palmMode === "off") $("#penBadge").classList.remove("visible");
  toast("Handflächen-Schutz: " + palmLabel(state.palmMode));
}
function palmLabel(m) {
  return m === "auto" ? "auto (Stift erkannt)" : m === "on" ? "immer an" : "aus";
}
function updatePalmStateLabel() {
  const el = $("#palmState");
  if (el) el.textContent = state.palmMode;
}

async function doExportPng(b) {
  const url = await state.board.exportPng();
  if (!url) { toast("Nichts zu exportieren"); return; }
  const a = document.createElement("a");
  a.download = (b ? b.name : "whiteboard") + ".png";
  a.href = url;
  a.click();
}
async function doExportJson(b) {
  if (!b) return;
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = b.name + ".json";
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- Keyboard ---------- */
function wireKeyboard() {
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) state.board.redo(); else state.board.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault(); state.board.redo(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault(); flushSave(); toast("Gespeichert"); return;
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
      const sel = $("#overlay").querySelector(".item.selected");
      if (sel) { e.preventDefault(); state.board.deleteItem(sel.dataset.id); }
      return;
    }
    const map = { p: "pen", m: "marker", e: "eraser", t: "text", v: "select", h: "hand" };
    const k = e.key.toLowerCase();
    if (map[k]) selectTool(map[k]);
  });
  document.addEventListener("keyup", (e) => {
    if (e.code === "Space" && state.spaceDown) {
      state.spaceDown = false;
      if (state.prevTool) selectTool(state.prevTool);
    }
  });
}

/* ---------- Drop zone + paste ---------- */
function wireDropZone() {
  const stage = $("#stage");
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
    for (const f of [...(e.dataTransfer?.files || [])]) {
      if (f.type.startsWith("image/")) await state.board.addImageFromBlob(f, pos);
      else toast(`"${f.name}" ist kein Bild — ignoriert.`);
    }
  });
  document.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        await state.board.addImageFromBlob(it.getAsFile());
      }
    }
  });
}
function hasFiles(e) {
  return [...(e.dataTransfer?.items || [])].some(i => i.kind === "file");
}

/* ---------- Text editor dialog ---------- */
function wireTextDialog() {
  $("#textCancel").addEventListener("click", closeTextEditor);
  $("#textCancel2").addEventListener("click", closeTextEditor);
}
let textEditorContext = null;
function openTextEditor({ x, y, editId }) {
  const back = $("#textBackdrop");
  const ta = $("#textEditor textarea");
  const colorI = $("#textColor");
  const sizeI = $("#textSize");
  const commentI = $("#textIsComment");

  let editItem = null;
  if (editId) {
    editItem = state.board.model.items.find(i => i.id === editId);
    if (!editItem) return;
    ta.value = editItem.text || "";
    colorI.value = editItem.color || "#0f172a";
    sizeI.value = editItem.size || 20;
    commentI.checked = !!editItem.comment;
  } else {
    ta.value = "";
    colorI.value = state.board.color;
    sizeI.value = 20;
    commentI.checked = false;
  }

  textEditorContext = { x, y, editItem };
  back.classList.remove("hidden");
  setTimeout(() => ta.focus(), 30);

  const onSave = () => {
    const text = ta.value.trim();
    closeTextEditor();
    if (!text && !editItem) return;
    if (editItem) {
      if (!text) { state.board.deleteItem(editItem.id); return; }
      state.board.updateText(editItem.id, {
        text, color: colorI.value, size: +sizeI.value, comment: commentI.checked,
      });
    } else {
      state.board.addText({ x, y, text, color: colorI.value, size: +sizeI.value, comment: commentI.checked });
    }
  };
  // re-bind save handler each open
  const saveBtn = $("#textSave");
  saveBtn.onclick = onSave;
  ta.onkeydown = (e) => {
    if (e.key === "Escape") closeTextEditor();
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSave();
  };
}
function closeTextEditor() {
  $("#textBackdrop").classList.add("hidden");
  textEditorContext = null;
}

/* ---------- Sync dialog ---------- */
function wireSyncDialog() {
  $("#syncClose").addEventListener("click", () => $("#syncBackdrop").classList.add("hidden"));
  $("#syncCancel").addEventListener("click", () => $("#syncBackdrop").classList.add("hidden"));
  $("#syncGenerate").addEventListener("click", () => {
    $("#syncWorkspace").value = sync.newWorkspaceCode();
  });
  $("#syncCopy").addEventListener("click", async () => {
    const w = $("#syncWorkspace");
    w.select();
    try { await navigator.clipboard.writeText(w.value); toast("Kopiert"); }
    catch { document.execCommand("copy"); toast("Kopiert"); }
  });
  $("#syncDisable").addEventListener("click", () => {
    sync.teardown();
    sync.clearSettings();
    $("#syncBackdrop").classList.add("hidden");
    updateSyncStatus("idle");
    toast("Sync deaktiviert");
  });
  $("#syncSave").addEventListener("click", async () => {
    const configRaw = $("#syncConfig").value.trim();
    const workspaceId = $("#syncWorkspace").value.trim();
    let config;
    try {
      config = parseFirebaseConfig(configRaw);
    } catch (err) {
      toast("Config-Fehler: " + err.message);
      return;
    }
    try {
      sync.saveSettings({ config, workspaceId, enabled: true });
      await connectSync(config, workspaceId, /*initialPush=*/true);
      $("#syncBackdrop").classList.add("hidden");
      toast("Sync verbunden");
    } catch (err) {
      toast("Verbindung fehlgeschlagen: " + err.message);
      updateSyncStatus("error");
    }
  });
}

function openSyncDialog() {
  const back = $("#syncBackdrop");
  const settings = sync.loadSettings();
  if (settings) {
    $("#syncConfig").value = JSON.stringify(settings.config, null, 2);
    $("#syncWorkspace").value = settings.workspaceId || "";
  } else {
    if (!$("#syncWorkspace").value) $("#syncWorkspace").value = sync.newWorkspaceCode();
  }
  back.classList.remove("hidden");
}

function parseFirebaseConfig(raw) {
  if (!raw) throw new Error("Config ist leer");
  // Tolerate the "firebaseConfig = {...}" form people copy from Firebase docs
  let s = raw.replace(/^[\s\S]*?(\{)/, "$1");
  // Strip trailing semicolons / extra text after the closing brace
  const lastBrace = s.lastIndexOf("}");
  if (lastBrace > 0) s = s.slice(0, lastBrace + 1);
  // Allow JS-style (unquoted keys, single quotes)
  let obj;
  try { obj = JSON.parse(s); }
  catch {
    try { obj = Function('"use strict"; return (' + s + ')')(); }
    catch (e) { throw new Error("Konnte Config nicht lesen"); }
  }
  if (!obj || typeof obj !== "object") throw new Error("Config ist kein Objekt");
  if (!obj.databaseURL) throw new Error("databaseURL fehlt — Realtime Database in Firebase aktivieren");
  return obj;
}

async function maybeAutoConnectSync() {
  const settings = sync.loadSettings();
  if (!settings || !settings.enabled) return;
  try {
    await connectSync(settings.config, settings.workspaceId, /*initialPush=*/false);
  } catch (err) {
    console.warn("auto-sync failed:", err);
    updateSyncStatus("error");
  }
}

async function connectSync(config, workspaceId, initialPush) {
  updateSyncStatus("connecting");
  await sync.init({
    config, workspaceId,
    onRemoteBoard: handleRemoteBoard,
    onRemoteDelete: handleRemoteDelete,
    onStatus: updateSyncStatus,
  });
  if (initialPush) {
    for (const b of state.boards) sync.pushBoard(b);
    await sync.flushWrites();
  }
}

async function handleRemoteBoard(remote) {
  if (!remote || !remote.id) return;
  const local = state.boards.find(b => b.id === remote.id);
  // last-write-wins by `updated` timestamp
  if (!local) {
    state.boards.push(remote);
    await db.saveBoard(remote);
    renderTabs();
    return;
  }
  if ((remote.updated || 0) <= (local.updated || 0)) return;
  // Don't yank the canvas if user is actively drawing
  if (state.board.currentStroke && state.activeId === remote.id) return;
  Object.assign(local, remote);
  await db.saveBoard(local);
  if (state.activeId === local.id) state.board.setModel(local);
  else renderTabs();
}

async function handleRemoteDelete(id) {
  if (!state.boards.find(b => b.id === id)) return;
  state.boards = state.boards.filter(b => b.id !== id);
  await db.deleteBoard(id);
  if (state.activeId === id && state.boards.length) {
    await activate(state.boards[0].id);
  } else {
    renderTabs();
  }
}

function updateSyncStatus(s) {
  const el = $("#syncStatus");
  if (!el) return;
  el.classList.remove("connected", "connecting", "error");
  let label = "Lokal";
  if (s === "connecting") { el.classList.add("connecting"); label = "Verbinde…"; }
  else if (s === "connected") { el.classList.add("connected"); label = "Synced"; }
  else if (s === "error") { el.classList.add("error"); label = "Fehler"; }
  el.querySelector(".label").textContent = label;
}

/* ---------- Utils ---------- */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2000);
}
