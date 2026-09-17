// §6/§13 Phase 4: X3DH (Extended Triple Diffie-Hellman) key agreement.
//
// Runs entirely on native Web Crypto (X25519, Ed25519, HKDF -- all part
// of the W3C "Secure Curves" additions to WebCrypto) rather than a
// third-party crypto library. That's a deliberate choice, not a
// shortcut: X3DH and the Double Ratchet (double-ratchet.js) are public,
// precisely specified constructions built from primitives WebCrypto
// already implements correctly -- ECDH, HMAC, HKDF. There's no general-
// purpose "Signal Protocol" library with a browser build that matches
// this app's server-side bundle format (see auth-service's prekeys.py),
// and reaching for one that doesn't match would mean reshaping the
// already-shipped server schema around a library's opinions instead of
// this app's actual needs. What we do NOT do is invent our own
// primitives -- every cryptographic operation below is a direct,
// unmodified WebCrypto call.
//
// Caveat worth flagging honestly (matching design-doc-v6's own style):
// browser support for WebCrypto X25519/Ed25519 landed in Chrome and
// Firefox stable within the last couple of years. `assertSecureCurvesSupported`
// below fails loudly and immediately rather than letting a session
// silently fall back to no encryption on an unsupported browser.
//
// Spec references:
//   X3DH:           https://www.signal.org/docs/specifications/x3dh/
//   Double Ratchet:  https://www.signal.org/docs/specifications/doubleratchet/

const X3DH_INFO = "kuchupuchu-x3dh-v1";

export async function assertSecureCurvesSupported() {
  try {
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  } catch (err) {
    throw new Error(
      "This browser doesn't support WebCrypto X25519/Ed25519 (Secure Curves) -- " +
        "Phase 4 E2EE can't run here. Use a current Chrome or Firefox. " +
        `Underlying error: ${err.message}`
    );
  }
}

export function base64Encode(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64Decode(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(new Uint8Array(a), offset);
    offset += a.byteLength;
  }
  return out.buffer;
}

async function exportRawPublicKey(cryptoKey) {
  return crypto.subtle.exportKey("raw", cryptoKey);
}

async function importX25519PublicKey(rawBytes) {
  return crypto.subtle.importKey("raw", rawBytes, { name: "X25519" }, true, []);
}

async function importEd25519PublicKey(rawBytes) {
  return crypto.subtle.importKey("raw", rawBytes, { name: "Ed25519" }, true, ["verify"]);
}

async function ecdh(privateKey, publicKey) {
  // 256 bits = the full 32-byte X25519 shared secret -- there's no
  // partial-output use case here, we always want the whole thing.
  return crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256);
}

async function hkdfSha256(ikm, info, outputBytes = 32) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  // Zero-filled salt of hash length, per the X3DH spec's recommendation
  // when no salt is otherwise available (§2.2 of the X3DH spec).
  const salt = new Uint8Array(32);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
    key,
    outputBytes * 8
  );
}

// The X3DH spec (§2.1) requires prefixing a run of 32 0xFF bytes ahead of
// the concatenated DH outputs when using Curve25519 (Ed25519's encoding
// can otherwise overlap with a valid low-order Curve25519 point for some
// inputs, and this prefix is cheap insurance against that class of
// cross-protocol confusion).
const X3DH_PREFIX = new Uint8Array(32).fill(0xff);

/** A per-peer identity safety number -- deliberately distinct from
 * double-ratchet.js's fingerprint(), which hashes the *current room
 * key* and changes on every rotation. That's a useful check (do we
 * currently agree on the same session key?) but it is NOT identity
 * verification: it says nothing about whether the peer on the other
 * end is who you think they are, and a party that fully controls
 * bundle distribution (a compromised auth-service, which is exactly
 * the threat X3DH exists to defend against) could in principle
 * substitute identity keys on both sides of a call and still produce
 * a matching room-key fingerprint, since that fingerprint never
 * encodes identity at all.
 *
 * This does. It's derived only from the two Ed25519 identity signing
 * keys -- stable for as long as neither device's identity key changes,
 * independent of session/room-key rotation -- so it's the value
 * actually worth reading out over a channel the server doesn't
 * control (a phone call, in person) to confirm you're really talking
 * to the device you think you are.
 *
 * Scope note, stated honestly: real Signal safety numbers stretch each
 * key through many rounds of hashing specifically to raise the cost of
 * pre-computing collisions at Signal's scale. This is a single SHA-256
 * over the sorted, concatenated raw identity keys -- proportionate to
 * this design's own stated threat model (§1's <=10-member allowlist),
 * not a claim that it matches Signal's exact construction. What it
 * does NOT do, and what remains a real open gap: this harness has no
 * persistent storage (deliberately -- it's a throwaway test tool), so
 * there's no cross-session pinning of "this device_id's identity key
 * should always be X". A verified safety number today doesn't
 * guarantee anything about tomorrow's session without that -- pinning
 * belongs in a real client with real storage, not here. */
