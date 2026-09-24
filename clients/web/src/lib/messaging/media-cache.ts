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
        // The connection is cached and shared; closing it here would make
        // every following operation reopen the database.
        t.oncomplete = () => resolve((req ? (req as IDBRequest).result : undefined) as T);
        t.onerror = () => reject(t.error);
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

/** Writes many blobs in one transaction. A restore used to open a
 * transaction per photo. */
export async function putCachedMediaBulk(
  items: { id: string; blob: Blob }[]
): Promise<void> {
  if (items.length === 0) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      const cachedAtMs = Date.now();
      for (const item of items) store.put({ id: item.id, blob: item.blob, cachedAtMs });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    // Quota, most likely. The messages still restored; media shows as
    // unavailable rather than the whole restore failing.
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

export async function deleteCachedMedia(id: string): Promise<void> {
  try {
    await run("readwrite", (s) => s.delete(id));
  } catch {
    // Best effort; the ref is gone either way, so the blob is unreachable.
  }
}

export async function cachedMediaIds(): Promise<string[]> {
  try {
    return (await run<string[]>("readonly", (s) => s.getAllKeys())) ?? [];
  } catch {
    return [];
  }
}
