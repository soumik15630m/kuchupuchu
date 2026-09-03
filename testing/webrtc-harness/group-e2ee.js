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
   * @param {() => void} [deps.onRejoinNeeded] - §6.1: called when a mismatch survives one retry.
   */
  constructor({ keyProvider, sendData, fetchBundle, emailForIdentity, onFingerprintChanged, onRejoinNeeded }) {
    this.keyProvider = keyProvider;
    this.sendData = sendData;
    this.fetchBundle = fetchBundle;
    this.emailForIdentity = emailForIdentity;
    this.onFingerprintChanged = onFingerprintChanged ?? (() => {});
    this.onRejoinNeeded = onRejoinNeeded ?? (() => {});

    this.identity = null;
    this.myDeviceIdentity = null;
    /** @type {Map<string, {chain: import("./double-ratchet.js").TransportChain}>} */
    this.sessions = new Map();
    this.generation = -1;
    this.convergence = null;
    this.lastParticipants = null;
  }

  async initialize(myDeviceIdentity) {
    this.myDeviceIdentity = myDeviceIdentity;
    this.identity = await generateIdentity();
    return buildPublishPayload(this.identity);
  }

  async topUpOneTimePrekeysIfLow(remoteUnusedCount) {
    if (remoteUnusedCount > ONE_TIME_PREKEY_LOW_WATER_MARK) return null;
    return generateMoreOneTimePrekeys(this.identity, ONE_TIME_PREKEY_TOP_UP_COUNT);
  }

  async _ensureSession(peerIdentity) {
    const existing = this.sessions.get(peerIdentity);
    if (existing) return { session: existing, freshInitialMessage: null };

    const email = this.emailForIdentity(peerIdentity);
    const bundle = await this.fetchBundle(email, peerIdentity);
    const { sharedSecret, bootstrapDh, initialMessage } = await initiateSession(this.identity, bundle);
    const chain = await initTransportChain(sharedSecret, bootstrapDh);
    const session = { chain };
    this.sessions.set(peerIdentity, session);
    return { session, freshInitialMessage: initialMessage };
  }

  async _handleIncomingInitialMessage(fromIdentity, initialMessage) {
    if (this.sessions.has(fromIdentity)) return; // already established, e.g. a duplicate retransmit
    const { sharedSecret, bootstrapDh } = await respondToSession(this.identity, initialMessage);
    const chain = await initTransportChain(sharedSecret, bootstrapDh);
    this.sessions.set(fromIdentity, { chain });
  }

  /** Call on ParticipantConnected/ParticipantDisconnected (and once on
   * initial join). `participants` must include the local participant.
   * Only actually does anything if the local participant turns out to be
   * the elected rotator -- everyone calls this on every membership
   * change, but only the rotator's call has an effect, by design (see
   * rotation.js). */
  async onMembershipChanged(participants) {
    this.lastParticipants = participants;
    const rotator = electRotator(participants);
    if (rotator !== this.myDeviceIdentity) return;
    await this._rotate(participants);
  }

  async _rotate(participants) {
    const roomKey = crypto.getRandomValues(new Uint8Array(32));
    this.generation++;
    const gen = this.generation;
    const ad = new TextEncoder().encode(`generation:${gen}`);

    const others = participants.map((p) => p.identity).filter((id) => id !== this.myDeviceIdentity);
    this.convergence = new FingerprintConvergence(gen, others.length);

    for (const peerIdentity of others) {
      const { session, freshInitialMessage } = await this._ensureSession(peerIdentity);
      const key = await session.chain.keyForGeneration(gen);
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

    await this.keyProvider.applyRoomKey(roomKey, gen);
    const fp = await fingerprint(roomKey);
    this.convergence.setOwnFingerprint(fp);
    this.onFingerprintChanged(fp, gen);
    this.sendData(textEncode({ type: "fingerprint", from: this.myDeviceIdentity, generation: gen, fingerprint: fp }));
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
        // to bootstrap from -- nothing to decrypt with. This shouldn't
        // happen in normal operation; surfacing it as a rejoin prompt is
        // the right call per this module's header comment (no silent
        // "just wait and hope" fallback).
        this.onRejoinNeeded();
        return;
      }

      let key;
      try {
        key = await session.chain.keyForGeneration(msg.generation);
      } catch {
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

      this.generation = msg.generation;
      await this.keyProvider.applyRoomKey(roomKey, msg.generation);
      const fp = await fingerprint(roomKey);
      this.convergence = this.convergence?.generation === msg.generation ? this.convergence : new FingerprintConvergence(msg.generation, 1);
      this.convergence.setOwnFingerprint(fp);
      this.onFingerprintChanged(fp, msg.generation);
      this.sendData(textEncode({ type: "fingerprint", from: this.myDeviceIdentity, generation: msg.generation, fingerprint: fp }));
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
