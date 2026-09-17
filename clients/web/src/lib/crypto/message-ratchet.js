// §6/§10.4/§13 Phase 6: the bidirectional Double Ratchet for messages.
//
// double-ratchet.js deliberately implements only a single advancing hash
// chain, because delivering one room key per rotation is all a call needs.
// Its header says a genuine bidirectional ratchet would be new code
// against the same X3DH session rather than a retrofit -- this is that
// code. Messages interleave arbitrarily, arrive out of order, and arrive
// after arbitrary offline gaps, none of which a generation-indexed chain
// handles.
//
// Follows the Double Ratchet spec directly:
//   https://www.signal.org/docs/specifications/doubleratchet/
// KDF_RK is kdfRootStep from double-ratchet.js -- reused rather than
// reimplemented so both layers share one root-KDF construction.
//
// Private keys are generated non-extractable, so ratchet state cannot be
// JSON-serialised. It is structured-cloneable, which is what IndexedDB
// stores -- see ratchet-store.js. Never try to export these.

import { kdfRootStep } from "./double-ratchet.js";
import { base64Encode, base64Decode } from "./signal-crypto.js";

// Bounds how many message keys a single header may force us to derive and
// retain. Without it, a peer claiming N = 2^31 makes the recipient burn
// memory and CPU deriving keys for messages that never existed.
export const MAX_SKIP = 1000;

// How many skipped keys are retained overall before the oldest are dropped.
// A message whose key has been evicted is undecryptable, which is the
// correct trade against unbounded growth from a peer that never delivers.
export const MAX_SKIPPED_KEYS = 2000;

async function hmacSha256(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", key, messageBytes);
}

/** KDF_CK (spec §5.2): fixed single-byte constants as HMAC input. */
async function kdfChainStep(chainKey) {
  const nextChainKey = await hmacSha256(chainKey, new Uint8Array([0x02]));
  const messageKey = await hmacSha256(chainKey, new Uint8Array([0x01]));
  return { nextChainKey, messageKey };
}

async function generateDh() {
  return crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
}

async function dh(privateKey, publicKeyRaw) {
  const publicKey = await crypto.subtle.importKey("raw", publicKeyRaw, { name: "X25519" }, true, []);
  return crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256);
}

async function exportRaw(publicKey) {
  return crypto.subtle.exportKey("raw", publicKey);
}

const GCM_IV_BYTES = 12;

async function encrypt(messageKey, plaintext, associatedData) {
  const key = await crypto.subtle.importKey("raw", messageKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData },
    key,
    plaintext
  );
  return { iv, ciphertext };
}

async function decrypt(messageKey, iv, ciphertext, associatedData) {
  const key = await crypto.subtle.importKey("raw", messageKey, { name: "AES-GCM" }, false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: associatedData }, key, ciphertext);
}

/** The header is authenticated, not encrypted: it travels as associated
 * data so a tampered dh/n/pn fails the AEAD rather than silently steering
 * the receiver's ratchet. (Header encryption is a separate spec variant
 * this does not implement; the fields it exposes are ratchet metadata, not
 * message content.) */
function headerBytes(header, associatedData) {
  const encoded = new TextEncoder().encode(
    `${header.dh}|${header.pn}|${header.n}`
  );
  const ad = new Uint8Array(associatedData);
  const out = new Uint8Array(ad.byteLength + encoded.byteLength);
  out.set(ad, 0);
  out.set(encoded, ad.byteLength);
  return out;
}

function skippedKey(dhB64, n) {
  return `${dhB64}|${n}`;
}

export class MessageRatchet {
  constructor(state) {
    this.state = state;
  }

  /** Initiator (Alice): already knows the responder's ratchet public key,
   * which is their signed prekey -- exactly as the spec's X3DH
   * integration specifies. */
  static async initSender(sharedSecret, theirRatchetPublicKeyRaw, associatedData) {
    const dhs = await generateDh();
    const { rootKey, chainKey } = await kdfRootStep(
      sharedSecret,
      await dh(dhs.privateKey, theirRatchetPublicKeyRaw)
    );
    return new MessageRatchet({
      dhs,
      dhrRaw: theirRatchetPublicKeyRaw,
      rootKey,
      cks: chainKey,
      ckr: null,
      ns: 0,
      nr: 0,
      pn: 0,
      skipped: new Map(),
      associatedData,
    });
  }