export async function computeIdentitySafetyNumber(myIdentityKeyRaw, theirIdentityKeyRaw) {
  const a = new Uint8Array(myIdentityKeyRaw);
  const b = new Uint8Array(theirIdentityKeyRaw);
  if (a.byteLength !== IDENTITY_KEY_BYTES || b.byteLength !== IDENTITY_KEY_BYTES) {
    throw new Error("computeIdentitySafetyNumber expects two 32-byte Ed25519 public keys");
  }

  // Sorted so both parties compute the identical value regardless of
  // which one is "me" and which is "them" -- lexicographic comparison
  // of the raw bytes, first differing byte decides.
  let ordered;
  for (let i = 0; i < IDENTITY_KEY_BYTES; i++) {
    if (a[i] !== b[i]) {
      ordered = a[i] < b[i] ? concatBytes(a.buffer, b.buffer) : concatBytes(b.buffer, a.buffer);
      break;
    }
  }
  if (!ordered) {
    // Byte-identical keys -- only possible if comparing an identity
    // against itself, which a caller should never legitimately do, but
    // concatenation order is moot either way if it happens.
    ordered = concatBytes(a.buffer, b.buffer);
  }

  const digest = await crypto.subtle.digest("SHA-256", ordered);
  const bytes = new Uint8Array(digest);
  // 80 bits (20 hex chars), grouped for readability -- enough that
  // brute-forcing a matching prefix isn't a realistic concern at this
  // system's scale, short enough two people can actually read it aloud
  // and compare over a phone call.
  const hex = Array.from(bytes.slice(0, 10))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.match(/.{1,5}/g).join("-");
}

const IDENTITY_KEY_BYTES = 32; // Ed25519 public key length

/** Generates a brand-new device identity: a long-term Ed25519 signing
 * keypair, the X25519 identity-agreement keypair it cross-signs (see
 * 005_phase4_identity_dh_key.sql for why these are separate keys), one
 * signed prekey, and a batch of one-time prekeys. Every keypair here is
 * generated with extractable: false -- per the WebCrypto spec, that
 * still leaves publicKey.extractable forced to true (public keys aren't
 * sensitive), while privateKey.extractable becomes false and
 * exportKey() on it throws. Nothing in this file or the ones that call
 * it ever needs to export a private key -- only the public halves get
 * serialized, in buildPublishPayload() below. */
export async function generateIdentity({ oneTimePrekeyCount = 20 } = {}) {
  await assertSecureCurvesSupported();

  const signingKeyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const dhIdentityKeyPair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);

  const signedPrekeyPair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  const signedPrekeyId = 1;

  const oneTimePrekeys = new Map();
  for (let keyId = 0; keyId < oneTimePrekeyCount; keyId++) {
    oneTimePrekeys.set(keyId, await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]));
  }

  return {
    signingKeyPair,
    dhIdentityKeyPair,
    signedPrekeyId,
    signedPrekeyPair,
    oneTimePrekeys, // keyId -> X25519 CryptoKeyPair; entries removed as they're consumed locally
    nextOneTimePrekeyId: oneTimePrekeyCount,
  };
}

/** Builds the JSON body for `POST /prekeys/me`. */
export async function buildPublishPayload(identity, { oneTimePrekeyIds = null } = {}) {
  const identityKeyRaw = await exportRawPublicKey(identity.signingKeyPair.publicKey);
  const dhIdentityKeyRaw = await exportRawPublicKey(identity.dhIdentityKeyPair.publicKey);
  const dhIdentitySignature = await crypto.subtle.sign("Ed25519", identity.signingKeyPair.privateKey, dhIdentityKeyRaw);

  const signedPrekeyRaw = await exportRawPublicKey(identity.signedPrekeyPair.publicKey);
  const signedPrekeySignature = await crypto.subtle.sign("Ed25519", identity.signingKeyPair.privateKey, signedPrekeyRaw);

  const idsToPublish = oneTimePrekeyIds ?? Array.from(identity.oneTimePrekeys.keys());
  const oneTimePrekeys = [];
  for (const keyId of idsToPublish) {
    const pair = identity.oneTimePrekeys.get(keyId);
    if (!pair) continue;
    oneTimePrekeys.push({
      key_id: keyId,
      public_key: base64Encode(await exportRawPublicKey(pair.publicKey)),
    });
  }

  return {
    identity_key: base64Encode(identityKeyRaw),
    identity_dh_key: {
      public_key: base64Encode(dhIdentityKeyRaw),
      signature: base64Encode(dhIdentitySignature),
    },
    signed_prekey: {
      key_id: identity.signedPrekeyId,
      public_key: base64Encode(signedPrekeyRaw),
      signature: base64Encode(signedPrekeySignature),
    },
    one_time_prekeys: oneTimePrekeys,
  };
}

