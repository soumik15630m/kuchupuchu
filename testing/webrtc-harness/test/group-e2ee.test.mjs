// Run with: node --test test/*.test.mjs
//
// group-e2ee.js's own header comment says it's "not unit tested here"
// because it needs a real LiveKit Room. That's true for the actual
// wiring in app.js -- but GroupE2EE's dependencies (sendData,
// fetchBundle, keyProvider) are all injected, which means the
// rotation/recovery *logic* itself is fully testable without LiveKit or
// a browser. This file does that: wires multiple GroupE2EE instances
// together over a fake in-memory "data channel" and a fake prekey
// server, and drives real multi-device scenarios -- including the
// lone-reconnect recovery path -- end to end.
import { test } from "node:test";
import assert from "node:assert/strict";

import { GroupE2EE, DATA_TOPIC } from "../group-e2ee.js";
import { generateIdentity, buildPublishPayload } from "../signal-crypto.js";

/** A fake room: routes sendData calls between registered devices the
 * same way LiveKit's data channel would (targeted or broadcast), and
 * a fake prekey server devices publish to / fetch from. */
class FakeRoom {
  constructor() {
    this.devices = new Map(); // identity -> GroupE2EE instance
    this.publishedBundles = new Map(); // identity -> bundle
    this.keyProviders = new Map(); // identity -> FakeKeyProvider
  }

  makeSendData(identity) {
    return (payloadBytes, targetIdentities) => {
      const recipients = targetIdentities ?? [...this.devices.keys()].filter((id) => id !== identity);
      for (const targetId of recipients) {
        const target = this.devices.get(targetId);
        if (!target) continue;
        // Real LiveKit delivery is async (network round trip); queue as
        // a microtask so tests can't accidentally depend on synchronous
        // delivery order that a real network would never guarantee.
        Promise.resolve().then(() => target.handleDataMessage(payloadBytes, identity));
      }
    };
  }

  async fetchBundle(_email, deviceId) {
    const bundle = this.publishedBundles.get(deviceId);
    if (!bundle) throw new Error(`no bundle published for ${deviceId}`);
    return bundle;
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
  async addOrReconnectDevice(identity, { existingIdentity = null, onFingerprintChanged, onRejoinNeeded } = {}) {
    const keyProvider = new FakeKeyProvider();
    this.keyProviders.set(identity, keyProvider);

    const e2ee = new GroupE2EE({
      keyProvider,
      sendData: this.makeSendData(identity),
      fetchBundle: (email, deviceId) => this.fetchBundle(email, deviceId),
      emailForIdentity: (id) => this.emailForIdentity(id),
      onFingerprintChanged: onFingerprintChanged ?? (() => {}),
      onRejoinNeeded: onRejoinNeeded ?? (() => {}),
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

  // "dev-a" is the earliest joiner in this fake room's joinedAtMs=0-for-
  // everyone setup, tie-broken by identity string -- "dev-a" < "dev-b",
  // so dev-a is deterministically the rotator here.
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

  // dev-b "reconnects": a brand new GroupE2EE instance, same device
  // identity, same crypto identity (simulating app.js's cachedCryptoIdentity
  // fix), but its `sessions` Map starts empty -- dev-a's does NOT, since
  // dev-a never reconnected. This is exactly the scenario that used to
  // get permanently stuck: dev-a still thinks it has a session with
  // dev-b and won't send a fresh x3dhInit.
  const oldBSessionIdentity = room.devices.get("dev-b").identity;
  fingerprints.b = null;
  await room.addOrReconnectDevice("dev-b", {
    existingIdentity: oldBSessionIdentity,
    onFingerprintChanged: (fp) => (fingerprints.b = fp),
    onRejoinNeeded: () => rejoinCalls.b++,
  });

  // dev-a doesn't reconnect and doesn't see a membership change (same
  // participant identities as before) -- so it never re-rotates on its
  // own. Recovery has to happen entirely through the session-reset path
  // triggered by dev-b's next incoming (undecryptable) room-key message.
  // Simulate that by having dev-a resend to the room (a real client
  // would do this on ParticipantConnected firing again, or dev-b could
  // trigger it by sending anything -- what matters here is proving the
  // recovery path itself works once a room-key message arrives that
  // dev-b can't decrypt).
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
  // non-rotator's FingerprintConvergence must be sized to ALL other
  // participants (2, in a 3-person room), not just 1. "dev-a" is the
  // deterministic rotator (earliest joiner, tie-broken alphabetically,
  // per electRotator) -- pick a genuine non-rotator explicitly rather
  // than assuming.
  const nonRotatorId = ["dev-b", "dev-c"].find((id) => id !== "dev-a");
  const nonRotator = room.devices.get(nonRotatorId);
  assert.equal(nonRotator.convergence.expectedPeerCount, 2);
});
