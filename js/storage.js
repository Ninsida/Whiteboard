// IndexedDB wrapper for boards + blobs. Plain promises, no deps.

const DB_NAME = "whiteboard";
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("boards")) {
        db.createObjectStore("boards", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("blobs")) {
        db.createObjectStore("blobs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode = "readonly") {
  return openDB().then(db => db.transaction(store, mode).objectStore(store));
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveBoard(board) {
  const store = await tx("boards", "readwrite");
  return wrap(store.put(board));
}

export async function loadBoard(id) {
  const store = await tx("boards");
  return wrap(store.get(id));
}

export async function deleteBoard(id) {
  const store = await tx("boards", "readwrite");
  return wrap(store.delete(id));
}

export async function listBoards() {
  const store = await tx("boards");
  return wrap(store.getAll());
}

export async function saveBlob(id, blob) {
  const store = await tx("blobs", "readwrite");
  return wrap(store.put({ id, blob }));
}

export async function loadBlob(id) {
  const store = await tx("blobs");
  const rec = await wrap(store.get(id));
  return rec ? rec.blob : null;
}

export async function deleteBlob(id) {
  const store = await tx("blobs", "readwrite");
  return wrap(store.delete(id));
}

export async function getMeta(key) {
  const store = await tx("meta");
  const rec = await wrap(store.get(key));
  return rec ? rec.value : null;
}

export async function setMeta(key, value) {
  const store = await tx("meta", "readwrite");
  return wrap(store.put({ key, value }));
}

// Garbage-collect blobs not referenced by any board.
export async function gcBlobs() {
  const boards = await listBoards();
  const used = new Set();
  for (const b of boards) {
    for (const it of b.items || []) {
      if (it.blobId) used.add(it.blobId);
    }
  }
  const store = await tx("blobs", "readwrite");
  const req = store.getAllKeys();
  const keys = await wrap(req);
  const storeW = await tx("blobs", "readwrite");
  for (const k of keys) {
    if (!used.has(k)) storeW.delete(k);
  }
}
