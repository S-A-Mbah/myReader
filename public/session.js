/**
 * Session persistence in IndexedDB: what the user loaded and where they were, so a
 * refresh resumes instead of starting over. IndexedDB rather than localStorage because
 * a textbook's text runs to several megabytes (localStorage caps around 5 MB).
 *
 * Everything here fails soft: private windows, blocked storage or a full disk mean
 * "nothing restored", never an error in the app.
 */

const DB_NAME = 'readaloud';
const STORE = 'session';

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    dbPromise.catch(() => {
      dbPromise = null; // allow a later retry
    });
  }
  return dbPromise;
}

/**
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest | void} fn
 * @returns {Promise<any>}
 */
async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * @param {string} key
 * @returns {Promise<any>} undefined when missing or storage is unavailable
 */
export async function sessionGet(key) {
  try {
    return await run('readonly', (s) => s.get(key));
  } catch {
    return undefined;
  }
}

/**
 * @param {string} key
 * @param {any} value structured-cloneable
 * @returns {Promise<boolean>} whether it was stored
 */
export async function sessionSet(key, value) {
  try {
    await run('readwrite', (s) => s.put(value, key));
    return true;
  } catch {
    return false;
  }
}

/** @param {string[]} keys */
export async function sessionDelete(keys) {
  try {
    await run('readwrite', (s) => {
      for (const k of keys) s.delete(k);
    });
  } catch {
    /* nothing to delete, or storage unavailable */
  }
}
