// §6/§13 Phase 4: bridges our rotation-derived room key into LiveKit's
// own frame-encryption implementation.
//
// Deliberately NOT reimplementing SFrame/Insertable Streams here.
// livekit-client ships a production, already-in-use Insertable-Streams-
// based frame cryptor (AES-GCM, worker-based) behind `room.setE2EEEnabled()`
// and a pluggable `KeyProvider`. Reimplementing that by hand would mean
// less-reviewed code doing exactly what an existing, widely-deployed
// implementation already does -- see e.g. Element Call and other
// production LiveKit-based apps using this same extension point. What
// *is* ours is everything upstream of it: X3DH (signal-crypto.js), the
// pairwise transport chain (double-ratchet.js), and group room-key
// rotation (group-e2ee.js) -- LiveKit's key provider only ever sees the
// final symmetric key, never anything about how it was agreed on.
//
// Honesty note: this file's calls against `BaseKeyProvider` are written
// against livekit-client v2's documented JS API (constructor options
// `ratchetWindowSize`/`sharedKey`/etc., and an `onSetEncryptionKey`
// method subclasses call). This sandbox has no real browser to run it
// in, so treat the exact option names here as "verify against whatever
// livekit-client version app.js is pinned to" before trusting it beyond
// this harness -- unlike signal-crypto.js and double-ratchet.js, this
// file has no automated test coverage for that reason.
//
// Uses the `LivekitClient` global from index.html's SRI-pinned classic
// <script> tag, not a separate CDN import -- app.js already loads that
// exact, hash-verified build; importing a second copy from an unpinned
// URL here would both duplicate the SDK and sidestep the SRI check
// entirely.
//
// The frame cryptor itself runs in a dedicated Worker -- LiveKit ships
// this as a separate file (`livekit-client.e2ee.worker.js`) alongside
// the UMD build precisely for non-bundler setups like this harness.
//
// `new Worker(url)` refuses a cross-origin URL outright -- unlike a
// <script> tag, the Worker constructor has no `crossorigin` opt-in, so
// pointing it straight at the jsdelivr URL throws
// "Script at '...' cannot be accessed from origin '...'" the moment
// connect() runs, in every browser, regardless of CORS headers on the
// response. The standard workaround: fetch the script text ourselves
// (jsdelivr's CORS headers make that fetch itself unproblematic), wrap
// it in a same-origin `blob:` URL, and construct the Worker from that.
//
// Gap worth flagging: this fetch isn't SRI-pinned the way index.html's
// UMD <script> tag is (`Worker`/`fetch` have no `integrity` option tied
// to worker construction the way <script integrity> does). Pinning the
// exact version in the URL bounds the risk to "jsdelivr serves something
// other than what that exact version tag points to", not "any version
// drift" -- acceptable for this test harness, but call this out
// explicitly if this pattern gets reused somewhere the risk profile is
// higher.
const E2EE_WORKER_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/livekit-client@2.22.2/dist/livekit-client.e2ee.worker.js";

export async function createE2eeWorker() {
  const res = await fetch(E2EE_WORKER_SCRIPT_URL);
  if (!res.ok) throw new Error(`failed to fetch E2EE worker script: ${res.status}`);
  const scriptText = await res.text();
  const blobUrl = URL.createObjectURL(new Blob([scriptText], { type: "application/javascript" }));
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
  constructor() {
    super({
      sharedKey: true,
      // We do our own explicit, event-driven rotation (join/leave, per
      // §6.1) -- LiveKit's built-in periodic auto-ratchet would be a
      // second, uncoordinated key-evolution mechanism layered on top of
      // ours for no benefit, so it's turned off here.
      ratchetWindowSize: 0,
      keyringSize: 4,
    });
  }

  /** Applies a freshly-rotated room key. `keyIndex` should be the same
   * generation counter group-e2ee.js's rotation protocol uses, so a
   * frame encrypted under generation N is never misinterpreted as
   * belonging to generation N-1 or N+1 on the receiving end. */
  async applyRoomKey(keyBytes, keyIndex) {
    await this.onSetEncryptionKey(keyBytes, undefined, keyIndex);
  }
}
