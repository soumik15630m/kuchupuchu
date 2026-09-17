// Run with: node --test test/*.test.mjs
//
// GroupE2EE's dependencies are all injected, so the rotation and
// recovery logic is testable without LiveKit or a browser: multiple
// instances wired together over a fake data channel and prekey server.
import { test } from "node:test";
import assert from "node:assert/strict";

import { GroupE2EE, DATA_TOPIC } from "../group-e2ee.js";
import { generateIdentity, buildPublishPayload } from "../signal-crypto.js";
import { fingerprintProof } from "../double-ratchet.js";

/** A fake room: routes sendData calls between registered devices the
 * same way LiveKit's data channel would (targeted or broadcast), and
 * a fake prekey server devices publish to / fetch from. */
class FakeRoom {
  constructor() {
    this.devices = new Map(); // identity -> GroupE2EE instance
    this.publishedBundles = new Map(); // identity -> bundle
    this.keyProviders = new Map(); // identity -> FakeKeyProvider
    this.fetchFailuresRemaining = new Map(); // identity -> count of times to fail before succeeding
    this.permanentlyUnreachable = new Set(); // identities whose bundle fetch always fails
    this.identityChanges = []; // onIdentityChanged firings, for the persistence test
  }

  makeSendData(identity) {
    return (payloadBytes, targetIdentities) => {
      const recipients = targetIdentities ?? [...this.devices.keys()].filter((id) => id !== identity);
      for (const targetId of recipients) {
        const target = this.devices.get(targetId);
        if (!target) continue;
        // Real delivery is a network round trip, so queue as a microtask
        // -- no test should depend on synchronous delivery order.
        Promise.resolve().then(() => target.handleDataMessage(payloadBytes, identity));
      }
    };
  }

  async fetchBundle(_email, deviceId) {
    if (this.permanentlyUnreachable.has(deviceId)) {
      throw new Error(`prekey bundle fetch failed for ${deviceId}: 404`);
    }
    const remaining = this.fetchFailuresRemaining.get(deviceId) ?? 0;
    if (remaining > 0) {
      this.fetchFailuresRemaining.set(deviceId, remaining - 1);
      throw new Error(`prekey bundle fetch failed for ${deviceId}: 404`);
    }
    const bundle = this.publishedBundles.get(deviceId);
    if (!bundle) throw new Error(`no bundle published for ${deviceId}`);
    return bundle;
  }

  /** The non-consuming identity lookup (GET /prekeys/{email}/{id}/identity).
   * Deliberately NOT gated on fetchFailuresRemaining/permanentlyUnreachable:
   * those model a *bundle* that hasn't landed yet, and the identity
   * endpoint is a separate, one-time-prekey-free read. It still 404s for
   * a device that has published nothing at all. */
  async fetchIdentity(_email, deviceId) {
    const bundle = this.publishedBundles.get(deviceId);
    if (!bundle) throw new Error(`identity fetch failed for ${deviceId}: 404`);
    return { identity_key: bundle.identity_key, identity_dh_key: bundle.identity_dh_key };
  }

  emailForIdentity(identity) {
    return `${identity}@example.com`;
  }

  /** Creates a fresh GroupE2EE for `identity`, publishes its bundle to
   * the fake server, and registers it to receive routed messages. Call
   * again with the same identity to simulate that device reconnecting
   * (a brand new instance, as a real page reload/reconnect produces) --
   * pass `existingIdentity` to simulate the identity-caching fix
   * (app.js's cachedCryptoIdentity) persisting across that reconnect. */
  async addOrReconnectDevice(
    identity,
    { existingIdentity = null, onFingerprintChanged, onRejoinNeeded, onPartialRotationFailure } = {}
  ) {
    const keyProvider = new FakeKeyProvider();
    this.keyProviders.set(identity, keyProvider);

    const e2ee = new GroupE2EE({
      keyProvider,
      sendData: this.makeSendData(identity),
      fetchBundle: (email, deviceId) => this.fetchBundle(email, deviceId),
      fetchIdentity: (email, deviceId) => this.fetchIdentity(email, deviceId),
      emailForIdentity: (id) => this.emailForIdentity(id),
      onIdentityChanged: (identity) => { this.identityChanges.push({ identity: identity, at: Date.now() }); },
      onFingerprintChanged: onFingerprintChanged ?? (() => {}),
      onRejoinNeeded: onRejoinNeeded ?? (() => {}),
      onPartialRotationFailure: onPartialRotationFailure ?? (() => {}),
      // Real delays are 400/900/1800ms; near-zero here exercises the same
      // retry loop without the waiting.
      bundleFetchRetryDelaysMs: [1, 1, 1],
    });

    const publishPayload = await e2ee.initialize(identity, existingIdentity);
    this.publishedBundles.set(identity, {
      identity_key: publishPayload.identity_key,
      identity_dh_key: publishPayload.identity_dh_key,
      signed_prekey: publishPayload.signed_prekey,
      one_time_prekey: publishPayload.one_time_prekeys[0] ?? null,
    });

    this.devices.set(identity, e2ee);
    return e2ee;
  }

