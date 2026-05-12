// IndexedDB wrapper for boards + meta. Images are stored inline as data URLs in
// each board's items array, so there's no separate blob store anymore.

const DB_NAME = "whiteboard";
const DB_VERSION = 2;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("boards")) {
        db.createObjectStore("boards", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      // Old "blobs" store: leave it alone (will be ignored). It's harmless.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("DB blocked"));
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

export async function getMeta(key) {
  const store = await tx("meta");
  const rec = await wrap(store.get(key));
  return rec ? rec.value : null;
}
export async function setMeta(key, value) {
  const store = await tx("meta", "readwrite");
  return wrap(store.put({ key, value }));
}
