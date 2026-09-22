import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultSettings,
  intervalFor,
  isDue,
  nextRunAtMs,
  normaliseSettings,
  RETRY_AFTER_MS,
  STALE_RUN_MS,
} from "../schedule.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const on = (over) => ({ ...defaultSettings(), frequency: "daily", ...over });

test("off means never due and no next run", () => {
  const s = defaultSettings();
  assert.equal(s.frequency, "off");
  assert.equal(nextRunAtMs(s, NOW), null);
  assert.equal(isDue(s, NOW), false);
});

test("turning a schedule on backs up immediately rather than one interval later", () => {
  // Otherwise choosing "weekly" would mean no backup at all for a week.
  const s = on({ frequency: "weekly" });
  assert.equal(nextRunAtMs(s, NOW), NOW);
  assert.equal(isDue(s, NOW), true);
});

test("after a success the next run is exactly one interval later", () => {
  const s = on({ lastSuccessMs: NOW });
  assert.equal(nextRunAtMs(s, NOW), NOW + DAY);
  assert.equal(isDue(s, NOW), false);
  assert.equal(isDue(s, NOW + DAY - 1), false);
  assert.equal(isDue(s, NOW + DAY), true);
});

test("each frequency has the interval it claims", () => {
  assert.equal(intervalFor("daily"), DAY);
  assert.equal(intervalFor("weekly"), 7 * DAY);
  assert.equal(intervalFor("monthly"), 30 * DAY);
  assert.equal(intervalFor("off"), null);
  assert.equal(intervalFor("nonsense"), null);
});

test("a failure backs off instead of retrying on every poll", () => {
  const s = on({ lastAttemptMs: NOW, lastError: "offline" });
  assert.equal(isDue(s, NOW + 60_000), false);
  assert.equal(nextRunAtMs(s, NOW), NOW + RETRY_AFTER_MS);
  assert.equal(isDue(s, NOW + RETRY_AFTER_MS), true);
});

test("the retry backoff never pushes past the next scheduled slot", () => {
  // Failed long ago, success long ago: the schedule wins, not the backoff.
  const s = on({ lastSuccessMs: NOW - 5 * DAY, lastAttemptMs: NOW - 5 * DAY, lastError: "x" });
  assert.equal(nextRunAtMs(s, NOW), NOW - 4 * DAY);
  assert.equal(isDue(s, NOW), true);
});

test("a run in flight is not started a second time", () => {
  const s = on({ runningSinceMs: NOW });
  assert.equal(isDue(s, NOW + 1000), false);
});

test("a run abandoned mid-flight stops blocking the schedule", () => {
  // A tab closed during a backup must not wedge it permanently.
  const s = on({ runningSinceMs: NOW });
  assert.equal(isDue(s, NOW + STALE_RUN_MS + 1), true);
});

test("settings default when storage holds junk", () => {
  for (const junk of [null, undefined, "", 42, []]) {
    assert.deepEqual(normaliseSettings(junk), defaultSettings());
  }
});

test("an unknown frequency falls back to off rather than crashing the schedule", () => {
  assert.equal(normaliseSettings({ frequency: "hourly" }).frequency, "off");
});

test("normalising keeps good values and drops bad ones", () => {
  const out = normaliseSettings({
    frequency: "weekly",
    includeMedia: false,
    lastSuccessMs: NOW,
    lastAttemptMs: "not a number",
    lastError: 7,
    runningSinceMs: null,
  });
  assert.equal(out.frequency, "weekly");
  assert.equal(out.includeMedia, false);
  assert.equal(out.lastSuccessMs, NOW);
  assert.equal(out.lastAttemptMs, null);
  assert.equal(out.lastError, null);
});

test("includeMedia defaults on and survives being set off", () => {
  assert.equal(defaultSettings().includeMedia, true);
  assert.equal(normaliseSettings({ includeMedia: false }).includeMedia, false);
});
