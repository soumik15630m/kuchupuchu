import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultSharing,
  loadSharing,
  normaliseSharing,
  saveSharing,
  shouldSendReadReceipt,
  shouldSendTyping,
  shouldShowReadReceipt,
  shouldShowTyping,
} from "../privacy.mjs";

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

test("everything is shared by default", () => {
  assert.deepEqual(defaultSharing(), { readReceipts: true, typing: true, lastSeen: true });
});

test("turning read receipts off also withholds other people's", () => {
  // The reciprocity rule: otherwise the setting is a one-sided advantage.
  const off = { ...defaultSharing(), readReceipts: false };
  assert.equal(shouldSendReadReceipt(off), false);
  assert.equal(shouldShowReadReceipt(off), false);
});

test("turning typing off also hides other people's", () => {
  const off = { ...defaultSharing(), typing: false };
  assert.equal(shouldSendTyping(off), false);
  assert.equal(shouldShowTyping(off), false);
});

test("the two settings are independent", () => {
  const s = { readReceipts: false, typing: true, lastSeen: true };
  assert.equal(shouldSendReadReceipt(s), false);
  assert.equal(shouldSendTyping(s), true);
});

test("settings round-trip through storage", () => {
  const store = fakeStorage();
  saveSharing({ readReceipts: false }, store);
  const loaded = loadSharing(store);
  assert.equal(loaded.readReceipts, false);
  assert.equal(loaded.typing, true, "unset fields keep their default");
});

test("a partial save does not clobber the other fields", () => {
  const store = fakeStorage();
  saveSharing({ readReceipts: false, typing: false }, store);
  saveSharing({ typing: true }, store);
  const loaded = loadSharing(store);
  assert.equal(loaded.readReceipts, false);
  assert.equal(loaded.typing, true);
});

test("junk in storage degrades to defaults rather than throwing", () => {
  assert.deepEqual(loadSharing(fakeStorage({ "kuchupuchu:sharing": "{not json" })), defaultSharing());
  assert.deepEqual(normaliseSharing(42), defaultSharing());
  assert.deepEqual(normaliseSharing({ readReceipts: "yes" }), defaultSharing());
});

test("no storage at all is survivable", () => {
  assert.deepEqual(loadSharing(null), defaultSharing());
});
