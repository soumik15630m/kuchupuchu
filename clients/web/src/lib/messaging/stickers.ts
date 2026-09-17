/** Stickers without shipping a sticker pack: the user saves their own images,
 * held locally as blobs and sent as a `sticker` message, which renders without
 * a bubble the way a sticker should. Gboard's sticker API (§10.5) is an
 * Android keyboard feature with no web equivalent, so the web client gives the
 * user their own set instead of pretending to have one. */

const DB_NAME = "kuchupuchu-stickers";
const DB_VERSION = 1;
const STORE = "stickers";

export interface Sticker {
  id: string;
  blob: Blob;
  addedAtMs: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | void): Promise<T> {
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

export async function listStickers(): Promise<Sticker[]> {
  const all = (await run<Sticker[]>("readonly", (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.addedAtMs - a.addedAtMs);
}

export async function addSticker(blob: Blob): Promise<Sticker> {
  const sticker: Sticker = { id: crypto.randomUUID(), blob, addedAtMs: Date.now() };
  await run("readwrite", (s) => s.put(sticker));
  return sticker;
}

export async function removeSticker(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

/** Trims to a sticker-sized square and keeps PNG so transparency survives —
 * re-encoding to JPEG would put a white box behind every sticker. */
export async function normalizeSticker(file: File, maxEdge = 512): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), "image/png"));
}
