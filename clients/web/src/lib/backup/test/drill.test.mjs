import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTO_INTERVAL_MS,
  STALE_AFTER_MS,
  checkMedia,
  describeResult,
  inspectManifest,
  isStale,
  shouldRunAutomatically,
} from "../drill.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const EMAIL = "me@example.com";

const manifest = (patch = {}) => ({
  email: EMAIL,
  createdAtMs: NOW - DAY,
  messages: [],
  groups: [],
  chatSettings: {},
  includesMedia: false,
  ...patch,
});

test("never verified counts as stale", () => {
  assert.equal(isStale(null, NOW), true);
  assert.equal(isStale(undefined, NOW), true);
  assert.equal(isStale(0, NOW), true);
});

test("a recent verification is not stale", () => {
  assert.equal(isStale(NOW - DAY, NOW), false);
  assert.equal(isStale(NOW - STALE_AFTER_MS + 1000, NOW), false);
});

test("an old verification is stale", () => {
  assert.equal(isStale(NOW - STALE_AFTER_MS - 1000, NOW), true);
});

test("the automatic drill runs when the last one is stale", () => {
  const state = { hasStoredPassphrase: true, lastVerifiedAtMs: null, lastAttemptAtMs: null };
  assert.equal(shouldRunAutomatically(state, NOW), true);
});

test("it never runs without a stored passphrase", () => {
  // Prompting for one unasked reads as the app having lost the backup.
  const state = { hasStoredPassphrase: false, lastVerifiedAtMs: null, lastAttemptAtMs: null };
  assert.equal(shouldRunAutomatically(state, NOW), false);
});

test("it never runs while offline", () => {
  const state = { hasStoredPassphrase: true, lastVerifiedAtMs: null, lastAttemptAtMs: null };
  assert.equal(shouldRunAutomatically(state, NOW, { online: false }), false);
});

test("a failed attempt is not retried immediately", () => {
  // Otherwise every app start re-downloads the whole archive to fail again.
  const state = {
    hasStoredPassphrase: true,
    lastVerifiedAtMs: null,
    lastAttemptAtMs: NOW - 1000,
  };
  assert.equal(shouldRunAutomatically(state, NOW), false);
  assert.equal(
    shouldRunAutomatically({ ...state, lastAttemptAtMs: NOW - AUTO_INTERVAL_MS - 1000 }, NOW),
    true
  );
});

test("a fresh verification means nothing to do", () => {
  const state = {
    hasStoredPassphrase: true,
    lastVerifiedAtMs: NOW - DAY,
    lastAttemptAtMs: NOW - DAY,
  };
  assert.equal(shouldRunAutomatically(state, NOW), false);
});

test("a good manifest passes and reports its counts", () => {
  const result = inspectManifest(
    manifest({ messages: [{ id: "a" }, { id: "b" }], groups: [{ id: "g" }] }),
    EMAIL
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.counts.messages, 2);
  assert.equal(result.counts.groups, 1);
});

test("a manifest belonging to someone else is refused", () => {
  // The one moment to catch this is before anything is written.
  const result = inspectManifest(manifest({ email: "someone@example.com" }), EMAIL);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /belongs to someone@example.com/);
});

test("the owner check ignores case", () => {
  assert.equal(inspectManifest(manifest({ email: "ME@Example.com" }), EMAIL).ok, true);
});

test("a missing manifest is reported rather than throwing", () => {
  for (const bad of [null, undefined, "nope", 42]) {
    const result = inspectManifest(bad, EMAIL);
    assert.equal(result.ok, false);
    assert.equal(result.counts, null);
  }
});

test("a manifest missing its message list fails", () => {
  const result = inspectManifest(manifest({ messages: undefined }), EMAIL);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /message list/.test(p)));
});

test("a manifest with no creation time fails", () => {
  assert.equal(inspectManifest(manifest({ createdAtMs: 0 }), EMAIL).ok, false);
  assert.equal(inspectManifest(manifest({ createdAtMs: NaN }), EMAIL).ok, false);
});

test("several problems are all reported, not just the first", () => {
  const result = inspectManifest({ email: "", createdAtMs: 0 }, EMAIL);
  assert.ok(result.problems.length >= 3);
});

test("a text-only backup expects no attachments", () => {
  const result = checkMedia(manifest({ includesMedia: false, messages: [{ media: { mediaId: "x" } }] }), []);
  assert.deepEqual(result, { expected: 0, present: 0, missing: 0 });
});

test("a media backup with every blob present reports none missing", () => {
  const data = manifest({
    includesMedia: true,
    messages: [{ media: { mediaId: "a" } }, { media: { mediaId: "b" } }, { id: "text-only" }],
  });
  assert.deepEqual(checkMedia(data, ["a", "b"]), { expected: 2, present: 2, missing: 0 });
});

test("a media backup missing a blob says so", () => {
  // A backup that restores the text and loses the photos is a partial backup,
  // and the drill is where that should surface.
  const data = manifest({
    includesMedia: true,
    messages: [{ media: { mediaId: "a" } }, { media: { mediaId: "b" } }],
  });
  assert.deepEqual(checkMedia(data, ["a"]), { expected: 2, present: 1, missing: 1 });
});

test("two messages sharing one attachment count it once", () => {
  const data = manifest({
    includesMedia: true,
    messages: [{ media: { mediaId: "a" } }, { media: { mediaId: "a" } }],
  });
  assert.equal(checkMedia(data, ["a"]).expected, 1);
});

test("never checked says so plainly", () => {
  assert.equal(describeResult(null, NOW, () => "x"), "Never checked.");
});

test("a failure leads with the reason", () => {
  const result = { ok: false, problems: ["The passphrase did not work."], verifiedAtMs: NOW };
  assert.match(describeResult(result, NOW, () => "x"), /The passphrase did not work\./);
});

test("a success reports when and how much", () => {
  const result = {
    ok: true,
    problems: [],
    verifiedAtMs: NOW,
    counts: { messages: 412 },
    media: { expected: 30, present: 30, missing: 0 },
  };
  const line = describeResult(result, NOW, () => "3 March");
  assert.match(line, /today/);
  assert.match(line, /412 messages/);
  assert.match(line, /30 of 30 attachments/);
});

test("an older success names the date", () => {
  const result = { ok: true, problems: [], verifiedAtMs: NOW - 10 * DAY, counts: { messages: 1 } };
  assert.match(describeResult(result, NOW, () => "3 March"), /3 March/);
});

test("a text-only success does not mention attachments", () => {
  const result = {
    ok: true,
    problems: [],
    verifiedAtMs: NOW,
    counts: { messages: 5 },
    media: { expected: 0, present: 0, missing: 0 },
  };
  assert.ok(!describeResult(result, NOW, () => "x").includes("attachment"));
});