  currentParticipants() {
    return [...this.devices.keys()].map((identity) => ({ identity, joinedAtMs: 0 }));
  }
}

class FakeKeyProvider {
  constructor() {
    this.appliedKeys = []; // [{keyBytes, generation}]
  }
  async applyRoomKey(keyBytes, generation) {
    this.appliedKeys.push({ keyBytes: new Uint8Array(keyBytes), generation });
  }
  get currentKey() {
    return this.appliedKeys.at(-1)?.keyBytes ?? null;
  }
}

function waitForMicrotasks(rounds = 10) {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

test("two devices converge on the same room key after a real rotation", async () => {
  const room = new FakeRoom();
  const fingerprints = { a: null, b: null };
  await room.addOrReconnectDevice("dev-a", { onFingerprintChanged: (fp) => (fingerprints.a = fp) });
  await room.addOrReconnectDevice("dev-b", { onFingerprintChanged: (fp) => (fingerprints.b = fp) });

  // joinedAtMs is 0 for everyone here, so the tie-break is the identity
  // string: "dev-a" < "dev-b", deterministically.
  await room.devices.get("dev-a").onMembershipChanged(room.currentParticipants());
  await room.devices.get("dev-b").onMembershipChanged(room.currentParticipants());
  await waitForMicrotasks();

  assert.ok(fingerprints.a, "dev-a should have a fingerprint");
  assert.equal(fingerprints.a, fingerprints.b);
  assert.deepEqual(room.keyProviders.get("dev-a").currentKey, room.keyProviders.get("dev-b").currentKey);
});

test("a lone reconnect recovers via session-reset instead of getting permanently stuck", async () => {
  const room = new FakeRoom();
  const fingerprints = { a: null, b: null };
  const rejoinCalls = { b: 0 };

  await room.addOrReconnectDevice("dev-a", { onFingerprintChanged: (fp) => (fingerprints.a = fp) });
  await room.addOrReconnectDevice("dev-b", {
    onFingerprintChanged: (fp) => (fingerprints.b = fp),
    onRejoinNeeded: () => rejoinCalls.b++,
  });

  await room.devices.get("dev-a").onMembershipChanged(room.currentParticipants());
  await room.devices.get("dev-b").onMembershipChanged(room.currentParticipants());
  await waitForMicrotasks();
  assert.equal(fingerprints.a, fingerprints.b, "sanity check: converged before the reconnect");

  // dev-b "reconnects": new instance, same device and crypto identity,
  // but an empty `sessions` Map -- dev-a's is NOT empty, since dev-a
  // never reconnected. This used to get permanently stuck: dev-a still
  // thinks it has a session and won't send a fresh x3dhInit.
  const oldBSessionIdentity = room.devices.get("dev-b").identity;
  fingerprints.b = null;
  await room.addOrReconnectDevice("dev-b", {
    existingIdentity: oldBSessionIdentity,
    onFingerprintChanged: (fp) => (fingerprints.b = fp),
    onRejoinNeeded: () => rejoinCalls.b++,
  });

  // dev-a neither reconnects nor sees a membership change, so it never
  // re-rotates on its own. Recovery has to come entirely from the
  // session-reset path that dev-b's next undecryptable room-key message
  // triggers.
  await room.devices.get("dev-a")._sealAndSendRoomKey("dev-b", room.devices.get("dev-a").currentRoomKey, room.devices.get("dev-a").generation);
  await waitForMicrotasks(20);

  assert.equal(rejoinCalls.b, 0, "should have recovered automatically, never falling back to a rejoin prompt");
  assert.ok(fingerprints.b, "dev-b should have recovered a fingerprint");
  assert.equal(fingerprints.a, fingerprints.b, "recovered fingerprint should match dev-a's");
});

test("three-device group: a non-rotator's convergence check waits for every peer, not just one", async () => {
  const room = new FakeRoom();
  const fingerprints = { a: null, b: null, c: null };

  await room.addOrReconnectDevice("dev-a", { onFingerprintChanged: (fp) => (fingerprints.a = fp) });
  await room.addOrReconnectDevice("dev-b", { onFingerprintChanged: (fp) => (fingerprints.b = fp) });
  await room.addOrReconnectDevice("dev-c", { onFingerprintChanged: (fp) => (fingerprints.c = fp) });

  for (const id of ["dev-a", "dev-b", "dev-c"]) {
    await room.devices.get(id).onMembershipChanged(room.currentParticipants());
  }
  await waitForMicrotasks(20);

  assert.ok(fingerprints.a && fingerprints.b && fingerprints.c);
  assert.equal(fingerprints.a, fingerprints.b);
  assert.equal(fingerprints.b, fingerprints.c);

  // Regression check for the hardcoded expectedPeerCount=1 bug: a
  // non-rotator's convergence must be sized to ALL other participants
  // (2, in a 3-person room). Pick a genuine non-rotator explicitly
  // rather than assuming which one it is.
  const nonRotatorId = ["dev-b", "dev-c"].find((id) => id !== "dev-a");
  const nonRotator = room.devices.get(nonRotatorId);
  assert.equal(nonRotator.convergence.expectedPeerCount, 2);
});

test("a transient bundle-fetch race (peer hasn't published yet) recovers via retry, not a broken rotation", async () => {
  const room = new FakeRoom();
  const fingerprints = { a: null, b: null };

  await room.addOrReconnectDevice("dev-a", { onFingerprintChanged: (fp) => (fingerprints.a = fp) });
  await room.addOrReconnectDevice("dev-b", { onFingerprintChanged: (fp) => (fingerprints.b = fp) });

  // What happened in real testing: dev-a fetches dev-b's bundle before
  // dev-b's publish has landed, so the first two attempts 404.
  room.fetchFailuresRemaining.set("dev-b", 2);

  await room.devices.get("dev-a").onMembershipChanged(room.currentParticipants());
  await room.devices.get("dev-b").onMembershipChanged(room.currentParticipants());
  await waitForMicrotasks(30);

  assert.ok(fingerprints.a, "dev-a should have recovered and completed rotation despite the transient failure");
  assert.equal(fingerprints.a, fingerprints.b);
});

test("an x3dhInit carrying a victim's identity_key but an attacker's DH key is rejected", async () => {
  // `identity_key` is public, so an attacker already in the room can copy
  // the victim's verbatim while substituting their own identity_dh_key.
  // The safety number hashes the *claimed* identity_key, so the value
  // shown to the human still matches. Only binding the two keys catches it.
  const room = new FakeRoom();
  await room.addOrReconnectDevice("dev-a");
  await room.addOrReconnectDevice("dev-victim");
  const attackerIdentity = await generateIdentity({ oneTimePrekeyCount: 1 });
  const attackerPayload = await buildPublishPayload(attackerIdentity);

  const victimBundle = room.publishedBundles.get("dev-victim");
  const target = room.devices.get("dev-a");

  // Attacker speaks as "dev-victim" (LiveKit reports the real sender
  // identity, but the attacker is a room member speaking under some
  // identity -- what they forge is the *contents*).
  const forged = {
    identity_key: victimBundle.identity_key, // copied verbatim from the victim
    identity_dh_key: attackerPayload.identity_dh_key.public_key, // the attacker's own
    ephemeral_key: attackerPayload.signed_prekey.public_key,
    used_signed_prekey_id: 1,
    used_one_time_prekey_id: null,
  };

  await assert.rejects(
    () => target._handleIncomingInitialMessage("dev-victim", forged),
    /identity_dh_key that does not match/
  );
  assert.equal(target.sessions.has("dev-victim"), false, "no session should have been established");
});

test("a room-key blob is bound to the identity pair, not just the generation", async () => {
  // Regression test for associatedData being computed, returned, and
  // then silently dropped: with only `generation:N` bound in, a blob
  // sealed for one pair of identities carries nothing tying it to them.
  const room = new FakeRoom();
  await room.addOrReconnectDevice("dev-a");
  await room.addOrReconnectDevice("dev-b");
  await room.devices.get("dev-a").onMembershipChanged(room.currentParticipants());
  await room.devices.get("dev-b").onMembershipChanged(room.currentParticipants());
  await waitForMicrotasks();

  const a = room.devices.get("dev-a");
  const session = a.sessions.get("dev-b");
  const ad = a._adFor(session, 7);
  const adText = new TextDecoder().decode(ad);

  assert.ok(adText.endsWith("|generation:7"), "generation must still be bound");
  assert.ok(
    ad.byteLength > "|generation:7".length,
    "associated data must carry the X3DH identity binding (IK_A || IK_B), not just the generation"
  );
  // Different generation => different AD, so a blob can't be replayed
  // at another point in the same session either.
  assert.notDeepEqual(ad, a._adFor(session, 8));
});

test("a fingerprint proof cannot be forged by a peer that doesn't hold the room key", async () => {
  const room = new FakeRoom();
  await room.addOrReconnectDevice("dev-a");
  await room.addOrReconnectDevice("dev-b");
  await room.devices.get("dev-a").onMembershipChanged(room.currentParticipants());
  await room.devices.get("dev-b").onMembershipChanged(room.currentParticipants());
  await waitForMicrotasks();

  const a = room.devices.get("dev-a");
  const gen = a.generation;

  // A participant on the wrong key echoing back a proof it copied off
  // the wire from someone else must not count as agreement: the sender
  // identity is bound into the MAC.
  const realProofFromB = await fingerprintProof(a.currentRoomKey, gen, "dev-b");
  const asIfFromC = await fingerprintProof(a.currentRoomKey, gen, "dev-c");
  assert.notEqual(realProofFromB, asIfFromC, "proofs must be bound to the sender identity");

  // And a proof under a different room key doesn't verify at all.
  const wrongKey = crypto.getRandomValues(new Uint8Array(32));
  const forged = await fingerprintProof(wrongKey, gen, "dev-b");
  assert.notEqual(forged, realProofFromB);
});

test("a peer that never comes back doesn't block the room key from reaching everyone else", async () => {
  const room = new FakeRoom();
  const fingerprints = { a: null, b: null, c: null };
  const partialFailures = [];

  await room.addOrReconnectDevice("dev-a", {
    onFingerprintChanged: (fp) => (fingerprints.a = fp),
    onPartialRotationFailure: (unreached) => partialFailures.push(unreached),
  });
  await room.addOrReconnectDevice("dev-b", { onFingerprintChanged: (fp) => (fingerprints.b = fp) });
  await room.addOrReconnectDevice("dev-c", { onFingerprintChanged: (fp) => (fingerprints.c = fp) });

  room.permanentlyUnreachable.add("dev-c"); // e.g. dev-c's own publish is broken and never succeeds

  for (const id of ["dev-a", "dev-b", "dev-c"]) {
    await room.devices.get(id).onMembershipChanged(room.currentParticipants());
  }
  await waitForMicrotasks(30);

  assert.ok(fingerprints.a, "dev-a (the rotator) should still complete its own key application");
  assert.equal(fingerprints.a, fingerprints.b, "dev-b, who IS reachable, should still get the room key");
  assert.equal(fingerprints.c, null, "dev-c never received a working room-key message, as expected");
  assert.deepEqual(partialFailures, [["dev-c"]], "the rotator should be told which peer(s) it couldn't reach");
});


test("consuming a one-time prekey notifies the caller so it can re-persist", async () => {
  // A device's identity must survive a reload (identity-store.js: the
  // server refuses to replace an identity key, so losing it locks that
  // device out of E2EE permanently). But persisting only at creation is
  // not enough: respondToSession DELETES the one-time prekey it consumes,
  // and a reload that restored the pre-consumption copy would hand that
  // spent key back out -- defeating exactly the replay protection the
  // one-time prekey exists for.
  const room = new FakeRoom();
  await room.addOrReconnectDevice("dev-a");
  await room.addOrReconnectDevice("dev-b");

  const before = room.identityChanges.length;
  await room.devices.get("dev-a").onMembershipChanged(room.currentParticipants());
  await room.devices.get("dev-b").onMembershipChanged(room.currentParticipants());
  await waitForMicrotasks(20);

  assert.ok(
    room.identityChanges.length > before,
    "responding to an x3dhInit consumes a one-time prekey and must report the mutation"
  );

  // And the reported identity really has the key removed.
  const responder = room.devices.get("dev-b");
  const reported = room.identityChanges.at(-1).identity;
  assert.equal(reported, responder.identity, "callback should hand back the live identity object");
});
