import type { Session } from "../api/client";
import { loadIdentity, saveIdentity } from "../crypto/identity-store";
import { MessageRatchet, type RatchetEnvelope } from "../crypto/message-ratchet";
import {
  deleteRatchetState,
  loadRatchetState,
  saveRatchetState,
  sessionKey,
} from "../crypto/ratchet-store";
import {
  base64Decode,
  base64Encode,
  buildPublishPayload,
  concatBytes,
  computeIdentitySafetyNumber,
  generateIdentity,
  initiateSession,
  respondToSession,
  verifyIdentityDhKey,
  type DeviceIdentity,
  type X3dhInitialMessage,
} from "../crypto/signal-crypto";

export interface MessageEnvelope extends RatchetEnvelope {
  v: 1;
  x3dhInit?: X3dhInitialMessage;
}

interface CachedSession {
  ratchet: MessageRatchet;
  /** Attached to outgoing messages until this peer has spoken to us, since
   * until then they have no session to decrypt with. */
  pendingInit: X3dhInitialMessage | null;
  safetyNumber: string | null;
}

/** Owns this device's long-term identity and one Double Ratchet per peer
 * device. Deliberately separate from the call path's GroupE2EE: they share
 * the same X3DH identity and prekeys, but a call's key agreement is
 * per-room-key and ephemeral, while these sessions outlive any call. */
export class SessionManager {
  private identity: DeviceIdentity | null = null;
  private readonly sessions = new Map<string, CachedSession>();
  private identityPromise: Promise<DeviceIdentity> | null = null;

  constructor(
    private readonly api: Session,
    private readonly deviceId: string
  ) {}

  async ensureIdentity(): Promise<DeviceIdentity> {
    if (this.identity) return this.identity;
    // Concurrent sends must not each generate an identity; the first publish
    // wins server-side and the rest would 409 forever.
    if (this.identityPromise) return this.identityPromise;

    this.identityPromise = (async () => {
      const existing = await loadIdentity(this.deviceId);
      if (existing) {
        this.identity = existing;
        return existing;
      }
      const fresh = await generateIdentity();
      await this.api.publishPrekeys(await buildPublishPayload(fresh));
      await saveIdentity(this.deviceId, fresh);
      this.identity = fresh;
      return fresh;
    })();

    try {
      return await this.identityPromise;
    } finally {
      this.identityPromise = null;
    }
  }

  private async persist(key: string, cached: CachedSession): Promise<void> {
    await saveRatchetState(key, {
      ratchet: cached.ratchet.state,
      pendingInit: cached.pendingInit,
      safetyNumber: cached.safetyNumber,
    });
  }

  private async restore(key: string): Promise<CachedSession | null> {
    const stored = (await loadRatchetState(key)) as
      | { ratchet: unknown; pendingInit: X3dhInitialMessage | null; safetyNumber: string | null }
      | null;
    if (!stored) return null;
    const cached: CachedSession = {
      ratchet: new MessageRatchet(stored.ratchet),
      pendingInit: stored.pendingInit ?? null,
      safetyNumber: stored.safetyNumber ?? null,
    };
    this.sessions.set(key, cached);
    return cached;
  }

  private async outbound(peerEmail: string, peerDeviceId: string): Promise<CachedSession> {
    const key = sessionKey(peerEmail, peerDeviceId);
    const cached = this.sessions.get(key) ?? (await this.restore(key));
    if (cached) return cached;

    const identity = await this.ensureIdentity();
    const bundle = await this.api.fetchBundle(peerEmail, peerDeviceId);
    const { sharedSecret, associatedData, initialMessage } = await initiateSession(identity, bundle);

    // The responder's ratchet key is its signed prekey -- the same key this
    // bundle was signed over, and what respondToSession will hand to
    // initReceiver on their side.
    const ratchet = await MessageRatchet.initSender(
      sharedSecret,
      base64Decode(bundle.signed_prekey.public_key),
      associatedData
    );

    const myRaw = await crypto.subtle.exportKey("raw", identity.signingKeyPair.publicKey);
    const fresh: CachedSession = {
      ratchet,
      pendingInit: initialMessage,
      safetyNumber: await computeIdentitySafetyNumber(myRaw, base64Decode(bundle.identity_key)),
    };
    this.sessions.set(key, fresh);
    await this.persist(key, fresh);
    return fresh;
  }

