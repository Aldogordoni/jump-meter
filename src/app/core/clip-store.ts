/**
 * Video clips saved with jumps. Kept in IndexedDB on this device only:
 * localStorage is too small for video, and nothing leaves the phone.
 */

export interface StoredClip {
  id: string; // same as the jump record id
  video: Blob;
  poster: Blob;
  mime: string;
  createdAt: string;
}

const DB = 'jump-meter';
const STORE = 'clips';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const clipStore = {
  put: (clip: StoredClip) => tx('readwrite', (s) => s.put(clip)).then(() => undefined),
  get: (id: string) => tx<StoredClip | undefined>('readonly', (s) => s.get(id)),
  delete: (id: string) => tx('readwrite', (s) => s.delete(id)).then(() => undefined),
  ids: () => tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((k) => new Set(k.map(String))),
};

/**
 * Ask the browser not to clear our storage under pressure. Safari otherwise
 * deletes site data after 7 days without a visit (unless installed to the home screen).
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
