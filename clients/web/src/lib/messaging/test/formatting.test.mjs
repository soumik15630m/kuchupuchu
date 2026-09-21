import { test } from "node:test";
import assert from "node:assert/strict";

import { isSafeHref, mentionedEmails, parseMessage, plainText } from "../formatting.mjs";

const people = new Map([
  ["alice", "alice@example.com"],
  ["bob.smith", "bob@example.com"],
]);

const types = (segments) => segments.map((s) => s.type);
const text = (segments) => segments.map((s) => s.value).join("");

test("plain text is one segment", () => {
  assert.deepEqual(parseMessage("hello"), [{ type: "text", value: "hello" }]);
});

test("each marker produces its own segment type", () => {
  assert.equal(parseMessage("*b*")[0].type, "bold");
  assert.equal(parseMessage("_i_")[0].type, "italic");
  assert.equal(parseMessage("~s~")[0].type, "strike");
  assert.equal(parseMessage("```m```")[0].type, "mono");
});

test("formatting keeps the surrounding text", () => {
  const segments = parseMessage("say *this* now");
  assert.deepEqual(types(segments), ["text", "bold", "text"]);
  assert.equal(text(segments), "say this now");
});

test("an unmatched marker stays literal", () => {
  // Otherwise "2 * 3" would swallow the rest of the message.
  assert.deepEqual(parseMessage("2 * 3"), [{ type: "text", value: "2 * 3" }]);
});

test("an empty marker pair is literal", () => {
  assert.deepEqual(parseMessage("**"), [{ type: "text", value: "**" }]);
});

test("formatting nests", () => {
  const [bold] = parseMessage("*_both_*");
  assert.equal(bold.type, "bold");
  assert.equal(bold.children[0].type, "italic");
});

test("monospace does not format its contents", () => {
  const [mono] = parseMessage("```*not bold*```");
  assert.equal(mono.type, "mono");
  assert.deepEqual(mono.children, [{ type: "text", value: "*not bold*" }]);
});

test("a url becomes a link with an https href", () => {
  const [link] = parseMessage("see https://example.com/x");
  assert.equal(link.type, "text");
  const segments = parseMessage("https://example.com/x");
  assert.equal(segments[0].type, "link");
  assert.equal(segments[0].href, "https://example.com/x");
});

test("a bare www address is linked over https", () => {
  const [link] = parseMessage("www.example.com");
  assert.equal(link.type, "link");
  assert.equal(link.href, "https://www.example.com");
});

test("trailing punctuation is not swallowed into the link", () => {
  const segments = parseMessage("go to https://example.com.");
  const link = segments.find((s) => s.type === "link");
  assert.equal(link.value, "https://example.com");
});

test("dangerous schemes never become links", () => {
  // The body is attacker-controlled; javascript: as an href is the whole risk.
  assert.equal(isSafeHref("javascript:alert(1)"), false);
  assert.equal(isSafeHref("data:text/html,<script>"), false);
  assert.equal(isSafeHref("https://example.com"), true);
  assert.equal(parseMessage("javascript:alert(1)").every((s) => s.type !== "link"), true);
});

test("a known username becomes a mention", () => {
  const segments = parseMessage("hey @alice", people);
  const mention = segments.find((s) => s.type === "mention");
  assert.equal(mention.value, "@alice");
  assert.equal(mention.email, "alice@example.com");
});

test("an unknown handle stays plain text", () => {
  const segments = parseMessage("hey @nobody", people);
  assert.equal(segments.every((s) => s.type !== "mention"), true);
});

test("a dotted username mentions correctly", () => {
  const segments = parseMessage("@bob.smith hello", people);
  assert.equal(segments[0].type, "mention");
  assert.equal(segments[0].email, "bob@example.com");
});

test("mentions inside formatting are still found", () => {
  assert.deepEqual(mentionedEmails("*ping @alice*", people), ["alice@example.com"]);
});

test("mentionedEmails deduplicates", () => {
  assert.deepEqual(mentionedEmails("@alice @alice", people), ["alice@example.com"]);
});

test("an email address is not mistaken for a mention", () => {
  const segments = parseMessage("write to alice@example.com", people);
  assert.equal(segments.every((s) => s.type !== "mention"), true);
});

test("plainText strips markers for previews and search", () => {
  assert.equal(plainText("*bold* and _italic_"), "bold and italic");
});

test("a message with no body parses to nothing", () => {
  assert.deepEqual(parseMessage(""), []);
});
