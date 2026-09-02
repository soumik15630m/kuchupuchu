// Run with: node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { generateIdentity, buildPublishPayload, initiateSession, respondToSession } from "../signal-crypto.js";
import { initTransportChain, fingerprint, seal, open } from "../double-ratchet.js";

function fetchBundleFromPayload(payload, remaining) {
  const one = remaining.length > 0 ? remaining.shift() : null;
  return {
    identity_key: payload.identity_key,
    identity_dh_key: payload.identity_dh_key,
    signed_prekey: payload.signed_prekey,
    one_time_prekey: one,
  };
}

async function establishPair() {
  const alice = await generateIdentity({ oneTimePrekeyCount: 1 });
  const bob = await generateIdentity({ oneTimePrekeyCount: 1 });

  const payload = await buildPublishPayload(bob);
  const bundle = fetchBundleFromPayload(payload, payload.one_time_prekeys.slice());

  const aliceSession = await initiateSession(alice, bundle);
  const bobSession = await respondToSession(bob, aliceSession.initialMessage);
  return { aliceSession, bobSession };
}

test("both sides bootstrap to the identical initial chain key", async () => {
  const { aliceSession, bobSession } = await establishPair();
  const aliceChain = await initTransportChain(aliceSession.sharedSecret, aliceSession.bootstrapDh);
  const bobChain = await initTransportChain(bobSession.sharedSecret, bobSession.bootstrapDh);

  const aliceKey0 = new Uint8Array(await aliceChain.keyForGeneration(0));
  const bobKey0 = new Uint8Array(await bobChain.keyForGeneration(0));
  assert.deepEqual(aliceKey0, bobKey0);
});

test("advancing to a later generation yields a different key than generation 0", async () => {
  const { aliceSession } = await establishPair();
  const chain = await initTransportChain(aliceSession.sharedSecret, aliceSession.bootstrapDh);

  const key0 = new Uint8Array(await chain.keyForGeneration(0));
  const key5 = new Uint8Array(await chain.keyForGeneration(5));
  assert.notDeepEqual(key0, key5);
});

test("requesting an already-passed generation is refused, not silently served stale", async () => {
  const { aliceSession } = await establishPair();
  const chain = await initTransportChain(aliceSession.sharedSecret, aliceSession.bootstrapDh);

  await chain.keyForGeneration(3);
  await assert.rejects(() => chain.keyForGeneration(1), /already advanced/);
});

test("repeated calls for the same current generation return the same key (idempotent, doesn't advance twice)", async () => {
  const { aliceSession } = await establishPair();
  const chain = await initTransportChain(aliceSession.sharedSecret, aliceSession.bootstrapDh);

  const a = new Uint8Array(await chain.keyForGeneration(2));
  const b = new Uint8Array(await chain.keyForGeneration(2));
  assert.deepEqual(a, b);
  assert.equal(chain.currentIndex, 2);
});

test("fingerprint is a stable 4-hex-char digest of the key, and differs for different keys", async () => {
  const { aliceSession, bobSession } = await establishPair();
  const aliceChain = await initTransportChain(aliceSession.sharedSecret, aliceSession.bootstrapDh);
  const bobChain = await initTransportChain(bobSession.sharedSecret, bobSession.bootstrapDh);

  const aliceKey = await aliceChain.keyForGeneration(0);
  const bobKey = await bobChain.keyForGeneration(0);
  const fpA = await fingerprint(aliceKey);
  const fpB = await fingerprint(bobKey);

  assert.match(fpA, /^[0-9a-f]{4}$/);
  assert.equal(fpA, fpB);

  const otherKey = await aliceChain.keyForGeneration(1);
  const fpOther = await fingerprint(otherKey);
  assert.notEqual(fpA, fpOther);
});

test("seal/open round-trips a room-key blob under a shared generation key", async () => {
  const { aliceSession, bobSession } = await establishPair();
  const aliceChain = await initTransportChain(aliceSession.sharedSecret, aliceSession.bootstrapDh);
  const bobChain = await initTransportChain(bobSession.sharedSecret, bobSession.bootstrapDh);

  const key = await aliceChain.keyForGeneration(0);
  await bobChain.keyForGeneration(0); // bob derives the matching key independently

  const roomKey = crypto.getRandomValues(new Uint8Array(32));
  const ad = new TextEncoder().encode("generation:0");
  const { iv, ciphertext } = await seal(key, roomKey, ad);

  const bobKey = await bobChain.keyForGeneration(0);
  const decrypted = new Uint8Array(await open(bobKey, iv, ciphertext, ad));
  assert.deepEqual(decrypted, roomKey);
});

test("open fails on a ciphertext sealed under a different generation's key", async () => {
  const { aliceSession, bobSession } = await establishPair();
  const aliceChain = await initTransportChain(aliceSession.sharedSecret, aliceSession.bootstrapDh);
  const bobChain = await initTransportChain(bobSession.sharedSecret, bobSession.bootstrapDh);

  const roomKey = crypto.getRandomValues(new Uint8Array(32));
  const ad = new TextEncoder().encode("generation:0");
  const keyGen0 = await aliceChain.keyForGeneration(0);
  const { iv, ciphertext } = await seal(keyGen0, roomKey, ad);

  const bobKeyGen1 = await bobChain.keyForGeneration(1); // wrong generation
  await assert.rejects(() => open(bobKeyGen1, iv, ciphertext, ad));
});

test("open fails if the associated data doesn't match what was sealed", async () => {
  const { aliceSession, bobSession } = await establishPair();
  const aliceChain = await initTransportChain(aliceSession.sharedSecret, aliceSession.bootstrapDh);
  const bobChain = await initTransportChain(bobSession.sharedSecret, bobSession.bootstrapDh);

  const roomKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await aliceChain.keyForGeneration(0);
  const { iv, ciphertext } = await seal(key, roomKey, new TextEncoder().encode("generation:0"));

  const bobKey = await bobChain.keyForGeneration(0);
  await assert.rejects(() => open(bobKey, iv, ciphertext, new TextEncoder().encode("generation:1")));
});
