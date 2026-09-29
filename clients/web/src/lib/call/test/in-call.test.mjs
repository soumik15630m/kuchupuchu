import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HAND_TIMEOUT_MS,
  MAX_CHAT_HISTORY,
  MAX_CHAT_LENGTH,
  appendChat,
  applyHand,
  decodeFrame,
  encodeFrame,
  handOrder,
  mainSpeaker,
  prunePin,
  pruneHands,
  togglePin,
} from "../in-call.mjs";

const NOW = 1_800_000_000_000;
const p = (identity, patch = {}) => ({ identity, isLocal: false, ...patch });

test("a hand frame round-trips", () => {
  assert.deepEqual(decodeFrame(encodeFrame({ t: "hand", up: true })), { t: "hand", up: true });
  assert.deepEqual(decodeFrame(encodeFrame({ t: "hand", up: false })), { t: "hand", up: false });
});

test("a chat frame round-trips", () => {
  assert.deepEqual(decodeFrame(encodeFrame({ t: "chat", body: "can you hear me" })), {
    t: "chat",
    body: "can you hear me",
  });
});

test("a chat body is capped at the wire limit", () => {
  const frame = decodeFrame(encodeFrame({ t: "chat", body: "x".repeat(2000) }));
  assert.equal(frame.body.length, MAX_CHAT_LENGTH);
});

test("an empty chat body is not a frame", () => {
  assert.equal(decodeFrame(encodeFrame({ t: "chat", body: "" })), null);
  assert.equal(decodeFrame(encodeFrame({ t: "chat" })), null);
});

test("garbage from another participant is rejected, not thrown on", () => {
  // This arrives from the network, so it is not trusted input.
  assert.equal(decodeFrame(new TextEncoder().encode("not json")), null);
  assert.equal(decodeFrame(new TextEncoder().encode("[1,2,3]")), null);
  assert.equal(decodeFrame(new TextEncoder().encode("null")), null);
  assert.equal(decodeFrame(encodeFrame({ t: "something-else" })), null);
});

test("chat history is capped", () => {
  let history = [];
  for (let i = 0; i < MAX_CHAT_HISTORY + 20; i += 1) {
    history = appendChat(history, { from: "a", body: String(i), atMs: NOW + i });
  }
  assert.equal(history.length, MAX_CHAT_HISTORY);
  // The oldest go, not the newest.
  assert.equal(history[history.length - 1].body, String(MAX_CHAT_HISTORY + 19));
});

test("raising and lowering a hand", () => {
  const up = applyHand({}, "alice", true, NOW);
  assert.deepEqual(Object.keys(up), ["alice"]);
  assert.deepEqual(applyHand(up, "alice", false, NOW), {});
});

test("applying a hand never mutates what it was given", () => {
  const hands = { alice: NOW };
  applyHand(hands, "bob", true, NOW);
  assert.deepEqual(hands, { alice: NOW });
});

test("a hand left up too long comes down on its own", () => {
  // Otherwise a forgotten hand stops the signal meaning anything.
  const hands = { alice: NOW - HAND_TIMEOUT_MS - 1 };
  assert.deepEqual(pruneHands(hands, ["alice"], NOW), {});
});

test("a hand still within the window stays up", () => {
  const hands = { alice: NOW - 1000 };
  assert.deepEqual(pruneHands(hands, ["alice"], NOW), hands);
});

test("a hand belonging to someone who left is dropped", () => {
  assert.deepEqual(pruneHands({ alice: NOW }, ["bob"], NOW), {});
});

test("hands are listed in the order they went up", () => {
  const hands = { carol: NOW + 20, alice: NOW, bob: NOW + 10 };
  assert.deepEqual(handOrder(hands), ["alice", "bob", "carol"]);
});

test("a pin wins over the active speaker", () => {
  // Someone who pinned did so because the automatic choice was wrong for them.
  const participants = [p("alice"), p("bob")];
  assert.equal(mainSpeaker(participants, "alice", "bob").identity, "alice");
});

test("without a pin the active speaker takes the main tile", () => {
  const participants = [p("alice"), p("bob")];
  assert.equal(mainSpeaker(participants, null, "bob").identity, "bob");
});

test("a pin for someone who has left is ignored", () => {
  const participants = [p("alice")];
  assert.equal(mainSpeaker(participants, "gone", null).identity, "alice");
});

test("with nothing to go on a remote participant is preferred over the local one", () => {
  const participants = [p("me", { isLocal: true }), p("alice")];
  assert.equal(mainSpeaker(participants, null, null).identity, "alice");
});

test("alone in a call, the local tile is the main one", () => {
  // Never nobody: an empty main tile reads as a broken call.
  const participants = [p("me", { isLocal: true })];
  assert.equal(mainSpeaker(participants, null, null).identity, "me");
});

test("no participants means no main tile", () => {
  assert.equal(mainSpeaker([], null, null), null);
});

test("pinning the already-pinned participant unpins", () => {
  assert.equal(togglePin("alice", "alice"), null);
  assert.equal(togglePin("alice", "bob"), "bob");
  assert.equal(togglePin(null, "alice"), "alice");
});

test("a pin is dropped when its participant leaves", () => {
  assert.equal(prunePin("alice", ["bob"]), null);
  assert.equal(prunePin("alice", ["alice", "bob"]), "alice");
  assert.equal(prunePin(null, ["alice"]), null);
});
