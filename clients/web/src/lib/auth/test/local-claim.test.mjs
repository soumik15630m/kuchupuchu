import assert from "node:assert/strict";
import { test } from "node:test";

import { decideLocalClaim } from "../local-claim.mjs";

test("the same member signing back in keeps everything", () => {
  const out = decideLocalClaim({ owner: "alice@example.com", next: "alice@example.com", hasData: true });
  assert.deepEqual(out, { wipe: false, reason: "same-member" });
});

test("the owner comparison ignores case", () => {
  const out = decideLocalClaim({ owner: "alice@example.com", next: "Alice@Example.com", hasData: true });
  assert.equal(out.wipe, false);
});

test("a different member wipes", () => {
  const out = decideLocalClaim({ owner: "alice@example.com", next: "bob@example.com", hasData: true });
  assert.deepEqual(out, { wipe: true, reason: "different-member" });
});

test("a different member wipes even with no data flagged", () => {
  // The flag is a heuristic over localStorage; IndexedDB could still hold
  // messages, so the recorded owner is what decides.
  const out = decideLocalClaim({ owner: "alice@example.com", next: "bob@example.com", hasData: false });
  assert.equal(out.wipe, true);
});

test("a genuinely fresh browser keeps the session it just created", () => {
  const out = decideLocalClaim({ owner: null, next: "alice@example.com", hasData: false });
  assert.deepEqual(out, { wipe: false, reason: "fresh" });
});

test("data with nobody's name on it is wiped rather than assumed", () => {
  // An install from before the owner key existed. It cannot be proven to
  // belong to whoever is signing in now, and a leak cannot be undone.
  const out = decideLocalClaim({ owner: null, next: "bob@example.com", hasData: true });
  assert.deepEqual(out, { wipe: true, reason: "unowned-data" });
});

test("an empty owner string is treated as no owner, not as a member", () => {
  assert.equal(decideLocalClaim({ owner: "", next: "a@b.c", hasData: false }).wipe, false);
  assert.equal(decideLocalClaim({ owner: "", next: "a@b.c", hasData: true }).wipe, true);
});

test("the decision is the same whether or not it is acted on", () => {
  // The rule is consulted once before authenticating and once after. Both
  // calls must agree, or a sign-in could be judged safe and then wipe.
  const input = { owner: "alice@example.com", next: "bob@example.com", hasData: true };
  assert.deepEqual(decideLocalClaim(input), decideLocalClaim(input));
  assert.deepEqual(input, {
    owner: "alice@example.com",
    next: "bob@example.com",
    hasData: true,
  }, "deciding must not mutate its input");
});
