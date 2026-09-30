const DB_NAME = 'arc-cfa-practice';
const VERSION = 1;
const STORES = ['banks', 'sessions'];

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => STORES.forEach((name) => {
      if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
    });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function all(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function put(store, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
export async function remove(store, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
export async function exportData() { return { version: 1, exportedAt: new Date().toISOString(), banks: await all('banks'), sessions: await all('sessions') }; }
export async function importData(data) {
  if (data?.version !== 1 || !Array.isArray(data.banks) || !Array.isArray(data.sessions)) throw new Error('不支援的備份格式');
  for (const item of data.banks) await put('banks', item);
  for (const item of data.sessions) await put('sessions', item);
}
