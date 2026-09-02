// §6/§6.1/§13 Phase 4: what happens after X3DH gives two devices a shared
// secret.
//
// Scoping note, stated honestly up front rather than glossed over: this
// is NOT a full bidirectional per-message Double Ratchet like Signal
// uses for text messaging (that's Phase 6's problem, once real messages
// with arbitrary send/receive interleaving exist). What Phase 4 actually
// needs, per design-doc-v6 §6/§6.1, is narrower:
//
//   - A 1:1 call uses the X3DH-derived secret (put through one KDF step,
//     see initTransportChain) directly as the SFrame key.
//   - A group call needs a separate, freshly-random ROOM key, generated
//     by whichever participant §6.1 deterministically elects, and
//     delivered to every other participant individually -- encrypted
//     under that pair's transport chain -- over LiveKit's data channel.
//     That delivery is the only traffic this module's ratchet ever
//     carries; it is not a general-purpose encrypted-messaging channel.
//
// Given that traffic pattern (low-volume, one AEAD-sealed blob per
// rotation event, indexed by an agreed generation number rather than
// strict send/receive turn-taking), a single advancing hash chain
// indexed by generation number is the right level of complexity: it
// gives real forward secrecy across rotations (an old chain key is
// discarded the moment a newer generation is derived, so compromising
// memory after rotation N cannot recover the room key from rotation
// N-1) without building out full asymmetric sending/receiving chains
// that this traffic pattern has no use for. If Phase 6 messaging later
// needs genuine bidirectional Double Ratchet, that's new code against
// the same X3DH session -- not a retrofit of this module.

function toHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, messageBytes);
}

async function hkdfSha256(ikm, salt, info, outputBytes = 64) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
    key,
    outputBytes * 8
  );
}

/** One Double-Ratchet-style root KDF step (spec §5.2): given the current
 * root key and a fresh DH output, derives a new root key and a chain key
 * from a single HKDF call, using the root key as salt (not as info --
 * that ordering matters for matching the spec's construction). Used
 * once here, at session bootstrap (see initTransportChain) -- X3DH's DH3
 * term (EKa · SPKb) is exactly the DH output the Double Ratchet spec
 * recommends reusing to seed the first chain, so no extra round trip is
 * needed to get from "X3DH secret" to "usable chain key". */
export async function kdfRootStep(rootKey, dhOutput) {
  const output = await hkdfSha256(dhOutput, rootKey, "kuchupuchu-dr-root", 64);
  const bytes = new Uint8Array(output);
  return { rootKey: bytes.slice(0, 32).buffer, chainKey: bytes.slice(32, 64).buffer };
}

/** Chain KDF step (spec §5.2): derives the next chain key and a message
 * key from the current chain key, using fixed single-byte constants as
 * HMAC input -- the standard construction, not something invented here. */
async function kdfChainStep(chainKey) {
  const nextChainKey = await hmacSha256(chainKey, new Uint8Array([0x02]));
  const messageKey = await hmacSha256(chainKey, new Uint8Array([0x01]));
  return { nextChainKey, messageKey };
}

/** A single advancing hash chain, indexed by generation number. Walking
 * forward to a higher index derives and discards every intermediate
 * chain key -- only the current one is ever kept in memory -- which is
 * where the forward secrecy comes from. Walking "backward" (asking for
 * an index below the current one) is refused rather than silently
 * returning a stale key; see this module's header comment for why that
 * case is expected to be rare and handled by §6.1's mismatch/rejoin flow
 * rather than by this class trying to be clever about reordering. */
export class TransportChain {
  constructor(initialChainKey) {
    this._chainKey = initialChainKey;
    this._index = 0;
  }

  get currentIndex() {
    return this._index;
  }

  /** Returns the 32-byte message key for `targetIndex`, advancing the
   * chain forward (and discarding prior chain keys) as needed. */
  async keyForGeneration(targetIndex) {
    if (targetIndex < this._index) {
      throw new Error(
        `chain already advanced past generation ${targetIndex} (currently at ${this._index}) -- ` +
          "cannot derive a discarded key; the caller should treat this as a rejoin-worthy desync"
      );
    }
    while (this._index < targetIndex) {
      const { nextChainKey } = await kdfChainStep(this._chainKey);
      this._chainKey = nextChainKey;
      this._index++;
    }
    const { messageKey } = await kdfChainStep(this._chainKey);
    return messageKey;
  }
}

/** Bootstraps the pairwise transport chain from an X3DH session. Both
 * sides call this with the same `sharedSecret` and `bootstrapDh` (the
 * DH3 term X3DH already computed -- see signal-crypto.js's
 * `initiateSession`/`respondToSession`, which both return it as
 * `bootstrapDh`) and arrive at the identical initial chain key, with no
 * extra network round trip needed to agree on it. */
export async function initTransportChain(sharedSecret, bootstrapDh) {
  const { chainKey } = await kdfRootStep(sharedSecret, bootstrapDh);
  return new TransportChain(chainKey);
}

/** SHA-256 fingerprint, truncated to the first 4 hex characters -- §6.1's
 * exact definition, used to display/compare room-key agreement in the
 * call UI. */
export async function fingerprint(keyBytes) {
  const digest = await crypto.subtle.digest("SHA-256", keyBytes);
  return toHex(digest).slice(0, 4);
}

const GCM_IV_BYTES = 12;

/** AES-256-GCM seal/open for the one thing this module's chain keys are
 * ever used to protect: a room-key-rotation blob addressed to one peer.
 * Each call generates a fresh random IV -- safe because each message key
 * this is used with is itself single-use (see TransportChain above), so
 * there's no key/IV pair ever reused across two different plaintexts. */
export async function seal(keyBytes, plaintextBytes, associatedData) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: associatedData }, key, plaintextBytes);
  return { iv, ciphertext };
}

export async function open(keyBytes, iv, ciphertext, associatedData) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: associatedData }, key, ciphertext);
}