  /** Responder (Bob): starts with no sending chain. It is created on the
   * first DH ratchet step, triggered by the initiator's first message. */
  static async initReceiver(sharedSecret, ownRatchetKeyPair, associatedData) {
    return new MessageRatchet({
      dhs: ownRatchetKeyPair,
      dhrRaw: null,
      rootKey: sharedSecret,
      cks: null,
      ckr: null,
      ns: 0,
      nr: 0,
      pn: 0,
      skipped: new Map(),
      associatedData,
    });
  }

  async encrypt(plaintextBytes) {
    const s = this.state;
    if (!s.cks) {
      throw new Error(
        "ratchet has no sending chain yet -- the responder must receive one message before it can send"
      );
    }
    const { nextChainKey, messageKey } = await kdfChainStep(s.cks);
    s.cks = nextChainKey;

    const header = {
      dh: base64Encode(await exportRaw(s.dhs.publicKey)),
      pn: s.pn,
      n: s.ns,
    };
    s.ns += 1;

    const { iv, ciphertext } = await encrypt(
      messageKey,
      plaintextBytes,
      headerBytes(header, s.associatedData)
    );
    return {
      header,
      iv: base64Encode(iv),
      ciphertext: base64Encode(ciphertext),
    };
  }

  async decrypt(message) {
    const s = this.state;
    const { header } = message;
    const iv = base64Decode(message.iv);
    const ciphertext = base64Decode(message.ciphertext);
    const ad = headerBytes(header, s.associatedData);

    const skippedId = skippedKey(header.dh, header.n);
    const stored = s.skipped.get(skippedId);
    if (stored) {
      const plaintext = await decrypt(stored, iv, ciphertext, ad);
      // Only drop the key once the AEAD has actually accepted it, so a
      // forged message cannot delete the key the real one still needs.
      s.skipped.delete(skippedId);
      return plaintext;
    }

    const currentDhr = s.dhrRaw ? base64Encode(s.dhrRaw) : null;
    if (header.dh !== currentDhr) {
      await this._skipMessageKeys(header.pn);
      await this._dhRatchet(header);
    }
    await this._skipMessageKeys(header.n);

    if (!s.ckr) throw new Error("ratchet has no receiving chain for this message");
    const { nextChainKey, messageKey } = await kdfChainStep(s.ckr);
    s.ckr = nextChainKey;
    s.nr += 1;

    return decrypt(messageKey, iv, ciphertext, ad);
  }

  async _skipMessageKeys(until) {
    const s = this.state;
    if (!s.ckr) return;
    if (until - s.nr > MAX_SKIP) {
      throw new Error(`message claims to skip more than ${MAX_SKIP} messages -- refusing`);
    }
    const dhB64 = base64Encode(s.dhrRaw);
    while (s.nr < until) {
      const { nextChainKey, messageKey } = await kdfChainStep(s.ckr);
      s.ckr = nextChainKey;
      s.skipped.set(skippedKey(dhB64, s.nr), messageKey);
      s.nr += 1;
    }
    while (s.skipped.size > MAX_SKIPPED_KEYS) {
      s.skipped.delete(s.skipped.keys().next().value);
    }
  }

  async _dhRatchet(header) {
    const s = this.state;
    s.pn = s.ns;
    s.ns = 0;
    s.nr = 0;
    s.dhrRaw = base64Decode(header.dh);

    const recv = await kdfRootStep(s.rootKey, await dh(s.dhs.privateKey, s.dhrRaw));
    s.rootKey = recv.rootKey;
    s.ckr = recv.chainKey;

    s.dhs = await generateDh();
    const send = await kdfRootStep(s.rootKey, await dh(s.dhs.privateKey, s.dhrRaw));
    s.rootKey = send.rootKey;
    s.cks = send.chainKey;
  }
}
