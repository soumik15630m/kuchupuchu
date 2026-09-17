// Persistent storage for per-peer-device Double Ratchet state.
//
// Same constraint as identity-store.js: ratchet private keys are generated
// non-extractable, so the state cannot be JSON-serialised. It is
// structured-cloneable, which IndexedDB stores directly -- the browser keeps
// the key material and the page never sees it.
//
// Losing this is worse than losing a cache. The chain keys ARE the ability to
// read the peer's next message; a wiped ratchet means every message already
// in flight to this device is undecryptable and the session has to be rebuilt
// from a fresh X3DH. Every mutation is therefore written back immediately
// rather than batched.

const DB_NAME = "kuchupuchu-ratchets";
const DB_VERSION = 1;
const STORE = "sessions";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Sessions are keyed by peer DEVICE, not peer person: a member with two
 * devices has two independent ratchets, and a message encrypted for one
 * cannot be read by the other. */
export function sessionKey(peerEmail, peerDeviceId) {
  return `${peerEmail}|${peerDeviceId}`;
}

export async function loadRatchetState(key) {
  try {
    const db = await openDb();
    const state = await tx(db, "readonly", (s) => s.get(key));
    db.close();
    return state ?? null;
  } catch (err) {
    console.warn("ratchet-store: load failed, treating as absent", err);
    return null;
  }
}

export async function saveRatchetState(key, state) {
  try {
    const db = await openDb();
    await tx(db, "readwrite", (s) => s.put(state, key));
    db.close();
    return true;
  } catch (err) {
    console.warn("ratchet-store: save failed", err);
    return false;
  }
}

export async function deleteRatchetState(key) {
  try {
    const db = await openDb();
    await tx(db, "readwrite", (s) => s.delete(key));
    db.close();
  } catch {
    // Nothing to do; a stale session is replaced on next use anyway.
  }
}

export async function listSessionKeys() {
  try {
    const db = await openDb();
    const keys = await tx(db, "readonly", (s) => s.getAllKeys());
    db.close();
    return keys ?? [];
  } catch {
    return [];
  }
}
