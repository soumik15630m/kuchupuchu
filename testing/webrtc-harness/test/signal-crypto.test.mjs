// Run with: node --test test/signal-crypto.test.mjs
// Uses Node's own WebCrypto (X25519/Ed25519/HKDF all present in Node 20+),
// exercising the exact same code path the browser harness runs -- no
// mocking, no stubbed crypto.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateIdentity,
  buildPublishPayload,
  generateMoreOneTimePrekeys,
  verifyBundle,
  initiateSession,
  respondToSession,
  base64Encode,
} from "../signal-crypto.js";

// Mimics what the auth-service actually does when serving GET
// /prekeys/{email}/{device_id}: identity + signed prekey always, one
// unconsumed one-time prekey if any remain (removed from the pool here
// to mirror the server's "consumed exactly once" behavior).
function fetchBundleFromPayload(payload, remainingOneTimePrekeys) {
  const oneTimePrekey = remainingOneTimePrekeys.length > 0 ? remainingOneTimePrekeys.shift() : null;
  return {
    identity_key: payload.identity_key,
    identity_dh_key: payload.identity_dh_key,
    signed_prekey: payload.signed_prekey,
    one_time_prekey: oneTimePrekey,
  };
}

test("X3DH: initiator and responder derive the identical shared secret (with one-time prekey)", async () => {
  const alice = await generateIdentity({ oneTimePrekeyCount: 3 });
  const bob = await generateIdentity({ oneTimePrekeyCount: 3 });

  const bobPayload = await buildPublishPayload(bob);
  const bobUnconsumed = bobPayload.one_time_prekeys.slice();

  const bundle = fetchBundleFromPayload(bobPayload, bobUnconsumed);
  assert.notEqual(bundle.one_time_prekey, null);

  const { sharedSecret: aliceSecret, initialMessage } = await initiateSession(alice, bundle);
  const { sharedSecret: bobSecret } = await respondToSession(bob, initialMessage);

  assert.equal(base64Encode(aliceSecret), base64Encode(bobSecret));
  assert.equal(new Uint8Array(aliceSecret).byteLength, 32);
});

test("X3DH: degrades gracefully to three DH terms when the one-time prekey pool is empty", async () => {
  const alice = await generateIdentity({ oneTimePrekeyCount: 0 });
  const bob = await generateIdentity({ oneTimePrekeyCount: 0 });

  const bobPayload = await buildPublishPayload(bob);
  const bundle = fetchBundleFromPayload(bobPayload, []);
  assert.equal(bundle.one_time_prekey, null);

  const { sharedSecret: aliceSecret, initialMessage } = await initiateSession(alice, bundle);
  assert.equal(initialMessage.used_one_time_prekey_id, null);

  const { sharedSecret: bobSecret } = await respondToSession(bob, initialMessage);
  assert.equal(base64Encode(aliceSecret), base64Encode(bobSecret));
});

test("X3DH: a consumed one-time prekey is removed from the responder's local pool", async () => {
  const alice = await generateIdentity({ oneTimePrekeyCount: 1 });
  const bob = await generateIdentity({ oneTimePrekeyCount: 1 });

  const bobPayload = await buildPublishPayload(bob);
  const bundle = fetchBundleFromPayload(bobPayload, bobPayload.one_time_prekeys.slice());

  const { initialMessage } = await initiateSession(alice, bundle);
  assert.equal(bob.oneTimePrekeys.size, 1);
  await respondToSession(bob, initialMessage);
  assert.equal(bob.oneTimePrekeys.size, 0);
});

