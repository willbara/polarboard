// A small IndexedDB key-value store for offline copies of notes and the tree.
// It works over plain http too (unlike the service worker), so notes stay
// readable and editable when the connection drops.

const DB = 'polarboard';
const STORE = 'kv';
let opening = null;

function db() {
  opening ||= new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const idb = {
  get: (key) => run('readonly', (s) => s.get(key)).catch(() => undefined),
  set: (key, value) => run('readwrite', (s) => s.put(value, key)).catch(() => {}),
  del: (key) => run('readwrite', (s) => s.delete(key)).catch(() => {}),
  keys: (prefix) => run('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿'))).catch(() => []),
  async clear(prefix) {
    const keys = await idb.keys(prefix);
    await run('readwrite', (s) => { keys.forEach((k) => s.delete(k)); return null; }).catch(() => {});
    return keys.length;
  },
};
