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

/** Rough cap on the cache. Not a quota -- the browser owns that -- but a
 * ceiling that keeps one member's media library from filling the origin and
 * getting the *whole* app evicted. */
const MAX_CACHE_BYTES = 400 * 1024 * 1024;

export interface CacheUsage {
  files: number;
  bytes: number;
  persisted: boolean;
}

export async function cacheUsage(): Promise<CacheUsage> {
  try {
    const rows = await run<{ blob: Blob }[]>("readonly", (s) => s.getAll());
    const files = rows?.length ?? 0;
    const bytes = (rows ?? []).reduce((total, row) => total + (row.blob?.size ?? 0), 0);
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    return { files, bytes, persisted };
  } catch {
    return { files: 0, bytes: 0, persisted: false };
  }
}

/** Asks the browser not to evict this origin under storage pressure.
 *
 * Worth asking because after the server's seven-day retention the cache is
 * the only copy of restored media -- eviction would destroy history the
 * member believes they have. Chrome grants it silently for installed or
 * frequently-used origins and refuses otherwise; either way this is a
 * request, not a guarantee. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Evicts least-recently-cached blobs until the cache is back under the cap.
 *
 * Least-recently-*cached*, not least-recently-used: tracking reads would mean
 * a write on every render of every photo. The distinction costs little here,
 * where the cap is generous and the collection is small. */
export async function pruneCache(maxBytes = MAX_CACHE_BYTES): Promise<number> {
  try {
    const rows = await run<{ id: string; blob: Blob; cachedAtMs: number }[]>(
      "readonly",
      (s) => s.getAll()
    );
    if (!rows?.length) return 0;

    let total = rows.reduce((sum, row) => sum + (row.blob?.size ?? 0), 0);
    if (total <= maxBytes) return 0;

    const oldestFirst = [...rows].sort((a, b) => (a.cachedAtMs ?? 0) - (b.cachedAtMs ?? 0));
    const doomed: string[] = [];
    for (const row of oldestFirst) {
      if (total <= maxBytes) break;
      doomed.push(row.id);
      total -= row.blob?.size ?? 0;
    }
    if (doomed.length === 0) return 0;

    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      for (const id of doomed) store.delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    return doomed.length;
  } catch {
    return 0;
  }
}

export async function clearCache(): Promise<void> {
  try {
    await run("readwrite", (s) => s.clear());
  } catch {
    // Nothing to clear is the same outcome.
  }
}

export async function cachedMediaIds(): Promise<string[]> {
  try {
    return (await run<string[]>("readonly", (s) => s.getAllKeys())) ?? [];
  } catch {
    return [];
  }
}
