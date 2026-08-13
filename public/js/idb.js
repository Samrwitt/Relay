const DB_NAME = "relay-db";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("history")) {
        const s = db.createObjectStore("history", { keyPath: "id" });
        s.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains("transfers")) {
        db.createObjectStore("transfers", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("chunks")) {
        db.createObjectStore("chunks", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const st = tx.objectStore(store);
    const result = fn(st);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function historyAdd(entry) {
  await withStore("history", "readwrite", (s) => s.put(entry));
}

export async function historyList(limit = 80) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("history", "readonly");
    const idx = tx.objectStore("history").index("createdAt");
    const items = [];
    const req = idx.openCursor(null, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && items.length < limit) {
        items.push(cursor.value);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(items);
    tx.onerror = () => reject(tx.error);
  });
}

export async function historyClear() {
  await withStore("history", "readwrite", (s) => s.clear());
}

export async function transferPut(meta) {
  await withStore("transfers", "readwrite", (s) => s.put(meta));
}

export async function transferGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("transfers", "readonly");
    const req = tx.objectStore("transfers").get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function transferDelete(id) {
  await withStore("transfers", "readwrite", (s) => s.delete(id));
}

export function chunkKey(transferId, fileId, index) {
  return `${transferId}:${fileId}:${index}`;
}

export async function chunkPut(transferId, fileId, index, data) {
  const key = chunkKey(transferId, fileId, index);
  const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  await withStore("chunks", "readwrite", (s) => s.put({ key, transferId, fileId, index, data: buf }));
}

export async function chunkGet(transferId, fileId, index) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("chunks", "readonly");
    const req = tx.objectStore("chunks").get(chunkKey(transferId, fileId, index));
    req.onsuccess = () => resolve(req.result?.data || null);
    req.onerror = () => reject(req.error);
  });
}

export async function chunkKeysFor(transferId, fileId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("chunks", "readonly");
    const req = tx.objectStore("chunks").getAllKeys();
    req.onsuccess = () => {
      const prefix = `${transferId}:${fileId}:`;
      const indices = req.result
        .filter((k) => String(k).startsWith(prefix))
        .map((k) => Number(String(k).slice(prefix.length)))
        .filter((n) => Number.isFinite(n));
      resolve(indices);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function chunksDeleteFor(transferId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("chunks", "readwrite");
    const store = tx.objectStore("chunks");
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith(`${transferId}:`)) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function assembleBlob(transferId, fileId, totalChunks, type) {
  const parts = [];
  for (let i = 0; i < totalChunks; i++) {
    const data = await chunkGet(transferId, fileId, i);
    if (!data) throw new Error(`Missing chunk ${i}`);
    parts.push(data);
  }
  return new Blob(parts, { type: type || "application/octet-stream" });
}
