import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_AHEAD_MS,
  MIN_AHEAD_MS,
  add,
  describeWhen,
  due,
  forChat,
  lateBy,
  nextDelayMs,
  pending,
  presets,
  remove,
  validate,
} from "../scheduled.mjs";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A fixed local afternoon, so the "tonight" preset is still ahead.
const NOW = new Date(2026, 8, 30, 14, 0, 0).getTime();

const entry = (id, atMs, chatId = "a@example.com") => ({ id, atMs, chatId, body: id });

test("an hour from now is always offered", () => {
  const options = presets(NOW);
  assert.equal(options[0].label, "In an hour");
  assert.equal(options[0].atMs, NOW + HOUR);
});

test("tonight is offered in the afternoon", () => {
  const labels = presets(NOW).map((o) => o.label);
  assert.ok(labels.includes("Tonight, 8pm"));
});

test("tonight is not offered once it has passed", () => {
  // Offering 8pm at 11pm is offering to send a message in the past.
  const lateEvening = new Date(2026, 8, 30, 23, 0, 0).getTime();
  const labels = presets(lateEvening).map((o) => o.label);
  assert.ok(!labels.includes("Tonight, 8pm"));
});

test("tomorrow morning is a real 9am, not now plus a day", () => {
  const tomorrow = presets(NOW).find((o) => o.label === "Tomorrow, 9am");
  const d = new Date(tomorrow.atMs);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
  // Compared against a real date rather than getDate() + 1: NOW is the 30th
  // of a 30-day month, so the naive arithmetic asks for the 31st.
  const expected = new Date(NOW);
  expected.setDate(expected.getDate() + 1);
  assert.equal(d.toDateString(), expected.toDateString());
});

test("a time too close is refused", () => {
  assert.ok(validate(NOW + 1000, NOW));
  assert.equal(validate(NOW + MIN_AHEAD_MS + 1, NOW), null);
});

test("a time in the past is refused", () => {
  assert.ok(validate(NOW - HOUR, NOW));
});

test("a time too far out is refused", () => {
  assert.ok(validate(NOW + MAX_AHEAD_MS + DAY, NOW));
  assert.equal(validate(NOW + MAX_AHEAD_MS - DAY, NOW), null);
});

test("a non-time is refused rather than queued", () => {
  assert.ok(validate(NaN, NOW));
  assert.ok(validate(undefined, NOW));
});

test("the queue stays sorted by when it will go", () => {
  let queue = [];
  queue = add(queue, entry("late", NOW + 5 * HOUR));
  queue = add(queue, entry("soon", NOW + HOUR));
  queue = add(queue, entry("middle", NOW + 2 * HOUR));
  assert.deepEqual(queue.map((e) => e.id), ["soon", "middle", "late"]);
});

test("removing takes out just that one", () => {
  const queue = [entry("a", NOW + HOUR), entry("b", NOW + 2 * HOUR)];
  assert.deepEqual(remove(queue, "a").map((e) => e.id), ["b"]);
});

test("due and pending split at the moment", () => {
  const queue = [entry("past", NOW - MINUTE), entry("now", NOW), entry("future", NOW + MINUTE)];
  assert.deepEqual(due(queue, NOW).map((e) => e.id), ["past", "now"]);
  assert.deepEqual(pending(queue, NOW).map((e) => e.id), ["future"]);
});

test("a chat sees only its own", () => {
  const queue = [entry("a", NOW + HOUR, "x@example.com"), entry("b", NOW + HOUR, "y@example.com")];
  assert.deepEqual(forChat(queue, "x@example.com").map((e) => e.id), ["a"]);
});

test("the runner sleeps until the next one is due", () => {
  assert.equal(nextDelayMs([entry("a", NOW + 10 * 1000)], NOW), 10 * 1000);
});

test("the sleep is capped so a distant send does not mean sleeping for days", () => {
  assert.equal(nextDelayMs([entry("a", NOW + 10 * DAY)], NOW), 60 * 1000);
});

test("the sleep has a floor so it does not spin", () => {
  assert.equal(nextDelayMs([entry("a", NOW + 5)], NOW), 1000);
});

test("nothing queued means no timer", () => {
  assert.equal(nextDelayMs([], NOW), null);
  // Already due is the caller's to send now, not to wait for.
  assert.equal(nextDelayMs([entry("a", NOW - 1)], NOW), null);
});

test("the composer line names the day once it is not today", () => {
  const time = (ms) => new Date(ms).getHours() + ":00";
  const date = (ms) => `on the ${new Date(ms).getDate()}`;
  assert.match(describeWhen(NOW + HOUR, NOW, time, date), /^today at /);
  assert.match(describeWhen(NOW + DAY, NOW, time, date), /^tomorrow at /);
  assert.match(describeWhen(NOW + 5 * DAY, NOW, time, date), /^on the /);
});

test("a send that was on time is not reported as late", () => {
  assert.equal(lateBy(entry("a", NOW), NOW), null);
  // A minute or so of slack: the runner ticks, it does not fire to the second.
  assert.equal(lateBy(entry("a", NOW), NOW + MINUTE), null);
});

test("a send delayed by a closed tab says how late it was", () => {
  // The member chose a time. If it was missed they should know by how much.
  assert.equal(lateBy(entry("a", NOW), NOW + 20 * MINUTE), "20 minutes late");
  assert.equal(lateBy(entry("a", NOW), NOW + 3 * HOUR), "3 hours late");
  assert.equal(lateBy(entry("a", NOW), NOW + 2 * DAY), "2 days late");
});