test("X3DH: replaying an initial message against an already-consumed one-time prekey fails", async () => {
  const alice = await generateIdentity({ oneTimePrekeyCount: 1 });
  const bob = await generateIdentity({ oneTimePrekeyCount: 1 });

  const bobPayload = await buildPublishPayload(bob);
  const bundle = fetchBundleFromPayload(bobPayload, bobPayload.one_time_prekeys.slice());
  const { initialMessage } = await initiateSession(alice, bundle);

  await respondToSession(bob, initialMessage);
  await assert.rejects(() => respondToSession(bob, initialMessage), /don't have/);
});

test("X3DH: a bundle with a forged signed-prekey signature is rejected before any DH happens", async () => {
  const alice = await generateIdentity({ oneTimePrekeyCount: 0 });
  const bob = await generateIdentity({ oneTimePrekeyCount: 0 });
  const mallory = await generateIdentity({ oneTimePrekeyCount: 0 });

  const bobPayload = await buildPublishPayload(bob);
  const malloryPayload = await buildPublishPayload(mallory);
  const bundle = fetchBundleFromPayload(bobPayload, []);
  // Swap in a signed prekey signed by a different identity entirely.
  bundle.signed_prekey = malloryPayload.signed_prekey;

  await assert.rejects(() => initiateSession(alice, bundle), /does not verify/);
});

test("X3DH: a bundle with a forged identity_dh_key signature is rejected", async () => {
  const alice = await generateIdentity({ oneTimePrekeyCount: 0 });
  const bob = await generateIdentity({ oneTimePrekeyCount: 0 });
  const mallory = await generateIdentity({ oneTimePrekeyCount: 0 });

  const bobPayload = await buildPublishPayload(bob);
  const malloryPayload = await buildPublishPayload(mallory);
  const bundle = fetchBundleFromPayload(bobPayload, []);
  bundle.identity_dh_key = malloryPayload.identity_dh_key;

  await assert.rejects(() => initiateSession(alice, bundle), /does not verify/);
});

test("X3DH: responding against a stale (rotated-out) signed prekey id fails clearly", async () => {
  const alice = await generateIdentity({ oneTimePrekeyCount: 0 });
  const bob = await generateIdentity({ oneTimePrekeyCount: 0 });

  const bobPayload = await buildPublishPayload(bob);
  const bundle = fetchBundleFromPayload(bobPayload, []);
  const { initialMessage } = await initiateSession(alice, bundle);

  bob.signedPrekeyId = 999; // simulate bob having rotated in the meantime
  await assert.rejects(() => respondToSession(bob, initialMessage), /rotated/);
});

test("associated data is symmetric between initiator and responder views", async () => {
  const alice = await generateIdentity({ oneTimePrekeyCount: 0 });
  const bob = await generateIdentity({ oneTimePrekeyCount: 0 });

  const bobPayload = await buildPublishPayload(bob);
  const bundle = fetchBundleFromPayload(bobPayload, []);
  const { initialMessage, associatedData: aliceAD } = await initiateSession(alice, bundle);
  const { associatedData: bobAD } = await respondToSession(bob, initialMessage);

  // Alice's AD is IKa||IKb; Bob's is IKa||IKb too (both compute it in the
  // initiator-first order per the X3DH spec's AD convention), so they
  // should match byte-for-byte.
  assert.equal(base64Encode(aliceAD), base64Encode(bobAD));
});

test("generateMoreOneTimePrekeys tops up the pool without disturbing existing key ids", async () => {
  const identity = await generateIdentity({ oneTimePrekeyCount: 2 });
  assert.deepEqual(Array.from(identity.oneTimePrekeys.keys()).sort(), [0, 1]);

  const topUpPayload = await generateMoreOneTimePrekeys(identity, 3);
  assert.deepEqual(
    topUpPayload.one_time_prekeys.map((k) => k.key_id).sort((a, b) => a - b),
    [2, 3, 4]
  );
  assert.deepEqual(Array.from(identity.oneTimePrekeys.keys()).sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test("verifyBundle rejects a tampered signed_prekey even when called standalone", async () => {
  const bob = await generateIdentity({ oneTimePrekeyCount: 0 });
  const bobPayload = await buildPublishPayload(bob);
  const bundle = fetchBundleFromPayload(bobPayload, []);
  bundle.signed_prekey.public_key = base64Encode(new Uint8Array(32).fill(7));

  await assert.rejects(() => verifyBundle(bundle), /does not verify/);
});
