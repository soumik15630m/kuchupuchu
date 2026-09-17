// §4/§9: persistent storage for a device's long-term crypto identity.
//
// Why this has to exist, rather than keeping the identity in a module
// variable as this harness used to:
//
// A device's Ed25519 identity key is write-once server side. prekeys.py
// refuses to replace one with a different key (409
// IdentityKeyMismatchError) because §9's safety-number story depends on
// it being stable for the device's lifetime -- a key that can be swapped
// silently under a device id is a key that proves nothing. The
// consequence is that losing the identity is unrecoverable for that
// device id: every later `POST /prekeys/me` 409s, and E2EE can never be
// established again under that id.
//
// With the identity held only in memory, an ordinary page reload was
// enough to trigger exactly that. Observed in real testing as an endless
// `MissingKey: key set not found` stream with the fingerprint stuck on
// "not connected" -- a device permanently locked out of encryption by
// pressing F5.
//
// IndexedDB rather than localStorage because CryptoKey objects are
// structured-cloneable but not serialisable: the private keys here are
// generated non-extractable (see signal-crypto.js's generateIdentity), so
// there is no way to JSON them, and no reason to want one. Storing the
// CryptoKey itself keeps the private key unexportable while surviving a
// reload -- the browser holds the key material, the page never sees it.
//
// Phase 5's real client needs the same property. This is not harness
// scaffolding; it is the minimum behaviour a device identity requires.

const DB_NAME = "kuchupuchu-e2ee";
const DB_VERSION = 1;
const STORE = "identities";

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
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** The stored identity for `deviceId`, or null if this device has never
 * generated one (or storage was cleared). */
export async function loadIdentity(deviceId) {
  try {
    const db = await openDb();
    const stored = await tx(db, "readonly", (s) => s.get(deviceId));
    db.close();
    return stored ?? null;
  } catch (err) {
    // Private browsing, disabled storage, a corrupt DB -- all mean "no
    // identity available", which the caller already handles by
    // generating a fresh one. Never let a storage failure take down the
    // call path.
    console.warn("identity-store: load failed, treating as absent", err);
    return null;
  }
}

/** Persists `identity` for `deviceId`. Must be called again after
 * anything that MUTATES the identity, not just on creation -- most
 * importantly after a one-time prekey is consumed. Persisting only at
 * creation would let a reload resurrect a prekey that has already been
 * used, which is precisely the replay the one-time prekey exists to
 * prevent (see respondToSession's forward-secrecy note). */
export async function saveIdentity(deviceId, identity) {
  try {
    const db = await openDb();
    await tx(db, "readwrite", (s) => s.put(identity, deviceId));
    db.close();
    return true;
  } catch (err) {
    console.warn("identity-store: save failed", err);
    return false;
  }
}

/** Forgets this device's identity. The server will still hold the old
 * identity key, so the NEXT publish under the same device id will 409 --
 * a new device id is required after calling this. Exposed because
 * "start completely fresh" is a thing you want while testing, and doing
 * it by hand in devtools is worse. */
export async function clearIdentity(deviceId) {
  try {
    const db = await openDb();
    await tx(db, "readwrite", (s) => s.delete(deviceId));
    db.close();
    return true;
  } catch (err) {
    console.warn("identity-store: clear failed", err);
    return false;
  }
}
