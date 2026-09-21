import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregateStatus, applyReceipt } from "../receipts.mjs";

const groupMessage = () => ({
  status: "sent",
  recipients: ["bob@example.com", "carol@example.com"],
  deliveredTo: [],
  readBy: [],
});

test("a fresh message stays sent", () => {
  assert.equal(aggregateStatus(groupMessage()), "sent");
});

test("one recipient delivering does not mark a group message delivered", () => {
  const after = applyReceipt(groupMessage(), "delivered", "bob@example.com");
  assert.equal(after.status, "sent");
});

test("delivered only once every recipient has it", () => {
  let m = applyReceipt(groupMessage(), "delivered", "bob@example.com");
  m = applyReceipt(m, "delivered", "carol@example.com");
  assert.equal(m.status, "delivered");
});

test("one recipient reading does not turn the ticks blue for the group", () => {
  let m = applyReceipt(groupMessage(), "delivered", "bob@example.com");
  m = applyReceipt(m, "delivered", "carol@example.com");
  m = applyReceipt(m, "read", "bob@example.com");
  assert.equal(m.status, "delivered");
});

test("read once every recipient has read", () => {
  let m = groupMessage();
  for (const who of ["bob@example.com", "carol@example.com"]) {
    m = applyReceipt(m, "read", who);
  }
  assert.equal(m.status, "read");
});

test("reading implies delivery, so a read-only report still completes delivery", () => {
  let m = applyReceipt(groupMessage(), "read", "bob@example.com");
  m = applyReceipt(m, "delivered", "carol@example.com");
  assert.equal(m.status, "delivered");
});

test("a 1:1 message goes read on its single recipient's receipt", () => {
  const m = applyReceipt(
    { status: "sent", recipients: ["bob@example.com"], deliveredTo: [], readBy: [] },
    "read",
    "bob@example.com"
  );
  assert.equal(m.status, "read");
});

test("a late delivered receipt cannot undo read", () => {
  let m = applyReceipt(
    { status: "sent", recipients: ["bob@example.com"], deliveredTo: [], readBy: [] },
    "read",
    "bob@example.com"
  );
  m = applyReceipt(m, "delivered", "bob@example.com");
  assert.equal(m.status, "read");
});

test("duplicate receipts from one recipient are idempotent", () => {
  let m = groupMessage();
  for (let i = 0; i < 5; i++) m = applyReceipt(m, "read", "bob@example.com");
  assert.deepEqual(m.readBy, ["bob@example.com"]);
  assert.equal(m.status, "sent");
});

test("a receipt from someone outside the recipient set cannot complete it", () => {
  const m = applyReceipt(groupMessage(), "read", "stranger@example.com");
  assert.equal(m.status, "sent");
});

test("addresses are compared casefolded", () => {
  let m = applyReceipt(groupMessage(), "read", "BOB@example.com");
  m = applyReceipt(m, "read", "Carol@Example.com".toLowerCase());
  assert.equal(m.status, "read");
});

test("a message with no recorded recipients keeps the old any-receipt reading", () => {
  const legacy = { status: "sent" };
  assert.equal(applyReceipt(legacy, "delivered", null).status, "delivered");
  assert.equal(applyReceipt(legacy, "read", null).status, "read");
});

test("a still-sending message is not promoted by an unrelated receipt", () => {
  const m = applyReceipt(
    { status: "sending", recipients: ["bob@example.com", "carol@example.com"], deliveredTo: [], readBy: [] },
    "delivered",
    "bob@example.com"
  );
  assert.equal(m.status, "sending");
});
