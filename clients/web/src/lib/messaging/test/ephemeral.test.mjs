import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EDIT_WINDOW_MS,
  EPHEMERAL_DURATIONS,
  canEdit,
  describeDuration,
  expiredAmong,
  expiryFor,
  isExpired,
  isKnownDuration,
  nextSweepDelayMs,
  timerNotice,
} from "../ephemeral.mjs";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ME = "me@example.com";

const message = (patch = {}) => ({
  id: "m1",
  fromEmail: ME,
  outgoing: true,
  kind: "text",
  sentAtMs: NOW,
  ...patch,
});

test("off means no expiry at all, not an expiry of zero", () => {
  // An expiresAtMs of 0 would read as "already expired" and delete the
  // message the moment it was sent.
  assert.equal(expiryFor(NOW, 0), undefined);
  assert.equal(expiryFor(NOW, undefined), undefined);
});

test("the expiry is the sender's clock plus the duration", () => {
  assert.equal(expiryFor(NOW, 7 * DAY), NOW + 7 * DAY);
});

test("a message is not expired at the instant before its expiry", () => {
  const m = message({ expiresAtMs: NOW + 1 });
  assert.equal(isExpired(m, NOW), false);
});

test("a message is expired exactly at its expiry", () => {
  assert.equal(isExpired(message({ expiresAtMs: NOW }), NOW), true);
});

test("a message with no expiry never expires", () => {
  assert.equal(isExpired(message(), NOW + 100 * DAY), false);
});

test("only the expired ones are collected", () => {
  const messages = [
    message({ id: "old", expiresAtMs: NOW - 1 }),
    message({ id: "future", expiresAtMs: NOW + DAY }),
    message({ id: "permanent" }),
  ];
  assert.deepEqual(
    expiredAmong(messages, NOW).map((m) => m.id),
    ["old"]
  );
});

test("the sweep sleeps until the soonest expiry", () => {
  const messages = [
    message({ expiresAtMs: NOW + 2 * 60 * 1000 }),
    message({ expiresAtMs: NOW + 40 * 60 * 1000 }),
  ];
  assert.equal(nextSweepDelayMs(messages, NOW), 2 * 60 * 1000);
});

test("the sweep is capped so a distant expiry does not mean sleeping for days", () => {
  assert.equal(nextSweepDelayMs([message({ expiresAtMs: NOW + 90 * DAY })], NOW), 5 * 60 * 1000);
});

test("the sweep has a floor so a near expiry does not spin", () => {
  assert.equal(nextSweepDelayMs([message({ expiresAtMs: NOW + 10 })], NOW), 15 * 1000);
});

test("nothing pending means no sweep is scheduled", () => {
  assert.equal(nextSweepDelayMs([message()], NOW), null);
  // Already-expired ones are the caller's to delete now, not to wait for.
  assert.equal(nextSweepDelayMs([message({ expiresAtMs: NOW - 1 })], NOW), null);
});

test("every offered duration is one the receiver will accept", () => {
  for (const { ms } of EPHEMERAL_DURATIONS) assert.equal(isKnownDuration(ms), true);
  // A peer sending an arbitrary duration must not be able to set one the UI
  // cannot describe or the member cannot undo.
  assert.equal(isKnownDuration(1234), false);
});

test("durations describe themselves", () => {
  assert.equal(describeDuration(7 * DAY), "7 days");
  assert.equal(describeDuration(0), "Off");
  assert.equal(describeDuration(999), "Off");
});

test("the notice names who changed it", () => {
  assert.equal(timerNotice("Alice", 7 * DAY), "Alice set disappearing messages to 7 days");
  assert.equal(timerNotice("You", 0), "You turned off disappearing messages");
});

test("a fresh message of mine can be edited", () => {
  assert.equal(canEdit(message(), NOW + 1000, ME), true);
});

test("editing closes after fifteen minutes", () => {
  assert.equal(canEdit(message(), NOW + EDIT_WINDOW_MS, ME), true);
  assert.equal(canEdit(message(), NOW + EDIT_WINDOW_MS + 1, ME), false);
});

test("someone else's message is never editable", () => {
  const theirs = message({ outgoing: false, fromEmail: "them@example.com" });
  assert.equal(canEdit(theirs, NOW, ME), false);
});

test("a message that only claims to be mine is not editable", () => {
  // outgoing is derived locally; fromEmail is what actually travelled.
  assert.equal(canEdit(message({ fromEmail: "them@example.com" }), NOW, ME), false);
});

test("a deleted message cannot be edited back into existence", () => {
  assert.equal(canEdit(message({ deletedForEveryone: true }), NOW, ME), false);
});

test("only text is editable", () => {
  for (const kind of ["media", "voice", "sticker", "file", "location", "contact", "system"]) {
    assert.equal(canEdit(message({ kind }), NOW, ME), false, kind);
  }
});