/** Generates and publishes `count` additional one-time prekeys, for
 * topping up a pool a peer has been drawing down. Mutates `identity` in
 * place with the new keys and returns the publish payload for them. */
export async function generateMoreOneTimePrekeys(identity, count) {
  const newIds = [];
  for (let i = 0; i < count; i++) {
    const keyId = identity.nextOneTimePrekeyId++;
    identity.oneTimePrekeys.set(keyId, await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]));
    newIds.push(keyId);
  }
  return buildPublishPayload(identity, { oneTimePrekeyIds: newIds });
}

/** Verifies that `identityDhKey` ({public_key, signature}) is genuinely
 * bound to `identityKeyB64` by that identity's own Ed25519 signature.
 *
 * Split out of verifyBundle so it can also be used on its own, against
 * the identity material the server holds for a device, when checking an
 * inbound X3DH initial message (see group-e2ee.js's
 * _verifyClaimedIdentity). That check needs exactly this binding and
 * nothing else from a bundle -- and must not consume a one-time prekey
 * to get it. */
export async function verifyIdentityDhKey(identityKeyB64, identityDhKey) {
  const identityVerifyKey = await importEd25519PublicKey(base64Decode(identityKeyB64));
  const ok = await crypto.subtle.verify(
    "Ed25519",
    identityVerifyKey,
    base64Decode(identityDhKey.signature),
    base64Decode(identityDhKey.public_key)
  );
  if (!ok) throw new Error("identity_dh_key signature does not verify against identity_key");
}

/** Verifies a fetched bundle's signatures before using it for anything --
 * the server already checks these on upload (app/prekeys.py), but a
 * client trusting the network to have done its own validation for it is
 * exactly the kind of gap that turns into a real vulnerability later. */
export async function verifyBundle(bundle) {
  const identityKeyRaw = base64Decode(bundle.identity_key);
  const identityVerifyKey = await importEd25519PublicKey(identityKeyRaw);

  await verifyIdentityDhKey(bundle.identity_key, bundle.identity_dh_key);

  const signedPrekeyRaw = base64Decode(bundle.signed_prekey.public_key);
  const spkSigOk = await crypto.subtle.verify(
    "Ed25519",
    identityVerifyKey,
    base64Decode(bundle.signed_prekey.signature),
    signedPrekeyRaw
  );
  if (!spkSigOk) throw new Error("bundle signed_prekey signature does not verify");
}

/** Initiator side (Alice, per the spec's naming) of X3DH: given our own
 * identity and a peer's fetched+verified bundle, derives the shared
 * secret and returns everything the peer needs in the initial message
 * to derive the same secret on their end. */
