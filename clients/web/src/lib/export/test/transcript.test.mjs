import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatStamp,
  formatTranscript,
  mediaFilename,
  transcriptFilename,
} from "../transcript.mjs";

const NOW = new Date(2026, 8, 29, 14, 5, 0).getTime();
const nameFor = (email) => ({ "b@example.com": "Bob" })[email] ?? email;
const describe = (m) => (m.kind === "media" ? "📷 Photo" : m.body);

const base = {
  chatName: "Bob",
  nameFor,
  describe,
  exportedAtMs: NOW,
};

const msg = (patch) => ({
  id: "m1",
  fromEmail: "b@example.com",
  outgoing: false,
  kind: "text",
  body: "hello",
  sentAtMs: NOW,
  ...patch,
});

test("the header names the chat and counts the messages", () => {
  const out = formatTranscript([msg({})], base);
  assert.match(out, /^Kuchupuchu conversation: Bob\n/);
  assert.match(out, /1 message\n/);
});

test("the count is pluralised", () => {
  assert.match(formatTranscript([msg({}), msg({ id: "m2" })], base), /2 messages/);
});

test("it says up front that disappeared messages are absent", () => {
  // A transcript that silently omits them would read as the whole
  // conversation, which is the one thing it must not imply.
  assert.match(formatTranscript([], base), /already disappeared are not here/);
});

test("each line carries a timestamp and who said it", () => {
  const out = formatTranscript([msg({})], base);
  assert.ok(out.includes(`[${formatStamp(NOW)}] Bob: hello`));
});

test("my own messages are labelled, not named", () => {
  const out = formatTranscript([msg({ outgoing: true, fromEmail: "me@example.com" })], base);
  assert.ok(out.includes("] You: hello"));
});

test("a deleted message says so rather than appearing blank", () => {
  const out = formatTranscript([msg({ deletedForEveryone: true })], base);
  assert.ok(out.includes("<message deleted>"));
});

test("a system notice is marked as one", () => {
  const out = formatTranscript(
    [msg({ kind: "system", body: "Bob set disappearing messages to 7 days" })],
    base
  );
  assert.ok(out.includes("] —: <Bob set disappearing messages to 7 days>"));
});

test("an edit is marked", () => {
  assert.ok(formatTranscript([msg({ editedAtMs: NOW })], base).includes("hello (edited)"));
});

test("a reply quotes what it answered", () => {
  const out = formatTranscript(
    [msg({ replyTo: { id: "x", body: "are you coming", fromEmail: "b@example.com" } })],
    base
  );
  assert.ok(out.includes("[replying to Bob: are you coming] hello"));
});

test("a long quote is truncated rather than reproducing the whole message", () => {
  const long = "x".repeat(200);
  const out = formatTranscript([msg({ replyTo: { id: "x", body: long, fromEmail: "b@example.com" } })], base);
  assert.ok(out.includes("…"));
  assert.ok(!out.includes("x".repeat(100)));
});

test("reactions are listed with who left them", () => {
  const out = formatTranscript([msg({ reactions: { "b@example.com": "👍" } })], base);
  assert.ok(out.includes("[👍 Bob]"));
});

test("without media, an attachment says it was left out", () => {
  const out = formatTranscript(
    [msg({ kind: "media", body: "", media: { mediaId: "x", mime: "image/jpeg" } })],
    base
  );
  assert.ok(out.includes("<media not included in this export>"));
});

test("with media, an attachment points at its file", () => {
  const out = formatTranscript(
    [msg({ kind: "media", body: "", media: { mediaId: "x", mime: "image/jpeg" } })],
    { ...base, includeMedia: true }
  );
  assert.ok(out.includes("-> media/m1.jpeg"));
});

test("a media filename prefers the original name", () => {
  assert.equal(
    mediaFilename(msg({ media: { mediaId: "x", mime: "image/jpeg", name: "beach.jpg" } })),
    "media/m1-beach.jpg"
  );
});

test("a media filename falls back to the mime subtype", () => {
  assert.equal(mediaFilename(msg({ media: { mediaId: "x", mime: "audio/webm;codecs=opus" } })), "media/m1.webm");
});

test("a media filename survives a missing mime", () => {
  assert.equal(mediaFilename(msg({ media: { mediaId: "x" } })), "media/m1.bin");
});

test("the filename is prefixed by the message id so two photos never collide", () => {
  const a = mediaFilename(msg({ id: "aaa", media: { mediaId: "1", name: "IMG.jpg" } }));
  const b = mediaFilename(msg({ id: "bbb", media: { mediaId: "2", name: "IMG.jpg" } }));
  assert.notEqual(a, b);
});

test("the download name is filesystem-safe and dated", () => {
  assert.equal(transcriptFilename("Bob", NOW), "kuchupuchu-Bob-20260929");
  assert.equal(transcriptFilename("Trip: Goa 2026!", NOW), "kuchupuchu-Trip-Goa-2026-20260929");
});

test("a chat name that strips to nothing still yields a filename", () => {
  assert.equal(transcriptFilename("!!!", NOW), "kuchupuchu-chat-20260929");
});

test("the transcript ends with a newline", () => {
  assert.ok(formatTranscript([msg({})], base).endsWith("\n"));
});
