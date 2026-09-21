import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TYPING_EXPIRY_MS,
  applyTyping,
  emptyTyping,
  pruneTyping,
  typingLabel,
  typistsIn,
} from "../typing.mjs";

const T0 = 1_000_000;

test("a typing event is recorded against its own conversation", () => {
  const s = applyTyping(emptyTyping(), { chatId: "group-1", fromEmail: "bob@x", stopped: false }, T0);
  assert.deepEqual(typistsIn(s, "group-1", T0), ["bob@x"]);
});

test("a group's typing does not leak into the sender's 1:1 thread", () => {
  // The original bug: state keyed only by sender, so a group event showed up
  // in the 1:1 with that person, and never in the group.
  const s = applyTyping(emptyTyping(), { chatId: "group-1", fromEmail: "bob@x", stopped: false }, T0);
  assert.deepEqual(typistsIn(s, "bob@x", T0), []);
});

test("two conversations track independently", () => {
  let s = applyTyping(emptyTyping(), { chatId: "group-1", fromEmail: "bob@x", stopped: false }, T0);
  s = applyTyping(s, { chatId: "carol@x", fromEmail: "carol@x", stopped: false }, T0);
  assert.deepEqual(typistsIn(s, "group-1", T0), ["bob@x"]);
  assert.deepEqual(typistsIn(s, "carol@x", T0), ["carol@x"]);
});

test("several people can type in one group at once", () => {
  let s = applyTyping(emptyTyping(), { chatId: "g", fromEmail: "bob@x", stopped: false }, T0);
  s = applyTyping(s, { chatId: "g", fromEmail: "carol@x", stopped: false }, T0);
  assert.deepEqual(typistsIn(s, "g", T0), ["bob@x", "carol@x"]);
});

test("a stop removes only that person", () => {
  let s = applyTyping(emptyTyping(), { chatId: "g", fromEmail: "bob@x", stopped: false }, T0);
  s = applyTyping(s, { chatId: "g", fromEmail: "carol@x", stopped: false }, T0);
  s = applyTyping(s, { chatId: "g", fromEmail: "bob@x", stopped: true }, T0);
  assert.deepEqual(typistsIn(s, "g", T0), ["carol@x"]);
});

test("the conversation is dropped once nobody is typing in it", () => {
  let s = applyTyping(emptyTyping(), { chatId: "g", fromEmail: "bob@x", stopped: false }, T0);
  s = applyTyping(s, { chatId: "g", fromEmail: "bob@x", stopped: true }, T0);
  assert.equal(s.has("g"), false);
});

test("repeated typing from one person does not duplicate them", () => {
  let s = emptyTyping();
  for (let i = 0; i < 5; i++) {
    s = applyTyping(s, { chatId: "g", fromEmail: "bob@x", stopped: false }, T0 + i * 100);
  }
  assert.deepEqual(typistsIn(s, "g", T0), ["bob@x"]);
});

test("each event refreshes that person's expiry", () => {
  let s = applyTyping(emptyTyping(), { chatId: "g", fromEmail: "bob@x", stopped: false }, T0);
  s = applyTyping(s, { chatId: "g", fromEmail: "bob@x", stopped: false }, T0 + 4000);
  // Would have lapsed on the first event's clock, but not the second's.
  assert.deepEqual(typistsIn(s, "g", T0 + TYPING_EXPIRY_MS + 1), ["bob@x"]);
});

test("an entry lapses on its own when no stop ever arrives", () => {
  const s = applyTyping(emptyTyping(), { chatId: "g", fromEmail: "bob@x", stopped: false }, T0);
  assert.deepEqual(typistsIn(s, "g", T0 + TYPING_EXPIRY_MS + 1), []);
});

test("pruning drops lapsed conversations entirely", () => {
  let s = applyTyping(emptyTyping(), { chatId: "g", fromEmail: "bob@x", stopped: false }, T0);
  s = pruneTyping(s, T0 + TYPING_EXPIRY_MS + 1);
  assert.equal(s.size, 0);
});

test("pruning keeps entries that are still live", () => {
  let s = applyTyping(emptyTyping(), { chatId: "g", fromEmail: "bob@x", stopped: false }, T0);
  s = applyTyping(s, { chatId: "g", fromEmail: "carol@x", stopped: false }, T0 + 4000);
  s = pruneTyping(s, T0 + TYPING_EXPIRY_MS + 1);
  assert.deepEqual(typistsIn(s, "g", T0 + TYPING_EXPIRY_MS + 1), ["carol@x"]);
});

test("applyTyping never mutates the state it was given", () => {
  const before = applyTyping(emptyTyping(), { chatId: "g", fromEmail: "bob@x", stopped: false }, T0);
  const snapshot = JSON.stringify([...before.entries()]);
  applyTyping(before, { chatId: "g", fromEmail: "carol@x", stopped: false }, T0);
  assert.equal(JSON.stringify([...before.entries()]), snapshot);
});

test("labels read naturally for a 1:1 and for a group", () => {
  assert.equal(typingLabel([], false), null);
  assert.equal(typingLabel(["Bob"], false), "typing…");
  assert.equal(typingLabel(["Bob"], true), "Bob is typing…");
  assert.equal(typingLabel(["Bob", "Carol"], true), "Bob and Carol are typing…");
  assert.equal(typingLabel(["Bob", "Carol", "Dave"], true), "3 people are typing…");
});