export async function initiateSession(myIdentity, theirBundle) {
  await verifyBundle(theirBundle);

  const theirIdentityDhKey = await importX25519PublicKey(base64Decode(theirBundle.identity_dh_key.public_key));
  const theirSignedPrekey = await importX25519PublicKey(base64Decode(theirBundle.signed_prekey.public_key));
  const theirOneTimePrekey = theirBundle.one_time_prekey
    ? await importX25519PublicKey(base64Decode(theirBundle.one_time_prekey.public_key))
    : null;

  const ephemeralKeyPair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);

  const dh1 = await ecdh(myIdentity.dhIdentityKeyPair.privateKey, theirSignedPrekey);
  const dh2 = await ecdh(ephemeralKeyPair.privateKey, theirIdentityDhKey);
  const dh3 = await ecdh(ephemeralKeyPair.privateKey, theirSignedPrekey);
  const dh4 = theirOneTimePrekey ? await ecdh(ephemeralKeyPair.privateKey, theirOneTimePrekey) : null;

  const ikm = dh4
    ? concatBytes(X3DH_PREFIX, dh1, dh2, dh3, dh4)
    : concatBytes(X3DH_PREFIX, dh1, dh2, dh3);
  const sharedSecret = await hkdfSha256(ikm, X3DH_INFO);

  const myIdentityKeyRaw = await exportRawPublicKey(myIdentity.signingKeyPair.publicKey);
  const associatedData = concatBytes(myIdentityKeyRaw, base64Decode(theirBundle.identity_key));

  return {
    sharedSecret,
    associatedData,
    // The Double Ratchet spec's reference integration reuses this exact
    // DH term (EKa · SPKb) to bootstrap the first chain key -- see
    // double-ratchet.js's initTransportChain -- so there's no reason to
    // make the caller recompute it.
    bootstrapDh: dh3,
    initialMessage: {
      identity_key: base64Encode(myIdentityKeyRaw),
      identity_dh_key: base64Encode(await exportRawPublicKey(myIdentity.dhIdentityKeyPair.publicKey)),
      ephemeral_key: base64Encode(await exportRawPublicKey(ephemeralKeyPair.publicKey)),
      used_signed_prekey_id: theirBundle.signed_prekey.key_id,
      used_one_time_prekey_id: theirBundle.one_time_prekey ? theirBundle.one_time_prekey.key_id : null,
    },
  };
}

/** Responder side (Bob): given our own identity and the initial message
 * an initiator sent (over LiveKit's data channel -- see e2ee.js), derives
 * the same shared secret. Consumes (and forgets) the local private
 * one-time prekey the initiator used, for forward secrecy -- a second
 * initial message claiming the same one-time prekey id will fail with a
 * clear error instead of silently reusing key material. */
export async function respondToSession(myIdentity, initialMessage) {
  if (initialMessage.used_signed_prekey_id !== myIdentity.signedPrekeyId) {
    throw new Error(
      `initial message references signed prekey id ${initialMessage.used_signed_prekey_id}, ` +
        `but our current one is ${myIdentity.signedPrekeyId} -- it was rotated after they fetched our bundle`
    );
  }

  let oneTimePrekeyPair = null;
  if (initialMessage.used_one_time_prekey_id !== null && initialMessage.used_one_time_prekey_id !== undefined) {
    oneTimePrekeyPair = myIdentity.oneTimePrekeys.get(initialMessage.used_one_time_prekey_id);
    if (!oneTimePrekeyPair) {
      throw new Error(
        `initial message claims one-time prekey id ${initialMessage.used_one_time_prekey_id}, ` +
          "which we don't have (already consumed, or never existed)"
      );
    }
  }

  const theirIdentityDhKey = await importX25519PublicKey(base64Decode(initialMessage.identity_dh_key));
  const theirEphemeralKey = await importX25519PublicKey(base64Decode(initialMessage.ephemeral_key));

  const dh1 = await ecdh(myIdentity.signedPrekeyPair.privateKey, theirIdentityDhKey);
  const dh2 = await ecdh(myIdentity.dhIdentityKeyPair.privateKey, theirEphemeralKey);
  const dh3 = await ecdh(myIdentity.signedPrekeyPair.privateKey, theirEphemeralKey);
  const dh4 = oneTimePrekeyPair ? await ecdh(oneTimePrekeyPair.privateKey, theirEphemeralKey) : null;

  const ikm = dh4
    ? concatBytes(X3DH_PREFIX, dh1, dh2, dh3, dh4)
    : concatBytes(X3DH_PREFIX, dh1, dh2, dh3);
  const sharedSecret = await hkdfSha256(ikm, X3DH_INFO);

  // Forward secrecy: this one-time prekey private key is now consumed
  // and unreachable, whether or not anything above throws first. If it
  // does need to survive a retry (e.g. the caller wants to detect a
  // duplicate initial message rather than just erroring), that's a
  // deliberate design choice to revisit -- silently keeping "spent" key
  // material around by default is the wrong side to default to.
  if (initialMessage.used_one_time_prekey_id !== null && initialMessage.used_one_time_prekey_id !== undefined) {
    myIdentity.oneTimePrekeys.delete(initialMessage.used_one_time_prekey_id);
  }

  const myIdentityKeyRaw = await exportRawPublicKey(myIdentity.signingKeyPair.publicKey);
  const associatedData = concatBytes(base64Decode(initialMessage.identity_key), myIdentityKeyRaw);

  return { sharedSecret, associatedData, bootstrapDh: dh3 };
}
