// §6/§13 Phase 4: bridges our rotation-derived room key into LiveKit's
// own frame encryption.
//
// Deliberately not reimplementing SFrame here. livekit-client ships a
// production Insertable-Streams frame cryptor behind setE2EEEnabled()
// and a pluggable KeyProvider. What is ours is everything upstream:
// X3DH, the pairwise ratchet, and group rotation -- the key provider
// only ever sees the final symmetric key.
//
// Uses the `LivekitClient` global from index.html's SRI-pinned script
// tag; a second CDN import would duplicate the SDK and sidestep SRI.
//
// The cryptor runs in a Worker, and `new Worker(url)` refuses a
// cross-origin URL outright -- there is no `crossorigin` opt-in the
// way <script> has one, regardless of CORS headers. So: fetch the
// script, wrap it in a same-origin blob: URL, construct from that.
//
// Neither Worker nor fetch has an `integrity` option, so the check is
// done by hand below. Not optional hardening: the worker IS the frame
// cryptor, so a substituted script disables media encryption while
// every fingerprint and safety number in the UI still matches.
//
// E2EE_WORKER_SCRIPT_SRI must move in lockstep with the URL and the
// <script> tag in index.html. Regenerate with:
//   curl -sS <url> | openssl dgst -sha384 -binary | openssl base64 -A
const E2EE_WORKER_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/livekit-client@2.22.2/dist/livekit-client.e2ee.worker.js";
const E2EE_WORKER_SCRIPT_SRI = "sha384-HJiTE5/L7X1kGq7Nhi5s/hs6nu1RZy5nCMnOWeJX8L8sdaRcX7OMdTxR5O2hrsB7";

function bytesToBase64(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function createE2eeWorker() {
  const res = await fetch(E2EE_WORKER_SCRIPT_URL);
  if (!res.ok) throw new Error(`failed to fetch E2EE worker script: ${res.status}`);
  // Hash the raw bytes, not the decoded text -- re-encoding a decoded
  // string is not guaranteed to reproduce the exact bytes the server
  // sent, which would make the digest compare something subtly
  // different from what actually runs.
  const scriptBytes = await res.arrayBuffer();
  const digest = bytesToBase64(await crypto.subtle.digest("SHA-384", scriptBytes));
  if (`sha384-${digest}` !== E2EE_WORKER_SCRIPT_SRI) {
    throw new Error(
      "E2EE worker script failed its integrity check -- refusing to run it. " +
        `Expected ${E2EE_WORKER_SCRIPT_SRI}, got sha384-${digest}. ` +
        "Either the pinned version was bumped without updating E2EE_WORKER_SCRIPT_SRI, " +
        "or the script was tampered with in transit."
    );
  }

  const blobUrl = URL.createObjectURL(new Blob([scriptBytes], { type: "application/javascript" }));
  try {
    return new Worker(blobUrl);
  } finally {
    // The Worker has already read the blob synchronously during
    // construction -- revoking immediately after is safe and avoids
    // leaking the object URL for the lifetime of the page.
    URL.revokeObjectURL(blobUrl);
  }
}

const { BaseKeyProvider } = LivekitClient;

export class GroupKeyProvider extends BaseKeyProvider {
  static KEYRING_SIZE = 4;

  constructor() {
    super({
      sharedKey: true,
      // We do our own explicit, event-driven rotation (join/leave, per
      // §6.1) -- LiveKit's built-in periodic auto-ratchet would be a
      // second, uncoordinated key-evolution mechanism layered on top of
      // ours for no benefit, so it's turned off here.
      ratchetWindowSize: 0,
      // Must be -1 (never give up) whenever ratchetWindowSize is 0, which
      // is why livekit-client's own ExternalE2EEKeyProvider sets exactly
      // this pair. The default of 10 means a cryptor permanently marks a
      // participant's key invalid after 10 consecutive failures -- and
      // consecutive failures are *expected* here during the window
      // between a peer joining and their room key being distributed.
      failureTolerance: -1,
      // The room key is 256 bits (see group-e2ee.js's _rotate); LiveKit's
      // default derives a 128-bit AES-GCM key from it, silently throwing
      // away half the strength we generate.
      keySize: 256,
      keyringSize: GroupKeyProvider.KEYRING_SIZE,
    });
  }

  /** Applies a freshly-rotated room key. `keyIndex` should be the same
   * generation counter group-e2ee.js's rotation protocol uses, so a
   * frame encrypted under generation N is never misinterpreted as
   * belonging to generation N-1 or N+1 on the receiving end.
   *
   * `participantIdentities` -- registers the SAME key explicitly under
   * every known participant identity, INCLUDING YOUR OWN. Confirmed
   * empirically, not just theorized: an earlier version only registered
   * the key for `undefined` plus other peers, which produced this exact
   * real error from LiveKit's own encoder -- `MissingKey: key set not
   * found for dev-a at index 0`, reported by dev-a's own client, for
   * dev-a's own identity. The local encoder (encrypting what THIS client
   * sends) looks up its key by its own identity specifically, same as a
   * remote decoder does for each sender -- `sharedKey: true` and the
   * `undefined`-identity call do not cover that on their own. Callers of
   * this method (group-e2ee.js) must include their own identity in
   * `participantIdentities`, not just "everyone else".
   *
   * `keyBytes` is raw key material, but `onSetEncryptionKey` does NOT
   * accept raw bytes -- it requires an already-imported HKDF `CryptoKey`,
   * and it neither imports nor validates what it's handed. The bytes are
   * structured-cloned all the way into the frame-cryptor worker before
   * anything notices, where `deriveKeys` does `material.algorithm.name`
   * and throws `TypeError: Cannot read properties of undefined` on a
   * Uint8Array -- *before* the keyring is written. The keyring therefore
   * stays empty and every subsequent frame fails with a `MissingKey`
   * CryptorError naming an identity that was, apparently, registered
   * correctly. That indirection is why this cost several rounds of
   * plausible-but-wrong fixes (registering more identities, reordering
   * E2EE setup against media publish) before the real cause turned up:
   * the error surfaces at frame time, three layers away from the actual
   * mistake, and the worker re-wraps it as a plain Error before
   * postMessage, so no amount of inspecting the EncryptionError object
   * could have pointed here. livekit-client's own
   * ExternalE2EEKeyProvider.setKey() does this same import first; this is
   * that step, not an extra precaution. */
  async applyRoomKey(keyBytes, generation, participantIdentities = []) {
    const keyIndex = generation % GroupKeyProvider.KEYRING_SIZE;
    const material = await crypto.subtle.importKey("raw", keyBytes, "HKDF", false, [
      "deriveBits",
      "deriveKey",
    ]);
    await this.onSetEncryptionKey(material, undefined, keyIndex);
    for (const identity of participantIdentities) {
      await this.onSetEncryptionKey(material, identity, keyIndex);
    }
  }
}
