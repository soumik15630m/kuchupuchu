import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultStatusAudience,
  describeStatusAudience,
  loadStatusAudience,
  normaliseStatusAudience,
  saveStatusAudience,
  statusRecipients,
} from "../status-audience.mjs";

const EVERYONE = ["a@x.test", "b@x.test", "c@x.test"];

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

test("everyone by default", () => {
  assert.deepEqual(statusRecipients(defaultStatusAudience(), EVERYONE), EVERYONE);
  assert.equal(describeStatusAudience(defaultStatusAudience(), EVERYONE), "Everyone");
});

test("excluding someone drops exactly them", () => {
  const s = { mode: "all", except: ["b@x.test"], only: [] };
  assert.deepEqual(statusRecipients(s, EVERYONE), ["a@x.test", "c@x.test"]);
  assert.equal(describeStatusAudience(s, EVERYONE), "Everyone except 1");
});

test("only-mode sends to nobody until someone is picked", () => {
  const s = { mode: "only", except: [], only: [] };
  assert.deepEqual(statusRecipients(s, EVERYONE), []);
  assert.equal(describeStatusAudience(s, EVERYONE), "Nobody");
});

test("only-mode sends to exactly the picked members", () => {
  const s = { mode: "only", except: [], only: ["c@x.test", "a@x.test"] };
  assert.deepEqual(statusRecipients(s, EVERYONE), ["a@x.test", "c@x.test"]);
  assert.equal(describeStatusAudience(s, EVERYONE), "Only 2 people");
});

test("one person reads as person, not people", () => {
  const s = { mode: "only", except: [], only: ["a@x.test"] };
  assert.equal(describeStatusAudience(s, EVERYONE), "Only 1 person");
});

test("the two lists do not leak into each other", () => {
  // Switching modes must not silently apply the other mode's list.
  const s = { mode: "all", except: [], only: ["a@x.test"] };
  assert.deepEqual(statusRecipients(s, EVERYONE), EVERYONE);
});

test("someone named who is no longer a member is simply absent", () => {
  const s = { mode: "only", except: [], only: ["gone@x.test", "a@x.test"] };
  assert.deepEqual(statusRecipients(s, EVERYONE), ["a@x.test"]);
});

test("addresses are matched case-insensitively", () => {
  const s = normaliseStatusAudience({ mode: "all", except: ["B@X.test"] });
  assert.deepEqual(statusRecipients(s, ["a@x.test", "b@x.test"]), ["a@x.test"]);
});

test("settings round-trip and junk degrades to defaults", () => {
  const store = fakeStorage();
  saveStatusAudience({ mode: "only", only: ["a@x.test"] }, store);
  assert.deepEqual(loadStatusAudience(store), { mode: "only", except: [], only: ["a@x.test"] });
  assert.deepEqual(loadStatusAudience(fakeStorage({ "kuchupuchu:status-audience": "{" })),
    defaultStatusAudience());
  assert.deepEqual(normaliseStatusAudience({ mode: "sideways", except: 7 }), defaultStatusAudience());
});
