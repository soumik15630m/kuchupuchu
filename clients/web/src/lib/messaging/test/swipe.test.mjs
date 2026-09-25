import assert from "node:assert/strict";
import { test } from "node:test";

import { beginSwipe, MAX_PX, moveSwipe, shouldReply, TRIGGER_PX } from "../swipe.mjs";

const drag = (dx, dy) => moveSwipe(beginSwipe(100, 100), 100 + dx, 100 + dy);

test("a tap moves nothing and claims nothing", () => {
  const s = drag(2, 2);
  assert.equal(s.claimed, false);
  assert.equal(s.offset, 0);
  assert.equal(shouldReply(s), false);
});

test("a vertical drag is a scroll, not a swipe", () => {
  const s = drag(-12, 40);
  assert.equal(s.claimed, false);
  assert.equal(s.rejected, true);
  assert.equal(s.offset, 0);
});

test("a mostly-vertical diagonal is still a scroll", () => {
  // Horizontal has to beat vertical clearly; ties go to scrolling.
  assert.equal(drag(-20, 20).rejected, true);
});

test("a clear leftward drag is claimed", () => {
  const s = drag(-40, 5);
  assert.equal(s.claimed, true);
  assert.equal(s.offset, -40);
});

test("a rightward drag is not a reply swipe", () => {
  const s = drag(40, 2);
  assert.equal(s.rejected, true);
  assert.equal(s.offset, 0);
});

test("the bubble stops travelling at the maximum", () => {
  assert.equal(drag(-500, 0).offset, -MAX_PX);
});

test("past the trigger it is a reply", () => {
  assert.equal(shouldReply(drag(-(TRIGGER_PX + 1), 0)), true);
});

test("short of the trigger it is not", () => {
  assert.equal(shouldReply(drag(-(TRIGGER_PX - 1), 0)), false);
});

test("once rejected, further movement cannot revive the gesture", () => {
  // Otherwise a scroll that drifts sideways would fire a reply at the end.
  let s = moveSwipe(beginSwipe(100, 100), 100, 160);
  assert.equal(s.rejected, true);
  s = moveSwipe(s, 20, 160);
  assert.equal(s.claimed, false);
  assert.equal(shouldReply(s), false);
});

test("once claimed, a later vertical wobble keeps the swipe", () => {
  let s = drag(-40, 0);
  // x moves to 40 from a start of 100, so the offset tracks -60 -- still
  // under the cap, and the vertical drift does not cancel the gesture.
  s = moveSwipe(s, 40, 200);
  assert.equal(s.claimed, true);
  assert.equal(s.offset, -60);
});
