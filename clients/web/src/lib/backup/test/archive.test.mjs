import assert from "node:assert/strict";
import { test } from "node:test";

import { ARCHIVE_MAGIC, ArchiveError, packArchive, unpackArchive } from "../archive.mjs";

const bytes = (...n) => new Uint8Array(n);

test("a manifest round-trips with no blobs", () => {
  const packed = packArchive({ email: "a@b.c", messages: [{ id: "1" }] }, []);
  const { manifest, blobs } = unpackArchive(packed);
  assert.equal(manifest.email, "a@b.c");
  assert.deepEqual(manifest.messages, [{ id: "1" }]);
  assert.equal(blobs.size, 0);
});

test("blobs round-trip byte for byte", () => {
  const a = bytes(1, 2, 3, 4, 5);
  const b = bytes(255, 0, 128);
  const packed = packArchive({}, [
    { id: "m1", mime: "image/jpeg", bytes: a },
    { id: "m2", mime: "audio/webm", bytes: b },
  ]);
  const { blobs } = unpackArchive(packed);
  assert.deepEqual([...blobs.get("m1").bytes], [...a]);
  assert.deepEqual([...blobs.get("m2").bytes], [...b]);
  assert.equal(blobs.get("m1").mime, "image/jpeg");
});

test("an empty blob is preserved rather than dropped", () => {
  const { blobs } = unpackArchive(packArchive({}, [{ id: "e", mime: "x/y", bytes: bytes() }]));
  assert.equal(blobs.has("e"), true);
  assert.equal(blobs.get("e").bytes.length, 0);
});

test("non-ascii survives the manifest", () => {
  const packed = packArchive({ note: "Привет · नमस्ते · 😀" }, []);
  assert.equal(unpackArchive(packed).manifest.note, "Привет · नमस्ते · 😀");
});

test("a large blob keeps its exact length", () => {
  const big = new Uint8Array(100_000).map((_, i) => i % 251);
  const { blobs } = unpackArchive(packArchive({}, [{ id: "big", mime: "x", bytes: big }]));
  assert.equal(blobs.get("big").bytes.length, big.length);
  assert.equal(blobs.get("big").bytes[99_999], big[99_999]);
});

test("the version is stamped and the blob index is not leaked into the manifest", () => {
  const { manifest } = unpackArchive(packArchive({}, [{ id: "m", mime: "x", bytes: bytes(1) }]));
  assert.equal(manifest.version, 1);
  assert.equal("blobs" in manifest, false);
});

test("something that is not an archive is refused", () => {
  assert.throws(() => unpackArchive(new TextEncoder().encode("hello there friend")), ArchiveError);
});

test("a truncated archive is refused rather than read out of bounds", () => {
  const packed = packArchive({}, [{ id: "m", mime: "x", bytes: bytes(1, 2, 3) }]);
  assert.throws(() => unpackArchive(packed.subarray(0, packed.length - 2)), ArchiveError);
  assert.throws(() => unpackArchive(packed.subarray(0, 3)), ArchiveError);
});

test("a manifest pointing past the data is refused", () => {
  // Hand-built: the index claims a blob far longer than what follows, which
  // is what a corrupted or forged archive looks like.
  const enc = new TextEncoder();
  const manifest = enc.encode(JSON.stringify({ version: 1, blobs: [{ id: "x", mime: "x", offset: 0, length: 9999 }] }));
  const out = new Uint8Array(ARCHIVE_MAGIC.length + 4 + manifest.length + 2);
  out.set(enc.encode(ARCHIVE_MAGIC), 0);
  new DataView(out.buffer).setUint32(ARCHIVE_MAGIC.length, manifest.length, true);
  out.set(manifest, ARCHIVE_MAGIC.length + 4);
  assert.throws(() => unpackArchive(out), ArchiveError);
});

test("a future archive version is refused with a useful message", () => {
  const enc = new TextEncoder();
  const manifest = enc.encode(JSON.stringify({ version: 99, blobs: [] }));
  const out = new Uint8Array(ARCHIVE_MAGIC.length + 4 + manifest.length);
  out.set(enc.encode(ARCHIVE_MAGIC), 0);
  new DataView(out.buffer).setUint32(ARCHIVE_MAGIC.length, manifest.length, true);
  out.set(manifest, ARCHIVE_MAGIC.length + 4);
  assert.throws(() => unpackArchive(out), /newer version/);
});
