// §6/§6.1/§13 Phase 4: the integration layer. Everything cryptographic
// or decision-related lives in signal-crypto.js, double-ratchet.js, and
// rotation.js -- those are unit tested directly. This file's job is
// wiring: reacting to LiveKit room events, sending/receiving the data-
// channel messages the rotation protocol needs, and calling into the
// key provider. It is NOT unit tested here for the same reason
// key-provider.js isn't: it needs a real LiveKit Room to exercise
// meaningfully, which this sandbox doesn't have a browser to run.
// electRotator and FingerprintConvergence -- the parts of this that
// actually decide anything -- ARE fully covered, in rotation.test.mjs.
import {
  generateIdentity,
  buildPublishPayload,
  generateMoreOneTimePrekeys,
  initiateSession,
  respondToSession,
  base64Encode,
  base64Decode,
  computeIdentitySafetyNumber,
} from "./signal-crypto.js";
import { initTransportChain, fingerprint, seal, open } from "./double-ratchet.js";
import { electRotator, FingerprintConvergence } from "./rotation.js";

export const DATA_TOPIC = "kuchupuchu-e2ee";
const ONE_TIME_PREKEY_LOW_WATER_MARK = 5;
const ONE_TIME_PREKEY_TOP_UP_COUNT = 20;

function textEncode(obj) {
  return new TextEncoder().encode(JSON.stringify(obj));
}
function textDecode(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class GroupE2EE {
  /**
   * @param {object} deps
   * @param {import("./key-provider.js").GroupKeyProvider} deps.keyProvider
   * @param {(payloadBytes: Uint8Array, targetIdentities: string[] | undefined) => void} deps.sendData
   *   Should call room.localParticipant.publishData(payloadBytes, { reliable: true, topic: DATA_TOPIC, destinationIdentities: targetIdentities }).
   * @param {(email: string, deviceId: string) => Promise<object>} deps.fetchBundle
   *   Should GET /prekeys/{email}/{deviceId} with the caller's own bearer token and return the parsed JSON body.
   * @param {(deviceIdentity: string) => string} deps.emailForIdentity
   *   Testing-harness concession: a real client already knows this from its own device directory; this harness asks the operator for a small roster instead of building one. See README.
   * @param {(fp: string, generation: number) => void} [deps.onFingerprintChanged]
   * @param {(peerIdentity: string, safetyNumber: string) => void} [deps.onIdentitySafetyNumber]
   *   Distinct from onFingerprintChanged -- this is the identity-based
   *   value that stays stable across reconnects/rotations and is what
   *   should actually be compared out-of-band. See
   *   signal-crypto.js's computeIdentitySafetyNumber for why the two
   *   are not the same thing.
   * @param {() => void} [deps.onRejoinNeeded] - §6.1: called when a mismatch survives one retry.
   * @param {(unreachedPeerIdentities: string[]) => void} [deps.onPartialRotationFailure]
   *   Called when a rotation succeeded overall but one or more peers
   *   couldn't be reached (bundle fetch failed even after retry). The
   *   call itself is fine -- this is informational, not an error to
   *   surface as "connection failed".
   */
  constructor({
    keyProvider,
    sendData,
    fetchBundle,
    emailForIdentity,
    onFingerprintChanged,
    onIdentitySafetyNumber,
    onRejoinNeeded,
    onPartialRotationFailure,
    bundleFetchRetryDelaysMs = [400, 900, 1800],
  }) {
    this.keyProvider = keyProvider;
    this.sendData = sendData;
    this.fetchBundle = fetchBundle;
    this.emailForIdentity = emailForIdentity;
    this.onFingerprintChanged = onFingerprintChanged ?? (() => {});
    this.onIdentitySafetyNumber = onIdentitySafetyNumber ?? (() => {});
    this.onRejoinNeeded = onRejoinNeeded ?? (() => {});
    this.onPartialRotationFailure = onPartialRotationFailure ?? (() => {});
    this._bundleFetchRetryDelaysMs = bundleFetchRetryDelaysMs;

    this.identity = null;
    this.myDeviceIdentity = null;
    /** @type {Map<string, {chain: import("./double-ratchet.js").TransportChain}>} */
    this.sessions = new Map();
    this.generation = -1;
    this.convergence = null;
    this.lastParticipants = null;
    this.lastParticipantIdentities = null;
    // The rotator (only) holds onto the current room key so it can be
    // re-delivered to a single peer whose session state was lost --
    // e.g. that peer reconnected on its own, wiping its in-memory
    // GroupE2EE instance, while we (the rotator) didn't. Without this,
    // that peer would be stuck needing a full re-rotation (triggered by
    // some unrelated membership change) just to recover from its own
    // reconnect. See handleDataMessage's "session-reset" handling.
    this.currentRoomKey = null;
    // Tracks in-flight session-reset requests we've sent, so a peer that
    // never responds doesn't leave us waiting forever -- see
    // _requestSessionReset.
    this._pendingSessionResets = new Map(); // peerIdentity -> timeout id
  }

  async initialize(myDeviceIdentity, existingIdentity = null) {
    this.myDeviceIdentity = myDeviceIdentity;
    this.identity = existingIdentity ?? (await generateIdentity());
    const alreadyPublished = existingIdentity !== null;
    const payload = await buildPublishPayload(this.identity, {
      // A device's identity/signed-prekey re-upload is idempotent server
      // side (see prekeys.py), but one-time prekeys are strictly
      // one-shot -- re-sending the same key_ids on every reconnect would
      // 409 every time instead of just the identity fields. Only publish
      // them the first time this identity is ever used.
      oneTimePrekeyIds: alreadyPublished ? [] : undefined,
    });
    return payload;
  }

  async topUpOneTimePrekeysIfLow(remoteUnusedCount) {
    if (remoteUnusedCount > ONE_TIME_PREKEY_LOW_WATER_MARK) return null;
    return generateMoreOneTimePrekeys(this.identity, ONE_TIME_PREKEY_TOP_UP_COUNT);
  }

  async _fetchBundleWithRetry(email, peerIdentity) {
    // Room membership (LiveKit signaling) and prekey publishing (a
    // separate HTTP call this module has no visibility into) aren't
    // synchronized with each other -- seeing a peer show up in the room
    // doesn't mean their bundle has landed on the server yet. A 404
    // right after someone joins is very often exactly that race, not a
    // real failure, and treating it as fatal on the first try (an
    // earlier version did) meant a rotation attempt could fail outright
    // just because it happened to run a few hundred milliseconds too
    // early.
    const delaysMs = this._bundleFetchRetryDelaysMs;
    let lastError;
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      try {
        return await this.fetchBundle(email, peerIdentity);
      } catch (err) {
        lastError = err;
        if (attempt < delaysMs.length) {
          await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
        }
      }
    }
    throw lastError;
  }

  async _ensureSession(peerIdentity) {
    const existing = this.sessions.get(peerIdentity);
    if (existing) return { session: existing, freshInitialMessage: null };

    const email = this.emailForIdentity(peerIdentity);
    const bundle = await this._fetchBundleWithRetry(email, peerIdentity);
    const { sharedSecret, bootstrapDh, initialMessage } = await initiateSession(this.identity, bundle);
    const chain = await initTransportChain(sharedSecret, bootstrapDh);
    const session = { chain };
    this.sessions.set(peerIdentity, session);

    const myRaw = await crypto.subtle.exportKey("raw", this.identity.signingKeyPair.publicKey);
    const safetyNumber = await computeIdentitySafetyNumber(myRaw, base64Decode(bundle.identity_key));
    session.identitySafetyNumber = safetyNumber;
    this.onIdentitySafetyNumber(peerIdentity, safetyNumber);

    return { session, freshInitialMessage: initialMessage };
  }

  async _handleIncomingInitialMessage(fromIdentity, initialMessage) {
    if (this.sessions.has(fromIdentity)) return; // already established, e.g. a duplicate retransmit
    const { sharedSecret, bootstrapDh } = await respondToSession(this.identity, initialMessage);
    const chain = await initTransportChain(sharedSecret, bootstrapDh);
    const session = { chain };
    this.sessions.set(fromIdentity, session);

    // Note: this is computed over whatever identity_key the initiator
    // claimed in their message, not independently re-verified against
    // the server (see this module's audit notes). That's not a gap this
    // safety number papers over -- it's exactly the case the safety
    // number exists to catch: if this value doesn't match what the
    // human on the other end expects, THAT mismatch is the signal that
    // something substituted an identity somewhere in the chain.
    const myRaw = await crypto.subtle.exportKey("raw", this.identity.signingKeyPair.publicKey);
    const safetyNumber = await computeIdentitySafetyNumber(myRaw, base64Decode(initialMessage.identity_key));
    session.identitySafetyNumber = safetyNumber;
    this.onIdentitySafetyNumber(fromIdentity, safetyNumber);
  }

  /** Call on ParticipantConnected/ParticipantDisconnected (and once on
   * initial join). `participants` must include the local participant.
   * Only actually does anything if the local participant turns out to be
   * the elected rotator -- everyone calls this on every membership
   * change, but only the rotator's call has an effect, by design (see
   * rotation.js). */
  async onMembershipChanged(participants) {
    const identities = participants.map((p) => p.identity).sort();
    const key = identities.join(",");
    // §6.1 says rotate "on join/leave" -- not "on every event that fires
    // while membership happens to be unchanged". Without this check, an
    // SDK-level ParticipantConnected re-fire for an already-known peer
    // (observed happening during ICE-restart reconnects) makes the
    // elected rotator mint a brand-new random key from scratch every
    // time, so both sides chase a moving target and never converge --
    // exactly the symptom of three different fingerprints inside fifteen
    // seconds with no real membership change between them.
    if (this.lastParticipantIdentities === key) return;
    this.lastParticipantIdentities = key;

    this.lastParticipants = participants;
    // If a room-key message already arrived and created a
    // FingerprintConvergence before we'd ever called this function
    // ourselves (data messages and room-membership sync are different
    // subsystems -- this ordering is a real possibility, not just a
    // test artifact), that convergence was sized from a fallback
    // guess. Correct it now that we actually know the real count,
    // rather than leaving a wrong expectedPeerCount in place for the
    // rest of that generation's convergence check.
    if (this.convergence) {
      this.convergence.expectedPeerCount = participants.filter((p) => p.identity !== this.myDeviceIdentity).length;
    }
    const rotator = electRotator(participants);
    if (rotator !== this.myDeviceIdentity) return;
    await this._rotate(participants);
  }

  async _sealAndSendRoomKey(peerIdentity, roomKey, gen) {
    const { session, freshInitialMessage } = await this._ensureSession(peerIdentity);
    const key = await session.chain.keyForGeneration(gen);
    const ad = new TextEncoder().encode(`generation:${gen}`);
    const { iv, ciphertext } = await seal(key, roomKey, ad);

    this.sendData(
      textEncode({
        type: "room-key",
        from: this.myDeviceIdentity,
        to: peerIdentity,
        generation: gen,
        iv: base64Encode(iv),
        ciphertext: base64Encode(ciphertext),
        x3dhInit: freshInitialMessage,
      }),
      [peerIdentity]
    );
  }

  async _rotate(participants) {
    const roomKey = crypto.getRandomValues(new Uint8Array(32));
    // Compute the candidate generation locally and only commit it to
    // this.generation once the whole rotation actually succeeds. An
    // earlier version incremented this.generation up front -- if
    // anything in the loop below threw (a peer's fetchBundle failing,
    // a roster lookup failing), the counter had already moved past a
    // generation nothing was ever distributed or applied for, and nobody
    // would retry it. Session establishment and data-channel sends are
    // exactly the kind of thing that can fail on one peer without
    // warning (see fetchBundle in app.js) -- this needs to be resilient
    // to that, not just to the happy path.
    const gen = this.generation + 1;

    const others = participants.map((p) => p.identity).filter((id) => id !== this.myDeviceIdentity);
    this.convergence = new FingerprintConvergence(gen, others.length);

    const failures = [];
    for (const peerIdentity of others) {
      try {
        await this._sealAndSendRoomKey(peerIdentity, roomKey, gen);
      } catch (err) {
        // One peer's bundle-fetch retries all failing (or any other
        // per-peer error) shouldn't stop delivery to everyone else --
        // in a group call that would mean one slow/unreachable peer
        // silently locks the other N-1 people out of the whole
        // rotation. Collect failures and keep going; the peer that
        // failed just won't have this generation's key yet, which is
        // the same recoverable state a lone reconnect leaves someone
        // in (handled by the session-reset path once they do get a
        // room-key message).
        failures.push({ peerIdentity, err });
      }
    }

    await this.keyProvider.applyRoomKey(roomKey, gen, others);
    this.generation = gen;
    this.currentRoomKey = roomKey;
    const fp = await fingerprint(roomKey);
    this.convergence.setOwnFingerprint(fp);
    this.onFingerprintChanged(fp, gen);
    this.sendData(textEncode({ type: "fingerprint", from: this.myDeviceIdentity, generation: gen, fingerprint: fp }));

    if (failures.length > 0) {
      // Not re-thrown -- the rotation as a whole succeeded (everyone
      // reachable got the new key); this is reported so app.js can log
      // it without it reading as "the call is broken", which it isn't.
      this.onPartialRotationFailure(failures.map((f) => f.peerIdentity));
    }
  }

  /** Asks `peerIdentity` to drop whatever stale session it has for us and
   * re-establish, then re-delivers the current room key. Called when we
   * receive a room-key message we can't decrypt (see handleDataMessage)
   * -- almost always because the SENDER (the rotator) still has a
   * session cached for us from before we reconnected and lost ours.
   * Times out to onRejoinNeeded() if the rotator never responds, rather
   * than waiting forever with no feedback. */
  _requestSessionReset(rotatorIdentity) {
    if (this._pendingSessionResets.has(rotatorIdentity)) return; // already waiting
    this.sendData(textEncode({ type: "session-reset", from: this.myDeviceIdentity, to: rotatorIdentity }));
    const timeoutId = setTimeout(() => {
      this._pendingSessionResets.delete(rotatorIdentity);
      this.onRejoinNeeded();
    }, 5000);
    this._pendingSessionResets.set(rotatorIdentity, timeoutId);
  }

  _clearPendingSessionReset(peerIdentity) {
    const timeoutId = this._pendingSessionResets.get(peerIdentity);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      this._pendingSessionResets.delete(peerIdentity);
    }
  }

  /** Call with every payload received via RoomEvent.DataReceived on
   * DATA_TOPIC, along with the sender's identity. */
  async handleDataMessage(payloadBytes, fromIdentity) {
    const msg = textDecode(payloadBytes);

    if (msg.type === "room-key" && msg.to === this.myDeviceIdentity) {
      if (msg.x3dhInit) {
        await this._handleIncomingInitialMessage(fromIdentity, msg.x3dhInit);
      }
      const session = this.sessions.get(fromIdentity);
      if (!session) {
        // We have no session with this peer and they didn't send us one
        // to bootstrap from -- almost always because THEY (the rotator)
        // still have a session cached for us from before we reconnected
        // and lost ours. Ask them to reset rather than sitting stuck
        // until some unrelated membership change happens to trigger a
        // fresh rotation.
        this._requestSessionReset(fromIdentity);
        return;
      }

      let key;
      try {
        key = await session.chain.keyForGeneration(msg.generation);
      } catch {
        // Our chain has already advanced past this generation (stale
        // message) or something else is genuinely desynced -- a session
        // reset can't fix a chain that's moved forward, only a missing
        // session. This is the case onRejoinNeeded is actually for.
        this.onRejoinNeeded();
        return;
      }

      const ad = new TextEncoder().encode(`generation:${msg.generation}`);
      let roomKey;
      try {
        roomKey = new Uint8Array(await open(key, base64Decode(msg.iv), base64Decode(msg.ciphertext), ad));
      } catch {
        this.onRejoinNeeded(); // AEAD failure -- treat as desync, not a crash
        return;
      }

      this._clearPendingSessionReset(fromIdentity);
      this.generation = msg.generation;
      const knownPeers = this.lastParticipants
        ? this.lastParticipants.map((p) => p.identity).filter((id) => id !== this.myDeviceIdentity)
        : [fromIdentity];
      await this.keyProvider.applyRoomKey(roomKey, msg.generation, knownPeers);
      const fp = await fingerprint(roomKey);
      if (this.convergence?.generation !== msg.generation) {
        // Mirrors _rotate()'s own calculation -- everyone except
        // ourselves. Hardcoding this to 1 (an earlier version did) is
        // only correct for a 2-person call; with 3+ participants a
        // non-rotator would declare "converged" after hearing from just
        // one other peer instead of comparing against everyone, missing
        // a genuine mismatch with a third or fourth participant.
        const expectedPeerCount = this.lastParticipants
          ? this.lastParticipants.filter((p) => p.identity !== this.myDeviceIdentity).length
          : 1;
        this.convergence = new FingerprintConvergence(msg.generation, expectedPeerCount);
      }
      this.convergence.setOwnFingerprint(fp);
      this.onFingerprintChanged(fp, msg.generation);
      this.sendData(textEncode({ type: "fingerprint", from: this.myDeviceIdentity, generation: msg.generation, fingerprint: fp }));
      return;
    }

    if (msg.type === "session-reset" && msg.to === this.myDeviceIdentity) {
      // fromIdentity's session with us is gone on their end (a lone
      // reconnect wiped their in-memory state) -- ours might still be
      // cached from before they reconnected, but it's now one-sided and
      // useless: we'd derive keys they can no longer reproduce. Drop it
      // so _ensureSession generates a fresh x3dhInit, then re-deliver
      // whatever room key we're currently holding so they recover
      // without needing a full new rotation. Only meaningful if we're
      // actually holding a room key to redeliver -- if we're not the
      // rotator (or haven't rotated yet), there's nothing to resend and
      // the requester's own timeout will surface a rejoin prompt.
      this.sessions.delete(fromIdentity);
      if (this.currentRoomKey !== null) {
        await this._sealAndSendRoomKey(fromIdentity, this.currentRoomKey, this.generation);
      }
      return;
    }

    if (msg.type === "fingerprint") {
      if (!this.convergence || this.convergence.generation !== msg.generation) return;
      this.convergence.recordPeerFingerprint(fromIdentity, msg.fingerprint);
      const decision = this.convergence.decide();

      if (decision.action === "prompt-rejoin") {
        this.onRejoinNeeded();
        return;
      }
      if (decision.action === "retry-rotation") {
        // Only meaningful for whoever's actually the rotator -- a
        // non-rotator's FingerprintConvergence instance reaches the same
        // verdict from the same broadcasts (everyone sees every
        // fingerprint message), but only the rotator can act on it by
        // generating a new room key. A non-rotator just waits; it'll see
        // the rotator's next room-key message once this fires there too.
        const rotator = this.lastParticipants ? electRotator(this.lastParticipants) : null;
        if (rotator === this.myDeviceIdentity && this.lastParticipants) {
          await this._rotate(this.lastParticipants);
        }
      }
    }
  }
}
