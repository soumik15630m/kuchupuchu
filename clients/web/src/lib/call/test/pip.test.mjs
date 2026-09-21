import assert from "node:assert/strict";
import { test } from "node:test";

import { pickPipParticipant, pipSupported } from "../pip.mjs";

const who = (identity, extra = {}) => ({
  identity,
  email: `${identity}@example.test`,
  isLocal: false,
  videoTrack: {},
  speaking: false,
  sharingScreen: false,
  ...extra,
});

test("nobody on camera means nothing to float", () => {
  assert.equal(pickPipParticipant([]), null);
  assert.equal(pickPipParticipant([who("a", { videoTrack: null })]), null);
});

test("your own camera is never picked", () => {
  assert.equal(pickPipParticipant([who("me", { isLocal: true })]), null);
});

test("a screen share beats the active speaker", () => {
  const share = who("b", { sharingScreen: true });
  const picked = pickPipParticipant([who("a", { speaking: true }), share]);
  assert.equal(picked, share);
});

test("the active speaker beats a silent participant", () => {
  const loud = who("b", { speaking: true });
  const picked = pickPipParticipant([who("a"), loud]);
  assert.equal(picked, loud);
});

test("with nothing to distinguish them the first remote wins", () => {
  const first = who("a");
  assert.equal(pickPipParticipant([who("me", { isLocal: true }), first, who("b")]), first);
});

test("a local screen share does not override a remote one", () => {
  const remote = who("b", { sharingScreen: true });
  const picked = pickPipParticipant([who("me", { isLocal: true, sharingScreen: true }), remote]);
  assert.equal(picked, remote);
});

test("support is false without a document", () => {
  assert.equal(pipSupported(null), false);
});

test("support is false when the document disables it", () => {
  assert.equal(pipSupported({ pictureInPictureEnabled: false }), false);
});
