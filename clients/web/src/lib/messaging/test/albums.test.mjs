import assert from "node:assert/strict";
import { test } from "node:test";

import { ALBUM_GAP_MS, ALBUM_MAX, albumColumns, albumKey, groupIntoAlbums } from "../albums.mjs";

const NOW = 1_800_000_000_000;
let seq = 0;
const photo = (patch = {}) => ({
  id: `p${seq++}`,
  kind: "media",
  fromEmail: "a@example.com",
  body: "",
  sentAtMs: NOW,
  ...patch,
});
const text = (patch = {}) => ({ ...photo(), kind: "text", body: "hi", ...patch });

const shape = (grouped) =>
  grouped.map((g) => (g.type === "album" ? `album(${g.messages.length})` : `message`));

test("photos sent together become one album", () => {
  const grouped = groupIntoAlbums([
    photo({ sentAtMs: NOW }),
    photo({ sentAtMs: NOW + 500 }),
    photo({ sentAtMs: NOW + 900 }),
  ]);
  assert.deepEqual(shape(grouped), ["album(3)"]);
});

test("a single photo stays a plain message", () => {
  // Rendered as a one-cell grid it would look different from the same photo
  // sent on its own, for no reason the member could explain.
  assert.deepEqual(shape(groupIntoAlbums([photo()])), ["message"]);
});

test("photos far apart in time are separate", () => {
  const grouped = groupIntoAlbums([
    photo({ sentAtMs: NOW }),
    photo({ sentAtMs: NOW + ALBUM_GAP_MS + 1 }),
  ]);
  assert.deepEqual(shape(grouped), ["message", "message"]);
});

test("photos from different people never share an album", () => {
  const grouped = groupIntoAlbums([
    photo({ fromEmail: "a@example.com" }),
    photo({ fromEmail: "b@example.com", sentAtMs: NOW + 100 }),
  ]);
  assert.deepEqual(shape(grouped), ["message", "message"]);
});

test("a text message between photos breaks the run", () => {
  const grouped = groupIntoAlbums([
    photo({ sentAtMs: NOW }),
    photo({ sentAtMs: NOW + 100 }),
    text({ sentAtMs: NOW + 200 }),
    photo({ sentAtMs: NOW + 300 }),
    photo({ sentAtMs: NOW + 400 }),
  ]);
  assert.deepEqual(shape(grouped), ["album(2)", "message", "album(2)"]);
});

test("a captioned photo is never absorbed into a grid", () => {
  // The caption is the point of that message; a grid has nowhere to show it.
  const grouped = groupIntoAlbums([
    photo({ sentAtMs: NOW }),
    photo({ sentAtMs: NOW + 100, body: "look at this" }),
    photo({ sentAtMs: NOW + 200 }),
  ]);
  assert.deepEqual(shape(grouped), ["message", "message", "message"]);
});

test("a view-once photo stays on its own", () => {
  const grouped = groupIntoAlbums([
    photo({ sentAtMs: NOW, viewOnce: true }),
    photo({ sentAtMs: NOW + 100 }),
  ]);
  assert.deepEqual(shape(grouped), ["message", "message"]);
});

test("a deleted photo does not join an album", () => {
  const grouped = groupIntoAlbums([
    photo({ sentAtMs: NOW }),
    photo({ sentAtMs: NOW + 100, deletedForEveryone: true }),
    photo({ sentAtMs: NOW + 200 }),
  ]);
  assert.deepEqual(shape(grouped), ["message", "message", "message"]);
});

test("a photo that is a reply stays addressable on its own", () => {
  const grouped = groupIntoAlbums([
    photo({ sentAtMs: NOW }),
    photo({ sentAtMs: NOW + 100, replyTo: { id: "x", body: "q", fromEmail: "b@example.com" } }),
  ]);
  assert.deepEqual(shape(grouped), ["message", "message"]);
});

test("a long run spills into a second album rather than hiding the rest", () => {
  const many = Array.from({ length: ALBUM_MAX + 3 }, (_, i) => photo({ sentAtMs: NOW + i * 10 }));
  assert.deepEqual(shape(groupIntoAlbums(many)), [`album(${ALBUM_MAX})`, "album(3)"]);
});

test("non-media messages pass through untouched and in order", () => {
  const a = text({ body: "one" });
  const b = text({ body: "two" });
  const grouped = groupIntoAlbums([a, b]);
  assert.deepEqual(
    grouped.map((g) => g.message.body),
    ["one", "two"]
  );
});

test("an empty chat groups to nothing", () => {
  assert.deepEqual(groupIntoAlbums([]), []);
});

test("column counts match what the eye expects", () => {
  assert.equal(albumColumns(1), 1);
  assert.equal(albumColumns(2), 2);
  assert.equal(albumColumns(3), 3);
  assert.equal(albumColumns(4), 2);
  assert.equal(albumColumns(5), 3);
  assert.equal(albumColumns(9), 3);
});

test("the album key changes when its membership does", () => {
  const first = photo({ id: "one" });
  const second = photo({ id: "two" });
  assert.notEqual(albumKey([first, second]), albumKey([first]));
});
