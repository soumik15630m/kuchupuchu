import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_IN_FLIGHT,
  RETRY_AFTER_MS,
  acceptBackfill,
  needsBackfill,
  noteAsked,
  pruneAsked,
  selectToRequest,
  shouldAnswer,
} from "../backfill.mjs";

const NOW = 1_800_000_000_000;
const ME = "me@example.com";

const msg = (id, patch = {}) => ({
  id,
  sentAtMs: NOW,
  media: { mediaId: `blob-${id}`, key: "k", iv: "i", mime: "image/jpeg", byteSize: 1 },
  ...patch,
});

test("a message with an attachment can be backfilled", () => {
  assert.equal(needsBackfill(msg("a")), true);
});

test("a message with no attachment cannot", () => {
  assert.equal(needsBackfill({ id: "a", sentAtMs: NOW }), false);
  assert.equal(needsBackfill(null), false);
});

test("an opened view-once photo is never fetched back", () => {
  // Undoing that would undo the one guarantee it had.
  assert.equal(needsBackfill(msg("a", { viewOnce: true, viewedOnceAtMs: NOW })), false);
});

test("an unopened view-once photo still can be", () => {
  assert.equal(needsBackfill(msg("a", { viewOnce: true })), true);
});

test("a deleted message is not fetched back", () => {
  assert.equal(needsBackfill(msg("a", { deletedForEveryone: true })), false);
});

test("nothing asked yet means everything is a candidate", () => {
  const picked = selectToRequest([msg("a"), msg("b")], {}, NOW);
  assert.deepEqual(picked.map((m) => m.id), ["a", "b"]);
});

test("a recent request blocks a repeat", () => {
  const asked = { "blob-a": NOW - 1000 };
  assert.deepEqual(selectToRequest([msg("a"), msg("b")], asked, NOW).map((m) => m.id), ["b"]);
});

test("an old request no longer blocks", () => {
  // A device that was offline when asked deserves another chance.
  const asked = { "blob-a": NOW - RETRY_AFTER_MS - 1000 };
  assert.deepEqual(selectToRequest([msg("a")], asked, NOW).map((m) => m.id), ["a"]);
});

test("requests are capped so a long scroll does not ask for everything", () => {
  const many = Array.from({ length: 20 }, (_, i) => msg(String(i), { sentAtMs: NOW + i }));
  assert.equal(selectToRequest(many, {}, NOW).length, MAX_IN_FLIGHT);
});

test("the oldest are asked for first", () => {
  const messages = [
    msg("new", { sentAtMs: NOW + 1000 }),
    msg("old", { sentAtMs: NOW - 1000 }),
    msg("middle", { sentAtMs: NOW }),
  ];
  assert.deepEqual(selectToRequest(messages, {}, NOW).map((m) => m.id), ["old", "middle", "new"]);
});

test("noting a request records when", () => {
  assert.deepEqual(noteAsked({}, "blob-a", NOW), { "blob-a": NOW });
});

test("noting never mutates what it was given", () => {
  const asked = { "blob-a": 1 };
  noteAsked(asked, "blob-b", NOW);
  assert.deepEqual(asked, { "blob-a": 1 });
});

test("pruning drops entries that can no longer block anything", () => {
  const asked = { fresh: NOW - 1000, stale: NOW - RETRY_AFTER_MS - 1 };
  assert.deepEqual(pruneAsked(asked, NOW), { fresh: NOW - 1000 });
});

test("a device holding the bytes answers its own account", () => {
  assert.equal(shouldAnswer({ target: "blob-a" }, ME, ME, true), true);
});

test("a device without the bytes stays quiet", () => {
  // This is what stops three devices all uploading the same photo.
  assert.equal(shouldAnswer({ target: "blob-a" }, ME, ME, false), false);
});

test("a request from another member is ignored", () => {
  assert.equal(shouldAnswer({ target: "blob-a" }, ME, "someone@example.com", true), false);
});

test("a request with no target is ignored", () => {
  assert.equal(shouldAnswer({}, ME, ME, true), false);
  assert.equal(shouldAnswer(null, ME, ME, true), false);
});

test("a backfill this device asked for is accepted", () => {
  const content = { target: "blob-a", media: { mediaId: "new" } };
  assert.equal(acceptBackfill(content, ME, ME, { "blob-a": NOW }), true);
});

test("an unrequested backfill is refused", () => {
  // Otherwise a sibling could rewrite a message's media reference unprompted.
  const content = { target: "blob-a", media: { mediaId: "new" } };
  assert.equal(acceptBackfill(content, ME, ME, {}), false);
});

test("a backfill from another member is refused", () => {
  const content = { target: "blob-a", media: { mediaId: "new" } };
  assert.equal(acceptBackfill(content, ME, "someone@example.com", { "blob-a": NOW }), false);
});

test("a backfill with no replacement reference is refused", () => {
  assert.equal(acceptBackfill({ target: "blob-a" }, ME, ME, { "blob-a": NOW }), false);
});
