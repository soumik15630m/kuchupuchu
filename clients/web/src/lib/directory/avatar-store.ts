import type { MediaRef } from "../messaging/store";
import { openStore } from "../idb";

/** Peer avatars, learned from encrypted profile broadcasts.
 *
 * The ref carries the blob's decryption key, which is exactly why it is not
 * stored on the server alongside the profile: the directory is plaintext to
 * the server, and putting the key there would let it decrypt every member's
 * photo. Broadcasting it through the encrypted fan-out keeps the server
 * holding ciphertext only.
 */
const DB_NAME = "kuchupuchu-avatars";
const DB_VERSION = 1;
const STORE = "avatars";

export interface AvatarRecord {
  email: string;
  media: MediaRef;
  updatedAtMs: number;
  /** Cached decrypted bytes, so the list does not re-fetch on every render. */
  blob?: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return openStore(DB_NAME, DB_VERSION, STORE, (db) => {
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "email" });
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | void): Promise<T> {
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

export async function putAvatar(record: AvatarRecord): Promise<void> {
  await run("readwrite", (s) => s.put(record));
}

export async function getAvatar(email: string): Promise<AvatarRecord | null> {
  try {
    return (await run<AvatarRecord | undefined>("readonly", (s) => s.get(email))) ?? null;
  } catch {
    return null;
  }
}

export async function allAvatars(): Promise<AvatarRecord[]> {
  try {
    return (await run<AvatarRecord[]>("readonly", (s) => s.getAll())) ?? [];
  } catch {
    return [];
  }
}

export async function deleteAvatar(email: string): Promise<void> {
  try {
    await run("readwrite", (s) => s.delete(email));
  } catch {
    // Cosmetic; a stale avatar is replaced on the next broadcast.
  }
}
