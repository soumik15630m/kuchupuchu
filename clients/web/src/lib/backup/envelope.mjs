/** The encrypted wrapper around a packed archive.
 *
 * The passphrase never leaves the device and the server stores only what this
 * produces, so a backup is restorable from nothing but the passphrase while
 * remaining unreadable to whoever holds the disk. That is the whole point of
 * the feature: history sync needs a second device to be online, and a member
 * with one device had no way back.
 *
 * Outer layout, all integers little-endian, header deliberately in the clear
 * so a future KDF change can be detected rather than guessed:
 *
 *   magic        6 bytes   "KPBKP1"
 *   u8           kdf id (1 = PBKDF2-SHA256)
 *   u32          iterations
 *   u8 + bytes   salt
 *   u8 + bytes   iv
 *   rest         AES-256-GCM ciphertext
 *
 * The salt and iv are not secret; publishing them costs nothing and makes the
 * file self-describing.
 */

export const ENVELOPE_MAGIC = "KPBKP1";
export const KDF_PBKDF2_SHA256 = 1;

/** OWASP's floor for PBKDF2-SHA256 as of 2023. Argon2id would be the better
 * choice and is what to move to when WebCrypto exposes it; it does not, and
 * shipping a JS implementation for a key this important is worse than a high
 * PBKDF2 count. The header records the count so old backups keep opening. */
export const PBKDF2_ITERATIONS = 600_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class BackupError extends Error {}

function subtle() {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new BackupError("this browser cannot encrypt backups");
  return c.subtle;
}

/** Derives the backup key. Exported because an automatic backup cannot ask
 * for a passphrase: the key is derived once when the schedule is turned on,
 * stored non-extractable, and reused. The salt is stored with it so the same
 * key is reproducible from the passphrase on another device at restore time.
 *
 * Reusing one salt across a member's own backups is deliberate and safe -- a
 * salt defends against precomputation across passwords, not across messages.
 * The IV is what must never repeat, and that is random per seal. */
export async function deriveBackupKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  return deriveKey(passphrase, salt, iterations);
}

export function newBackupSalt() {
  return globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

async function deriveKey(passphrase, salt, iterations) {
  const material = await subtle().importKey(
    "raw",
    encoder.encode(passphrase.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return subtle().deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * @param {Uint8Array} plaintext
 * @param {string} passphrase
 * @returns {Promise<Uint8Array>}
 */
export async function sealBackup(plaintext, passphrase, iterations = PBKDF2_ITERATIONS) {
  const salt = newBackupSalt();
  const key = await deriveKey(passphrase, salt, iterations);
  return sealBackupWithKey(plaintext, key, salt, iterations);
}

/**
 * @param {Uint8Array} plaintext
 * @param {CryptoKey} key       from deriveBackupKey
 * @param {Uint8Array} salt     the salt that key was derived from
 * @param {number} iterations
 * @returns {Promise<Uint8Array>}
 */
export async function sealBackupWithKey(plaintext, key, salt, iterations) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv }, key, plaintext)
  );

  const headerSize = ENVELOPE_MAGIC.length + 1 + 4 + 1 + salt.length + 1 + iv.length;
  const out = new Uint8Array(headerSize + ciphertext.length);
  const view = new DataView(out.buffer);

  let at = 0;
  out.set(encoder.encode(ENVELOPE_MAGIC), at);
  at += ENVELOPE_MAGIC.length;
  out[at++] = KDF_PBKDF2_SHA256;
  view.setUint32(at, iterations, true);
  at += 4;
  out[at++] = salt.length;
  out.set(salt, at);
  at += salt.length;
  out[at++] = iv.length;
  out.set(iv, at);
  at += iv.length;
  out.set(ciphertext, at);
  return out;
}

/** Reads the header without needing the passphrase, so the UI can say what a
 * file is before asking for one. */
export function readEnvelopeHeader(bytes) {
  if (bytes.length < ENVELOPE_MAGIC.length + 1 + 4 + 2) {
    throw new BackupError("that backup file is truncated");
  }
  if (decoder.decode(bytes.subarray(0, ENVELOPE_MAGIC.length)) !== ENVELOPE_MAGIC) {
    throw new BackupError("that does not look like a Kuchupuchu backup");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = ENVELOPE_MAGIC.length;
  const kdf = bytes[at++];
  if (kdf !== KDF_PBKDF2_SHA256) {
    throw new BackupError("that backup uses a key derivation this version does not know");
  }
  const iterations = view.getUint32(at, true);
  at += 4;
  const saltLength = bytes[at++];
  const salt = bytes.subarray(at, at + saltLength);
  at += saltLength;
  const ivLength = bytes[at++];
  const iv = bytes.subarray(at, at + ivLength);
  at += ivLength;
  if (at > bytes.length || salt.length !== saltLength || iv.length !== ivLength) {
    throw new BackupError("that backup file is truncated");
  }
  return { kdf, iterations, salt, iv, bodyOffset: at };
}

/**
 * @param {Uint8Array} bytes
 * @param {string} passphrase
 * @returns {Promise<Uint8Array>}
 */
export async function openBackup(bytes, passphrase) {
  const header = readEnvelopeHeader(bytes);
  const key = await deriveKey(passphrase, header.salt, header.iterations);
  try {
    const plaintext = await subtle().decrypt(
      { name: "AES-GCM", iv: header.iv },
      key,
      bytes.subarray(header.bodyOffset)
    );
    return new Uint8Array(plaintext);
  } catch {
    // GCM cannot distinguish a wrong passphrase from a tampered file, and
    // saying so would be a lie in one of the two cases.
    throw new BackupError("that passphrase did not open the backup, or the file is damaged");
  }
}
