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

test("FingerprintConvergence treats an exact 50% mismatch as converged (threshold is >50%)", () => {
  const fc = new FingerprintConvergence(0, 2);
  fc.setOwnFingerprint("aaaa");
  fc.recordPeerFingerprint("bob", "aaaa");
  fc.recordPeerFingerprint("carol", "bbbb"); // 1 of 2 = 50%, not > 50%
  assert.deepEqual(fc.decide(), { action: "converged" });
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
