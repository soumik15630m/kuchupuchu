// Run with: node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { electRotator, FingerprintConvergence } from "../rotation.js";

test("electRotator picks the earliest joiner", () => {
  const rotator = electRotator([
    { identity: "b", joinedAtMs: 200 },
    { identity: "a", joinedAtMs: 100 },
    { identity: "c", joinedAtMs: 300 },
  ]);
  assert.equal(rotator, "a");
});

test("electRotator breaks a joinedAtMs tie by ascending identity", () => {
  const rotator = electRotator([
    { identity: "zeta", joinedAtMs: 100 },
    { identity: "alpha", joinedAtMs: 100 },
  ]);
  assert.equal(rotator, "alpha");
});

test("electRotator with a single participant returns that participant", () => {
  assert.equal(electRotator([{ identity: "solo", joinedAtMs: 42 }]), "solo");
});

test("electRotator throws on an empty participant list rather than guessing", () => {
  assert.throws(() => electRotator([]), /no participants/);
});

test("FingerprintConvergence waits until every expected peer has checked in", () => {
  const fc = new FingerprintConvergence(0, 2);
  fc.setOwnFingerprint("aaaa");
  fc.recordPeerFingerprint("bob", "aaaa");
  assert.deepEqual(fc.decide(), { action: "wait" });

  fc.recordPeerFingerprint("carol", "aaaa");
  assert.deepEqual(fc.decide(), { action: "converged" });
});

test("FingerprintConvergence does NOT treat an exact 50% mismatch as converged", () => {
  // §6.1's ">50% mismatch" wording, read literally, reports success here:
  // in a 4-person call two peers on a different room key is exactly 0.5,
  // and the call would carry on with half the room unable to decrypt the
  // other half. Any disagreement at all is worth one re-rotation.
  const fc = new FingerprintConvergence(0, 2);
  fc.setOwnFingerprint("aaaa");
  fc.recordPeerFingerprint("bob", "aaaa");
  fc.recordPeerFingerprint("carol", "bbbb"); // 1 of 2 = 50%
  assert.deepEqual(fc.decide(), { action: "retry-rotation" });
  assert.deepEqual(fc.decide(), { action: "prompt-rejoin" });
});

test("FingerprintConvergence still reports converged when everyone genuinely agrees", () => {
  const fc = new FingerprintConvergence(0, 2);
  fc.setOwnFingerprint("aaaa");
  fc.recordPeerFingerprint("bob", "aaaa");
  fc.recordPeerFingerprint("carol", "aaaa");
  assert.deepEqual(fc.decide(), { action: "converged" });
});

test("electRotator sorts an unknown joinedAtMs last, never first", () => {
  // Substituting 0 for an unpopulated joinedAt (what app.js used to do)
  // makes that participant look like the earliest joiner and win the
  // election outright -- and two clients disagreeing about whose
  // timestamp is known would each elect a different rotator.
  assert.equal(
    electRotator([
      { identity: "dev-a", joinedAtMs: null },
      { identity: "dev-b", joinedAtMs: 1000 },
    ]),
    "dev-b"
  );
  assert.equal(
    electRotator([
      { identity: "dev-a", joinedAtMs: undefined },
      { identity: "dev-b", joinedAtMs: 5_000_000 },
    ]),
    "dev-b"
  );
  // All unknown -> the identity tie-break still gives every client the
  // same deterministic answer.
  assert.equal(
    electRotator([
      { identity: "dev-z", joinedAtMs: null },
      { identity: "dev-a", joinedAtMs: null },
    ]),
    "dev-a"
  );
});

test("FingerprintConvergence requests one retry on majority mismatch, then prompts rejoin", () => {
  const fc = new FingerprintConvergence(0, 2);
  fc.setOwnFingerprint("aaaa");
  fc.recordPeerFingerprint("bob", "bbbb");
  fc.recordPeerFingerprint("carol", "cccc"); // 2 of 2 = 100% mismatch

  assert.deepEqual(fc.decide(), { action: "retry-rotation" });
  // Simulate the retry not having fixed anything -- peers still disagree.
  assert.deepEqual(fc.decide(), { action: "prompt-rejoin" });
});

test("FingerprintConvergence mismatchFraction is 0 before any data is recorded", () => {
  const fc = new FingerprintConvergence(0, 3);
  assert.equal(fc.mismatchFraction(), 0);
  fc.setOwnFingerprint("aaaa");
  assert.equal(fc.mismatchFraction(), 0); // no peers heard from yet either
});

test("a fresh FingerprintConvergence per generation doesn't carry over the retriedOnce flag", () => {
  const fc0 = new FingerprintConvergence(0, 1);
  fc0.setOwnFingerprint("aaaa");
  fc0.recordPeerFingerprint("bob", "bbbb");
  assert.deepEqual(fc0.decide(), { action: "retry-rotation" });

  const fc1 = new FingerprintConvergence(1, 1);
  fc1.setOwnFingerprint("cccc");
  fc1.recordPeerFingerprint("bob", "dddd");
  // Fresh instance for generation 1 gets its own retry, not an immediate rejoin prompt.
  assert.deepEqual(fc1.decide(), { action: "retry-rotation" });
});
