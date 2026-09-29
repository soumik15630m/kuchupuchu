import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_PINS,
  addPin,
  applyPinChange,
  isPinned,
  pinnedMessages,
  prunePins,
  removePin,
} from "../pins.mjs";

test("a pin goes to the front", () => {
  assert.deepEqual(addPin(["a"], "b"), ["b", "a"]);
});

test("pinning something already pinned moves it up rather than duplicating", () => {
  assert.deepEqual(addPin(["a", "b", "c"], "c"), ["c", "a", "b"]);
});

test("a fourth pin evicts the oldest", () => {
  const full = ["c", "b", "a"];
  assert.equal(full.length, MAX_PINS);
  // Silently, on purpose: someone pinning a fourth thing means it, and
  // making them go unpin an older one first is work the app can do.
  assert.deepEqual(addPin(full, "d"), ["d", "c", "b"]);
});

test("unpinning removes just that one", () => {
  assert.deepEqual(removePin(["a", "b", "c"], "b"), ["a", "c"]);
});

test("unpinning something that was not pinned changes nothing", () => {
  assert.deepEqual(removePin(["a"], "zzz"), ["a"]);
});

test("isPinned answers for both cases", () => {
  assert.equal(isPinned(["a"], "a"), true);
  assert.equal(isPinned(["a"], "b"), false);
});

test("a change from the other side applies through the same rules", () => {
  assert.deepEqual(applyPinChange(["a"], "b", true), ["b", "a"]);
  assert.deepEqual(applyPinChange(["b", "a"], "b", false), ["a"]);
});

test("a remote pin also respects the cap", () => {
  assert.deepEqual(applyPinChange(["c", "b", "a"], "d", true), ["d", "c", "b"]);
});

test("pins to messages that are gone are pruned", () => {
  // Otherwise the banner renders empty and cannot be dismissed, because the
  // id it points at no longer resolves to anything.
  assert.deepEqual(prunePins(["a", "b", "c"], ["a", "c"]), ["a", "c"]);
});

test("pruning against nothing clears the list", () => {
  assert.deepEqual(prunePins(["a", "b"], []), []);
});

test("pinned messages come back in pin order, not chat order", () => {
  const messages = [
    { id: "a", body: "first" },
    { id: "b", body: "second" },
    { id: "c", body: "third" },
  ];
  assert.deepEqual(
    pinnedMessages(["c", "a"], messages).map((m) => m.body),
    ["third", "first"]
  );
});

test("a pin with no matching message is skipped rather than yielding a hole", () => {
  assert.deepEqual(pinnedMessages(["missing", "a"], [{ id: "a" }]).map((m) => m.id), ["a"]);
});

test("the original array is never mutated", () => {
  const original = ["a", "b"];
  addPin(original, "c");
  removePin(original, "a");
  assert.deepEqual(original, ["a", "b"]);
});
