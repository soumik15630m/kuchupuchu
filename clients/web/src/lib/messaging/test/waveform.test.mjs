import { test } from "node:test";
import assert from "node:assert/strict";

import { PLAYBACK_RATES, WAVEFORM_BARS, nextPlaybackRate, peaksFrom } from "../waveform.mjs";

test("always returns the requested number of bars", () => {
  assert.equal(peaksFrom(new Float32Array(1000)).length, WAVEFORM_BARS);
  assert.equal(peaksFrom(new Float32Array(1000), 10).length, 10);
});

test("empty input is a flat line rather than a crash", () => {
  assert.deepEqual(peaksFrom(new Float32Array(0), 4), [0, 0, 0, 0]);
  assert.deepEqual(peaksFrom(null, 3), [0, 0, 0]);
});

test("silence normalises to zero without dividing by zero", () => {
  assert.deepEqual(peaksFrom(new Float32Array(100), 5), [0, 0, 0, 0, 0]);
});

test("peaks are normalised against the loudest bar", () => {
  const samples = new Float32Array([0.1, 0.1, 0.5, 0.5]);
  const [quiet, loud] = peaksFrom(samples, 2);
  // Float32 cannot hold 0.1 exactly, so this compares within tolerance
  // rather than asserting an exact ratio.
  assert.ok(Math.abs(quiet - 0.2) < 1e-6, `expected ~0.2, got ${quiet}`);
  assert.equal(loud, 1);
});

test("negative samples count by magnitude", () => {
  // Audio swings both ways; ignoring the sign would report near-silence.
  const samples = new Float32Array([-0.8, 0, 0.2, 0]);
  const [first, second] = peaksFrom(samples, 2);
  assert.equal(first, 1);
  assert.ok(Math.abs(second - 0.25) < 1e-6, `expected ~0.25, got ${second}`);
});

test("a bucket keeps its peak rather than its average", () => {
  // Speech is mostly quiet with short bursts; averaging flattens it.
  const samples = new Float32Array([0, 0, 0, 1]);
  assert.deepEqual(peaksFrom(samples, 1), [1]);
});

test("fewer samples than bars still produces the full set", () => {
  const peaks = peaksFrom(new Float32Array([1, 0.5]), 8);
  assert.equal(peaks.length, 8);
  assert.equal(peaks.some((p) => p > 0), true);
});

test("playback rate cycles through the offered speeds", () => {
  assert.equal(nextPlaybackRate(1), 1.5);
  assert.equal(nextPlaybackRate(1.5), 2);
  assert.equal(nextPlaybackRate(2), 1);
});

test("an unknown rate falls back to the first", () => {
  assert.equal(nextPlaybackRate(3), PLAYBACK_RATES[0]);
});