  /** Re-checks the binding between the claimed identity key and its DH key
   * against what the server holds. Load-bearing, not defence in depth: the
   * identity key is public, so an attacker can copy a victim's verbatim while
   * substituting their own DH key, and a safety number over the identity key
   * alone still matches the victim. */
  private async verifyClaimedIdentity(
    fromEmail: string,
    fromDeviceId: string,
    init: X3dhInitialMessage
  ): Promise<void> {
    const onFile = await this.api.fetchIdentity(fromEmail, fromDeviceId);
    if (onFile.identity_key !== init.identity_key) {
      throw new Error("sender's identity key does not match the one that device published");
    }
    if (onFile.identity_dh_key.public_key !== init.identity_dh_key) {
      throw new Error("sender's identity_dh_key does not match the signed one on file");
    }
    await verifyIdentityDhKey(onFile.identity_key, onFile.identity_dh_key);
  }

  async encrypt(
    peerEmail: string,
    peerDeviceId: string,
    plaintext: Uint8Array
  ): Promise<MessageEnvelope> {
    const key = sessionKey(peerEmail, peerDeviceId);
    const cached = await this.outbound(peerEmail, peerDeviceId);
    const envelope = await cached.ratchet.encrypt(plaintext);
    await this.persist(key, cached);
    return {
      v: 1,
      ...envelope,
      ...(cached.pendingInit ? { x3dhInit: cached.pendingInit } : {}),
    };
  }

  async decrypt(
    fromEmail: string,
    fromDeviceId: string,
    envelope: MessageEnvelope
  ): Promise<ArrayBuffer> {
    const key = sessionKey(fromEmail, fromDeviceId);
    let cached = this.sessions.get(key) ?? (await this.restore(key));

    if (!cached) {
      if (!envelope.x3dhInit) {
        throw new Error(
          `no session with ${fromDeviceId} and the message carries no X3DH init -- cannot decrypt`
        );
      }
      const identity = await this.ensureIdentity();
      await this.verifyClaimedIdentity(fromEmail, fromDeviceId, envelope.x3dhInit);

      const { sharedSecret, associatedData } = await respondToSession(identity, envelope.x3dhInit);
      // respondToSession consumed a one-time prekey. Persisting the identity
      // now is what stops a reload resurrecting a spent key.
      await saveIdentity(this.deviceId, identity);

      const ratchet = await MessageRatchet.initReceiver(
        sharedSecret,
        identity.signedPrekeyPair,
        associatedData
      );
      const myRaw = await crypto.subtle.exportKey("raw", identity.signingKeyPair.publicKey);
      cached = {
        ratchet,
        pendingInit: null,
        safetyNumber: await computeIdentitySafetyNumber(
          myRaw,
          base64Decode(envelope.x3dhInit.identity_key)
        ),
      };
      this.sessions.set(key, cached);
    }

    const plaintext = await cached.ratchet.decrypt(envelope);
    // Hearing from them proves they have a session, so the X3DH init no
    // longer needs to ride along on every outgoing message.
    cached.pendingInit = null;
    await this.persist(key, cached);
    return plaintext;
  }

  safetyNumberFor(peerEmail: string, peerDeviceId: string): string | null {
    return this.sessions.get(sessionKey(peerEmail, peerDeviceId))?.safetyNumber ?? null;
  }

  /** Drops a session so the next message rebuilds it from a fresh X3DH. For
   * the case where a peer re-provisioned a device id and our cached chain can
   * no longer decrypt anything they send. */
  async reset(peerEmail: string, peerDeviceId: string): Promise<void> {
    const key = sessionKey(peerEmail, peerDeviceId);
    this.sessions.delete(key);
    await deleteRatchetState(key);
  }
}

export function encodeContent(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeContent<T>(bytes: ArrayBuffer): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export { base64Encode, concatBytes };
