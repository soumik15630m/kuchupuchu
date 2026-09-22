/** The backup key held on this device so a scheduled backup can run.
 *
 * An automatic backup cannot stop and ask for a passphrase, so the derived
 * key is kept here. It is stored **non-extractable**: structured-cloned into
 * IndexedDB as a CryptoKey, which means script on this origin can encrypt
 * with it but cannot read its bytes out. The passphrase itself is never
 * stored anywhere, so restoring on another device still requires the member
 * to know it.
 *
 * Turning the schedule off deletes this, which is the difference between
 * "stopped" and "paused": with no key on disk, nothing can produce a backup
 * until someone types the passphrase again.
 */
import { openStore } from "../idb";

import { deriveBackupKey, newBackupSalt, PBKDF2_ITERATIONS } from "./envelope.mjs";

const DB_NAME = "kuchupuchu-backup-key";
const DB_VERSION = 1;
const STORE = "credential";
const ROW = "current";

export interface BackupCredential {
  id: string;
  key: CryptoKey;
  salt: Uint8Array;
  iterations: number;
  createdAtMs: number;
}

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

/** Derives and stores the key for `passphrase`, replacing any previous one.
 * A fresh salt is minted here, so changing the passphrase invalidates the
 * stored key rather than leaving a stale one that seals with the old one. */
export async function rememberPassphrase(passphrase: string): Promise<BackupCredential> {
  const salt = newBackupSalt();
  const key = await deriveBackupKey(passphrase, salt, PBKDF2_ITERATIONS);
  const credential: BackupCredential = {
    id: ROW,
    key,
    salt,
    iterations: PBKDF2_ITERATIONS,
    createdAtMs: Date.now(),
  };
  await run("readwrite", (s) => s.put(credential));
  return credential;
}

export async function storedCredential(): Promise<BackupCredential | null> {
  try {
    return (await run<BackupCredential | undefined>("readonly", (s) => s.get(ROW))) ?? null;
  } catch {
    return null;
  }
}

export async function forgetPassphrase(): Promise<void> {
  try {
    await run("readwrite", (s) => s.delete(ROW));
  } catch {
    // Nothing to delete is the same outcome as deleting it.
  }
}
