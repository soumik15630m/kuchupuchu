/** Decrypted media kept on this device, keyed by the server's media id.
 *
 * Two jobs. Day to day it stops a photo being re-downloaded and re-decrypted
 * every time its bubble scrolls back into view. More importantly it is where
 * a restore puts media: the server drops blobs after seven days, so a backup
 * carries the bytes itself and they have to live somewhere `fetchMedia` will
 * look. Plaintext here is consistent with the message store, which already
 * holds decrypted bodies on the same disk.
 */

import { openStore } from "../idb";

const DB_NAME = "kuchupuchu-media-cache";
const DB_VERSION = 1;
const STORE = "blobs";

function openDb(): Promise<IDBDatabase> {
  return openStore(DB_NAME, DB_VERSION, STORE, (db) => {
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
  });
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | void
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve((req ? (req as IDBRequest).result : undefined) as T);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      })
  );
}

export async function putCachedMedia(id: string, blob: Blob): Promise<void> {
  try {
    await run("readwrite", (s) => s.put({ id, blob, cachedAtMs: Date.now() }));
  } catch {
    // A full quota must not break sending or receiving; the cache is an
    // optimisation everywhere except restore, which reports its own failures.
  }
}

export async function getCachedMedia(id: string): Promise<Blob | null> {
  try {
    const row = await run<{ blob: Blob } | undefined>("readonly", (s) => s.get(id));
    return row?.blob ?? null;
  } catch {
    return null;
  }
}

export async function cachedMediaIds(): Promise<string[]> {
  try {
    return (await run<string[]>("readonly", (s) => s.getAllKeys())) ?? [];
  } catch {
    return [];
  }
}
