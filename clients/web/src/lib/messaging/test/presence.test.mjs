import assert from "node:assert/strict";
import { test } from "node:test";

import { presenceLabel } from "../presence.mjs";

const NOW = Date.parse("2026-09-25T14:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
// Built relative to NOW rather than written as UTC literals: the label uses
// toDateString(), which is local, so a fixed "yesterday" string lands on
// today in some timezones and the test would pass or fail by where it runs.
const agoIso = (ms) => new Date(NOW - ms).toISOString();
const time = (ms) => new Date(ms).toISOString().slice(11, 16);
const date = (ms) => new Date(ms).toISOString().slice(0, 10);
const at = (iso) => ({ email: "a@b.c", online: false, lastSeenAt: iso });

test("online beats everything", () => {
  assert.equal(presenceLabel({ online: true, lastSeenAt: null }, NOW, time, date), "online");
});

test("nothing to say when there is no entry or no timestamp", () => {
  assert.equal(presenceLabel(null, NOW, time, date), null);
  assert.equal(presenceLabel(undefined, NOW, time, date), null);
  assert.equal(presenceLabel(at(null), NOW, time, date), null);
});

test("a recent departure reads as just now", () => {
  assert.equal(presenceLabel(at("2026-09-25T13:59:30Z"), NOW, time, date), "last seen just now");
});

test("within the hour it is rounded to minutes", () => {
  assert.equal(
    presenceLabel(at("2026-09-25T13:20:00Z"), NOW, time, date),
    "last seen 40 minutes ago"
  );
});

test("a few hours back says today or yesterday, never a bare date", () => {
  const label = presenceLabel(at(agoIso(3 * 60 * 60 * 1000)), NOW, time, date);
  assert.match(label, /^last seen (today|yesterday) at \d\d:\d\d$/);
});

test("the previous local day says yesterday", () => {
  const label = presenceLabel(at(agoIso(DAY)), NOW, time, date);
  assert.match(label, /^last seen yesterday at /);
});

test("anything older falls back to a date", () => {
  const seen = agoIso(10 * DAY);
  assert.equal(presenceLabel(at(seen), NOW, time, date), `last seen ${date(Date.parse(seen))}`);
});

test("a clock skewed into the future reads as just now, not a future date", () => {
  assert.equal(presenceLabel(at("2026-09-25T14:00:30Z"), NOW, time, date), "last seen just now");
});

test("an unparseable timestamp is ignored rather than rendered", () => {
  assert.equal(presenceLabel(at("not a date"), NOW, time, date), null);
});
