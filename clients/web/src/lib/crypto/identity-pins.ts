/** Trust-on-first-use pinning for peer identity keys.
 *
 * signal-crypto.js's own notes call this out as the gap the harness could not
 * close: a safety number you verified today guarantees nothing about tomorrow
 * unless the key it was derived from is remembered. Without a pin, a server
 * that substitutes identity material simply produces a new safety number and
 * nothing anywhere says it changed.
 *
 * The pin is per (peer, device): a member's second device is a new identity,
 * not a changed one, and conflating the two would cry wolf every time someone
 * adds a laptop.
 */
import { openStore } from "../idb";

const DB_NAME = "kuchupuchu-identity-pins";
const DB_VERSION = 1;
const STORE = "pins";

export interface IdentityPin {
  key: string;
  peerEmail: string;
  peerDeviceId: string;
  /** Base64 Ed25519 identity key this device was first seen with. */
  identityKey: string;
  safetyNumber: string;
  firstSeenAtMs: number;
  /** Set once the user has explicitly acknowledged a change. */
  acknowledgedAtMs?: number;
}

function pinKey(peerEmail: string, peerDeviceId: string): string {
  return `${peerEmail}|${peerDeviceId}`;
}

function openDb(): Promise<IDBDatabase> {
  return openStore(DB_NAME, DB_VERSION, STORE, (db) => {
    if (db.objectStoreNames.contains(STORE)) return;
    db.createObjectStore(STORE, { keyPath: "key" });
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve((req ? (req as IDBRequest).result : undefined) as T);
        t.onerror = () => reject(t.error);
      })
  );
}

export type PinVerdict =
  | { status: "first-seen"; pin: IdentityPin }
  | { status: "unchanged"; pin: IdentityPin }
  | { status: "changed"; pin: IdentityPin; previous: IdentityPin };

/** Records the key this device is presenting and reports whether it differs
 * from what was pinned. A change is never auto-accepted silently — it is
 * stored, but reported so the UI can say so. */
export async function checkAndPin(
  peerEmail: string,
  peerDeviceId: string,
  identityKey: string,
  safetyNumber: string
): Promise<PinVerdict> {
  const key = pinKey(peerEmail, peerDeviceId);
  const existing = (await run<IdentityPin | undefined>("readonly", (s) => s.get(key))) ?? null;

  const pin: IdentityPin = {
    key,
    peerEmail,
    peerDeviceId,
    identityKey,
    safetyNumber,
    firstSeenAtMs: existing?.firstSeenAtMs ?? Date.now(),
  };

  if (!existing) {
    await run("readwrite", (s) => s.put(pin));
    return { status: "first-seen", pin };
  }

  if (existing.identityKey === identityKey) {
    return { status: "unchanged", pin: existing };
  }

  // The new key is pinned so the warning fires once rather than on every
  // message, but `acknowledgedAtMs` stays unset until the user confirms.
  await run("readwrite", (s) => s.put(pin));
  return { status: "changed", pin, previous: existing };
}

export async function acknowledgePin(peerEmail: string, peerDeviceId: string): Promise<void> {
  const key = pinKey(peerEmail, peerDeviceId);
  const existing = await run<IdentityPin | undefined>("readonly", (s) => s.get(key));
  if (!existing) return;
  await run("readwrite", (s) => s.put({ ...existing, acknowledgedAtMs: Date.now() }));
}

export async function pinsFor(peerEmail: string): Promise<IdentityPin[]> {
  const all = (await run<IdentityPin[]>("readonly", (s) => s.getAll())) ?? [];
  return all.filter((p) => p.peerEmail === peerEmail);
}

export async function forgetPins(peerEmail: string): Promise<void> {
  for (const pin of await pinsFor(peerEmail)) {
    await run("readwrite", (s) => s.delete(pin.key));
  }
}
