import assert from "node:assert/strict";
import { test } from "node:test";

import { announceMessage, coalesce } from "../announce.mjs";
import { isSearchShortcut, isTypingTarget, nextListIndex, nextTrapIndex } from "../focus.mjs";

const nameFor = (email) => ({ "b@example.com": "Bob" })[email] ?? email;
const incoming = (patch = {}) => ({
  fromEmail: "b@example.com",
  outgoing: false,
  kind: "text",
  body: "hello there",
  ...patch,
});

// --- focus trap -------------------------------------------------------

test("tab moves forward through the trap", () => {
  assert.equal(nextTrapIndex(0, 3), 1);
  assert.equal(nextTrapIndex(1, 3), 2);
});

test("tab wraps from the last element to the first", () => {
  // The whole point: without this, Tab leaves the dialog for the page behind
  // it, where the focus ring is hidden under the backdrop.
  assert.equal(nextTrapIndex(2, 3), 0);
});

test("shift-tab wraps from the first element to the last", () => {
  assert.equal(nextTrapIndex(0, 3, { shift: true }), 2);
  assert.equal(nextTrapIndex(2, 3, { shift: true }), 1);
});

test("focus outside the trap comes back to an end", () => {
  // Happens when the focused element is removed -- a menu item that closed
  // its own menu.
  assert.equal(nextTrapIndex(-1, 3), 0);
  assert.equal(nextTrapIndex(-1, 3, { shift: true }), 2);
});

test("an empty trap has nowhere to go", () => {
  assert.equal(nextTrapIndex(0, 0), -1);
  assert.equal(nextTrapIndex(-1, 0, { shift: true }), -1);
});

test("a single-element trap stays on it", () => {
  assert.equal(nextTrapIndex(0, 1), 0);
  assert.equal(nextTrapIndex(0, 1, { shift: true }), 0);
});

// --- list navigation --------------------------------------------------

test("a list moves but does not wrap", () => {
  assert.equal(nextListIndex(0, 3, 1), 1);
  // Holding Down at the bottom must not jump back to the top; that reads as
  // the list resetting.
  assert.equal(nextListIndex(2, 3, 1), 2);
  assert.equal(nextListIndex(0, 3, -1), 0);
});

test("entering a list from nowhere lands at the near end", () => {
  assert.equal(nextListIndex(-1, 3, 1), 0);
  assert.equal(nextListIndex(-1, 3, -1), 2);
});

test("an empty list has no index", () => {
  assert.equal(nextListIndex(-1, 0, 1), -1);
});

// --- shortcuts --------------------------------------------------------

test("both ctrl-k and cmd-k open search", () => {
  assert.equal(isSearchShortcut({ key: "k", ctrlKey: true }), true);
  assert.equal(isSearchShortcut({ key: "k", metaKey: true }), true);
  assert.equal(isSearchShortcut({ key: "K", ctrlKey: true }), true);
});

test("k on its own, or with alt, is not the shortcut", () => {
  assert.equal(isSearchShortcut({ key: "k" }), false);
  assert.equal(isSearchShortcut({ key: "k", ctrlKey: true, altKey: true }), false);
  assert.equal(isSearchShortcut({ key: "j", ctrlKey: true }), false);
  assert.equal(isSearchShortcut(null), false);
});

test("a keystroke aimed at a field is left alone", () => {
  // Stealing a keypress from the composer is worse than having no shortcut.
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "DIV" }), false);
  assert.equal(isTypingTarget(null), false);
});

// --- announcements ----------------------------------------------------

test("an incoming message is announced with who sent it", () => {
  assert.equal(announceMessage(incoming(), nameFor), "Message from Bob: hello there");
});

test("a mention says so instead", () => {
  assert.equal(
    announceMessage(incoming(), nameFor, { mentionsYou: true }),
    "Bob mentioned you: hello there"
  );
});

test("my own message is not read back to me", () => {
  assert.equal(announceMessage(incoming({ outgoing: true }), nameFor), null);
});

test("a system notice is not announced", () => {
  assert.equal(announceMessage(incoming({ kind: "system", body: "code changed" }), nameFor), null);
});

test("attachments are described rather than announced as empty", () => {
  assert.equal(announceMessage(incoming({ kind: "media", body: "" }), nameFor), "Message from Bob: a photo");
  assert.equal(
    announceMessage(incoming({ kind: "media", body: "", viewOnce: true }), nameFor),
    "Message from Bob: a photo that can be viewed once"
  );
  assert.equal(announceMessage(incoming({ kind: "voice", body: "" }), nameFor), "Message from Bob: a voice message");
  assert.equal(
    announceMessage(incoming({ kind: "file", body: "", media: { name: "notes.pdf" } }), nameFor),
    "Message from Bob: a file, notes.pdf"
  );
});

test("a very long message is cut short", () => {
  // A live region reads the whole string with no way to interrupt it.
  const announced = announceMessage(incoming({ body: "x".repeat(500) }), nameFor);
  assert.ok(announced.endsWith(", and more"));
  assert.ok(announced.length < 200);
});

test("a kind with nothing to say still names the sender", () => {
  assert.equal(announceMessage(incoming({ kind: "weird", body: "" }), nameFor), "Message from Bob");
});

test("nothing at all announces nothing", () => {
  assert.equal(announceMessage(null, nameFor), null);
});

test("one arrival in the window is read in full", () => {
  assert.equal(coalesce(1, "Message from Bob: hi"), "Message from Bob: hi");
});

test("a burst becomes a count", () => {
  // Six overlapping announcements are unfollowable; the count is the part a
  // reader can act on.
  assert.equal(coalesce(6, "Message from Bob: hi"), "6 new messages");
});

test("nothing pending announces nothing", () => {
  assert.equal(coalesce(0, "x"), null);
});
