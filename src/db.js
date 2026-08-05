// @ts-check
/**
 * Pulse IndexedDB cache — instant re-open of chats + offline dashboard reads.
 *
 * Two object stores:
 *   'kv'    — dashboard/profile/connections cache, keyed `dash:{userId}`
 *   'chats' — per-conversation message history, keyed `chat:{userId}:{friendId}`
 *
 * All keys are namespaced by user id so switching accounts never leaks data
 * between them. Every API fails soft (returns null/false) — IndexedDB may be
 * unavailable in private browsing or old WebViews, and the app must keep
 * working exactly as before.
 */

const DB_NAME = 'pulse-cache';
const DB_VERSION = 1;

/** @type {Promise<IDBDatabase>|null} */
let _dbPromise = null;

/**
 * Open (and lazily create) the database.
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });

  return _dbPromise;
}

/**
 * @param {'kv'|'chats'} store
 * @param {string} key
 * @param {IDBTransactionMode} mode
 * @returns {Promise<IDBObjectStore>}
 */
async function getStore(store, key, mode) {
  const db = await openDb();
  return db.transaction(store, mode).objectStore(store);
}

/**
 * Read a value from a store.
 * @template T
 * @param {'kv'|'chats'} store
 * @param {string} key
 * @returns {Promise<T|null>}
 */
export async function dbGet(store, key) {
  try {
    const s = await getStore(store, key, 'readonly');
    return await new Promise((resolve, reject) => {
      const r = s.get(key);
      r.onsuccess = () => resolve((/** @type {T|null} */ (r.result)));
      r.onerror = () => reject(r.error);
    });
  } catch {
    return null;
  }
}

/**
 * Write a value to a store.
 * @param {'kv'|'chats'} store
 * @param {string} key
 * @param {unknown} value
 * @returns {Promise<boolean>}
 */
export async function dbSet(store, key, value) {
  try {
    const s = await getStore(store, key, 'readwrite');
    return await new Promise((resolve, reject) => {
      const r = s.put(value, key);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return false;
  }
}

/**
 * Delete a value from a store.
 * @param {'kv'|'chats'} store
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function dbDelete(store, key) {
  try {
    const s = await getStore(store, key, 'readwrite');
    return await new Promise((resolve, reject) => {
      const r = s.delete(key);
      r.onsuccess = () => resolve(true);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return false;
  }
}

/**
 * Delete every cached entry belonging to a user (sign-out / account switch /
 * config reset) so one account's data never leaks into another's.
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function clearUserCache(userId) {
  if (!userId) return false;
  try {
    const db = await openDb();
    const prefix = `${userId}`;
    for (const storeName of /** @type {const} */ (['kv', 'chats'])) {
      const tx = db.transaction(storeName, 'readonly');
      const keys = await new Promise((resolve, reject) => {
        const r = tx.objectStore(storeName).getAllKeys();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const k of keys) {
        if (typeof k === 'string' && k.startsWith(prefix)) {
          await dbDelete(storeName, k);
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Dashboard cache key for a user. @param {string} userId */
export function dashKey(userId) {
  return `dash:${userId}`;
}

/** Chat cache key for a conversation. @param {string} userId @param {string} friendId */
export function chatKey(userId, friendId) {
  return `chat:${userId}:${friendId}`;
}
