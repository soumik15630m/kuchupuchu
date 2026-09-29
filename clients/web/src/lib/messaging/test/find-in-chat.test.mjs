import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeProgress,
  highlightParts,
  initialCursor,
  matchIndices,
  step,
} from "../find-in-chat.mjs";

const describe = (m) => m.body;
const messages = [
  { id: "1", body: "meet me at the cafe" },
  { id: "2", body: "which cafe" },
  { id: "3", body: "the one by the station" },
  { id: "4", body: "CAFE on the corner" },
];

test("matches are returned in chat order", () => {
  assert.deepEqual(matchIndices(messages, "cafe", describe), [0, 1, 3]);
});

test("matching ignores case in both directions", () => {
  assert.deepEqual(matchIndices(messages, "CAFE", describe), [0, 1, 3]);
});

test("an empty or whitespace query matches nothing rather than everything", () => {
  assert.deepEqual(matchIndices(messages, "", describe), []);
  assert.deepEqual(matchIndices(messages, "   ", describe), []);
});

test("a deleted message is never a match", () => {
  const withDeleted = [...messages, { id: "5", body: "cafe", deletedForEveryone: true }];
  assert.deepEqual(matchIndices(withDeleted, "cafe", describe), [0, 1, 3]);
});

test("matching uses the described text, so an attachment is findable", () => {
  const withFile = [{ id: "1", body: "", kind: "file" }];
  assert.deepEqual(matchIndices(withFile, "invoice", () => "📄 invoice.pdf"), [0]);
});

test("the cursor starts at the newest match", () => {
  assert.equal(initialCursor(3), 2);
});

test("with no matches the cursor is nowhere", () => {
  assert.equal(initialCursor(0), -1);
});

test("stepping forward wraps at the end", () => {
  assert.equal(step(0, 3, 1), 1);
  assert.equal(step(2, 3, 1), 0);
});

test("stepping back wraps at the start", () => {
  assert.equal(step(2, 3, -1), 1);
  assert.equal(step(0, 3, -1), 2);
});

test("stepping from nowhere lands at an end, depending on direction", () => {
  assert.equal(step(-1, 3, 1), 0);
  assert.equal(step(-1, 3, -1), 2);
});

test("stepping with no matches stays nowhere", () => {
  assert.equal(step(-1, 0, 1), -1);
  assert.equal(step(0, 0, -1), -1);
});

test("progress counts from one, the way people do", () => {
  assert.equal(describeProgress(0, 12), "1 of 12");
  assert.equal(describeProgress(11, 12), "12 of 12");
});

test("no matches says so rather than showing 0 of 0", () => {
  assert.equal(describeProgress(-1, 0), "No matches");
});

test("highlighting splits around every occurrence", () => {
  assert.deepEqual(highlightParts("a cafe and a cafe", "cafe"), [
    { text: "a ", match: false },
    { text: "cafe", match: true },
    { text: " and a ", match: false },
    { text: "cafe", match: true },
  ]);
});

test("highlighting preserves the original casing of the match", () => {
  assert.deepEqual(highlightParts("CAFE here", "cafe"), [
    { text: "CAFE", match: true },
    { text: " here", match: false },
  ]);
});

test("a query with regex characters is treated as literal text", () => {
  // Built into a RegExp this would throw; the whole point of doing it with
  // indexOf is that a typed "(" is just a character.
  assert.deepEqual(highlightParts("what (now)", "(now)"), [
    { text: "what ", match: false },
    { text: "(now)", match: true },
  ]);
});

test("no query leaves the text in one piece", () => {
  assert.deepEqual(highlightParts("unchanged", ""), [{ text: "unchanged", match: false }]);
});

test("a query that does not occur leaves the text in one piece", () => {
  assert.deepEqual(highlightParts("unchanged", "zzz"), [{ text: "unchanged", match: false }]);
});
