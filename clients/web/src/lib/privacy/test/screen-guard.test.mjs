import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyGuardEvent,
  concealReason,
  CONCEAL_GRACE_MS,
  initialGuardState,
  isCaptureShortcut,
  shouldConceal,
} from "../screen-guard.mjs";

const key = (over) => ({ key: "a", metaKey: false, shiftKey: false, altKey: false, ...over });

test("PrintScreen is a capture on every platform that reports it", () => {
  assert.equal(isCaptureShortcut(key({ key: "PrintScreen" })), true);
  assert.equal(isCaptureShortcut(key({ key: "PrintScreen", altKey: true })), true);
});

test("the macOS screenshot chords are captures", () => {
  for (const k of ["3", "4", "5"]) {
    assert.equal(isCaptureShortcut(key({ key: k, metaKey: true, shiftKey: true })), true);
  }
});

test("Win+Shift+S is a capture in either case", () => {
  assert.equal(isCaptureShortcut(key({ key: "s", metaKey: true, shiftKey: true })), true);
  assert.equal(isCaptureShortcut(key({ key: "S", metaKey: true, shiftKey: true })), true);
});

test("ordinary typing and near-misses are not captures", () => {
  assert.equal(isCaptureShortcut(key({ key: "s" })), false);
  assert.equal(isCaptureShortcut(key({ key: "3", metaKey: true })), false);
  assert.equal(isCaptureShortcut(key({ key: "4", shiftKey: true })), false);
  assert.equal(isCaptureShortcut(null), false);
});

test("a freshly opened viewer shows the photo", () => {
  assert.equal(shouldConceal(initialGuardState(), 0), false);
  assert.equal(concealReason(initialGuardState()), null);
});

test("losing focus conceals, and coming back does not un-conceal on its own", () => {
  let state = applyGuardEvent(initialGuardState(), { type: "blur" }, 0);
  assert.equal(shouldConceal(state, 0), true);

  state = applyGuardEvent(state, { type: "focus" }, 10);
  // The deliberate part: a window switch must not be a free capture window,
  // so the photo stays hidden until the user asks for it again.
  assert.equal(shouldConceal(state, 10), true);
  assert.equal(concealReason(state), "held");

  state = applyGuardEvent(state, { type: "reveal" }, 20);
  assert.equal(shouldConceal(state, 20), false);
});

test("a hidden tab conceals and stays concealed after it returns", () => {
  let state = applyGuardEvent(initialGuardState(), { type: "visibility", visible: false }, 0);
  assert.equal(shouldConceal(state, 0), true);
  assert.equal(concealReason(state), "away");

  state = applyGuardEvent(state, { type: "visibility", visible: true }, 5);
  assert.equal(shouldConceal(state, 5), true);
});

test("an observed capture shortcut conceals for the grace window", () => {
  const state = applyGuardEvent(initialGuardState(), { type: "capture" }, 1000);
  assert.equal(shouldConceal(state, 1000), true);
  assert.equal(concealReason(state), "capture");
  assert.equal(shouldConceal(state, 1000 + CONCEAL_GRACE_MS + 1), true, "reveal is still required");
});

test("revealing after a capture clears the capture marker", () => {
  let state = applyGuardEvent(initialGuardState(), { type: "capture" }, 1000);
  state = applyGuardEvent(state, { type: "reveal" }, 1200);
  assert.equal(state.capturedAtMs, null);
  assert.equal(shouldConceal(state, 1200), false);
});

test("revealing while the tab is still hidden does not show the photo", () => {
  let state = applyGuardEvent(initialGuardState(), { type: "visibility", visible: false }, 0);
  state = applyGuardEvent(state, { type: "reveal" }, 1);
  // Intent alone is not enough; the environment has to agree.
  assert.equal(shouldConceal(state, 1), true);
});

test("an unknown event leaves the state alone", () => {
  const state = initialGuardState();
  assert.deepEqual(applyGuardEvent(state, { type: "nonsense" }, 0), state);
});
