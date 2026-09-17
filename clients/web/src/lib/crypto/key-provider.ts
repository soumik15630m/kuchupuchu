import { BaseKeyProvider } from "livekit-client";

/** The harness fetched this script from a CDN and hand-verified an SRI digest
 * because a Worker cannot be constructed from a cross-origin URL. Under a
 * bundler the worker is emitted as a same-origin asset from the same pinned
 * `livekit-client` dependency, so neither the fetch nor the digest applies. */
export function createE2eeWorker(): Worker {
  return new Worker(new URL("livekit-client/e2ee-worker", import.meta.url));
}

const KEYRING_SIZE = 4;

export class GroupKeyProvider extends BaseKeyProvider {
  static KEYRING_SIZE = KEYRING_SIZE;

  constructor() {
    super({
      sharedKey: true,
      // Rotation here is explicit and event-driven (join/leave, §6.1).
      // LiveKit's periodic auto-ratchet would be a second, uncoordinated
      // key-evolution mechanism layered on top of that.
      ratchetWindowSize: 0,
      // Must be -1 whenever ratchetWindowSize is 0. The default of 10 marks a
      // participant's key permanently invalid after 10 consecutive failures,
      // and consecutive failures are expected in the window between a peer
      // joining and their room key being distributed.
      failureTolerance: -1,
      // The room key is 256 bits; LiveKit's default would derive a 128-bit
      // AES-GCM key from it and discard half the strength.
      keySize: 256,
      keyringSize: KEYRING_SIZE,
    });
  }

  /** `participantIdentities` must include the local identity: the local
   * encoder looks its key up by its own identity, which neither `sharedKey`
   * nor the `undefined`-identity registration covers.
   *
   * `onSetEncryptionKey` requires an imported HKDF `CryptoKey` and validates
   * nothing — raw bytes are structured-cloned into the worker, where
   * `deriveKeys` throws on `material.algorithm.name` before the keyring is
   * written, and every later frame then fails with a `MissingKey` error
   * naming a correctly-registered identity. */
  async applyRoomKey(
    keyBytes: Uint8Array,
    generation: number,
    participantIdentities: string[] = []
  ): Promise<void> {
    const keyIndex = generation % KEYRING_SIZE;
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
