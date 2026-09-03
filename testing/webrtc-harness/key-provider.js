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
import { BaseKeyProvider } from "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs";

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
