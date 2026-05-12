// Firebase Realtime Database sync — lazy-loaded only when sync is enabled.
// Uses Firebase JS SDK 10.x ESM modules from gstatic CDN.

const FB_VER = "10.12.5";

let app = null;
let db = null;
let workspaceRef = null;
let listeners = [];
let listenerCb = null;
let onStatusChange = null;
let suppressNextLocal = new Set(); // board IDs to ignore on next remote update
let connState = "idle";
let pendingWrites = new Map(); // boardId -> latest version waiting to flush
let writeTimer = null;
let dynRef, dynOnValue, dynSet, dynRemove, dynGet, dynChild, dynUpdate, dynOnDisconnect;

export function isEnabled() {
  return !!workspaceRef;
}

export function getStatus() {
  return connState;
}

function setStatus(s) {
  connState = s;
  if (onStatusChange) onStatusChange(s);
}

export async function init({ config, workspaceId, onRemoteBoard, onRemoteDelete, onStatus }) {
  onStatusChange = onStatus;
  setStatus("connecting");
  try {
    if (!config || !config.databaseURL) {
      throw new Error("Firebase-Config muss databaseURL enthalten");
    }
    if (!workspaceId || workspaceId.length < 12) {
      throw new Error("Workspace-Code zu kurz");
    }

    const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app.js`);
    const dbMod = await import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-database.js`);
    dynRef = dbMod.ref; dynOnValue = dbMod.onValue; dynSet = dbMod.set;
    dynRemove = dbMod.remove; dynGet = dbMod.get; dynChild = dbMod.child;
    dynUpdate = dbMod.update; dynOnDisconnect = dbMod.onDisconnect;

    app = initializeApp(config, "whiteboard-" + Date.now());
    db = dbMod.getDatabase(app);
    workspaceRef = dynRef(db, `ws/${workspaceId}/boards`);

    // Connection state
    const connRef = dynRef(db, ".info/connected");
    listeners.push(dynOnValue(connRef, (snap) => {
      setStatus(snap.val() ? "connected" : "connecting");
    }));

    // Subscribe to all board changes
    listeners.push(dynOnValue(workspaceRef, (snap) => {
      const data = snap.val();
      if (!data) return;
      for (const [id, board] of Object.entries(data)) {
        if (suppressNextLocal.has(id)) {
          suppressNextLocal.delete(id);
          continue;
        }
        if (board === null) {
          if (onRemoteDelete) onRemoteDelete(id);
        } else {
          if (onRemoteBoard) onRemoteBoard(board);
        }
      }
    }, (err) => {
      console.error("Firebase listener error:", err);
      setStatus("error");
    }));

    listenerCb = onRemoteBoard;
    setStatus("connected");
    return true;
  } catch (err) {
    console.error("Sync init failed:", err);
    setStatus("error");
    teardown();
    throw err;
  }
}

export function teardown() {
  for (const off of listeners) { try { off(); } catch {} }
  listeners = [];
  workspaceRef = null;
  app = null; db = null;
  setStatus("idle");
}

// Debounced write of a board. Multiple rapid changes coalesce into one write.
export function pushBoard(board) {
  if (!workspaceRef) return;
  pendingWrites.set(board.id, JSON.parse(JSON.stringify(board)));
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushWrites, 600);
}

export async function flushWrites() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!workspaceRef || pendingWrites.size === 0) return;
  const updates = {};
  for (const [id, board] of pendingWrites.entries()) {
    suppressNextLocal.add(id);
    updates[id] = board;
  }
  pendingWrites.clear();
  try {
    await dynUpdate(workspaceRef, updates);
  } catch (err) {
    console.error("Sync write failed:", err);
    setStatus("error");
  }
}

export async function deleteBoardRemote(id) {
  if (!workspaceRef) return;
  suppressNextLocal.add(id);
  try {
    await dynRemove(dynChild(workspaceRef, id));
  } catch (err) {
    console.error("Sync delete failed:", err);
  }
}

export async function fetchAll() {
  if (!workspaceRef) return null;
  const snap = await dynGet(workspaceRef);
  return snap.val() || {};
}

// Helper: generate a strong workspace code
export function newWorkspaceCode() {
  const arr = new Uint8Array(18);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
}

// Persist sync settings in localStorage
export function saveSettings({ config, workspaceId, enabled }) {
  localStorage.setItem("wb-sync", JSON.stringify({ config, workspaceId, enabled }));
}
export function loadSettings() {
  try {
    const raw = localStorage.getItem("wb-sync");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
export function clearSettings() {
  localStorage.removeItem("wb-sync");
}
