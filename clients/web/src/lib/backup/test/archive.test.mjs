import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ARCHIVE_MAGIC,
  ArchiveError,
  MANIFEST_GZIP,
  MANIFEST_RAW,
  packArchive,
  unpackArchive,
} from "../archive.mjs";

const bytes = (...n) => new Uint8Array(n);
const HEADER = ARCHIVE_MAGIC.length + 1 + 4;

/** Builds an archive by hand so the failure cases can describe shapes that
 * packArchive would never produce. */
function handBuilt(manifestObject, trailing = 0, encoding = MANIFEST_RAW) {
  const enc = new TextEncoder();
  const manifest = enc.encode(JSON.stringify(manifestObject));
  const out = new Uint8Array(HEADER + manifest.length + trailing);
  out.set(enc.encode(ARCHIVE_MAGIC), 0);
  out[ARCHIVE_MAGIC.length] = encoding;
  new DataView(out.buffer).setUint32(ARCHIVE_MAGIC.length + 1, manifest.length, true);
  out.set(manifest, HEADER);
  return out;
}

test("a manifest round-trips with no blobs", async () => {
  const packed = await packArchive({ email: "a@b.c", messages: [{ id: "1" }] }, []);
  const { manifest, blobs } = await unpackArchive(packed);
  assert.equal(manifest.email, "a@b.c");
  assert.deepEqual(manifest.messages, [{ id: "1" }]);
  assert.equal(blobs.size, 0);
});

test("blobs round-trip byte for byte", async () => {
  const a = bytes(1, 2, 3, 4, 5);
  const b = bytes(255, 0, 128);
  const packed = await packArchive({}, [
    { id: "m1", mime: "image/jpeg", bytes: a },
    { id: "m2", mime: "audio/webm", bytes: b },
  ]);
  const { blobs } = await unpackArchive(packed);
  assert.deepEqual([...blobs.get("m1").bytes], [...a]);
  assert.deepEqual([...blobs.get("m2").bytes], [...b]);
  assert.equal(blobs.get("m1").mime, "image/jpeg");
});

test("an empty blob is preserved rather than dropped", async () => {
  const { blobs } = await unpackArchive(
    await packArchive({}, [{ id: "e", mime: "x/y", bytes: bytes() }])
  );
  assert.equal(blobs.has("e"), true);
  assert.equal(blobs.get("e").bytes.length, 0);
});

test("non-ascii survives the manifest", async () => {
  const packed = await packArchive({ note: "Привет · नमस्ते · 😀" }, []);
  assert.equal((await unpackArchive(packed)).manifest.note, "Привет · नमस्ते · 😀");
});

test("non-ascii survives a compressed manifest too", async () => {
  // Long enough to cross the compression threshold, so this exercises the
  // gzip path rather than the raw one.
  const note = "Привет · नमस्ते · 😀 ".repeat(200);
  const packed = await packArchive({ note }, []);
  assert.equal(packed[ARCHIVE_MAGIC.length], MANIFEST_GZIP);
  assert.equal((await unpackArchive(packed)).manifest.note, note);
});

test("a large blob keeps its exact length", async () => {
  const big = new Uint8Array(100_000).map((_, i) => i % 251);
  const { blobs } = await unpackArchive(await packArchive({}, [{ id: "big", mime: "x", bytes: big }]));
  assert.equal(blobs.get("big").bytes.length, big.length);
  assert.equal(blobs.get("big").bytes[99_999], big[99_999]);
});

test("the version is stamped and the blob index is not leaked into the manifest", async () => {
  const { manifest } = await unpackArchive(
    await packArchive({}, [{ id: "m", mime: "x", bytes: bytes(1) }])
  );
  assert.equal(manifest.version, 1);
  assert.equal("blobs" in manifest, false);
});

test("a small manifest is left uncompressed", async () => {
  // Below the threshold gzip's header and trailer cost more than they save.
  const packed = await packArchive({ n: 1 }, []);
  assert.equal(packed[ARCHIVE_MAGIC.length], MANIFEST_RAW);
});

test("a repetitive manifest compresses and still reads back", async () => {
  const messages = Array.from({ length: 400 }, (_, i) => ({
    id: `id-${i}`,
    chatId: "alice@example.com",
    body: `an ordinary chat message number ${i}`,
    sentAtMs: 1_700_000_000_000 + i,
  }));
  const packed = await packArchive({ messages }, []);
  assert.equal(packed[ARCHIVE_MAGIC.length], MANIFEST_GZIP);

  const rawSize = new TextEncoder().encode(
    JSON.stringify({ messages, version: 1, blobs: [] })
  ).length;
  assert.ok(packed.length < rawSize / 4, `expected a big win, got ${packed.length} vs ${rawSize}`);

  const { manifest } = await unpackArchive(packed);
  assert.equal(manifest.messages.length, 400);
  assert.equal(manifest.messages[399].body, messages[399].body);
});

test("compression applies to the manifest only, leaving blobs byte-identical", async () => {
  // Media is already entropy-coded; the point of compressing only the
  // manifest is that the blob section is copied through untouched.
  const media = new Uint8Array(3000).map((_, i) => (i * 37) % 256);
  const messages = Array.from({ length: 300 }, (_, i) => ({ id: `${i}`, body: `message ${i}` }));
  const packed = await packArchive({ messages }, [{ id: "m", mime: "image/jpeg", bytes: media }]);
  assert.equal(packed[ARCHIVE_MAGIC.length], MANIFEST_GZIP);

  const { blobs } = await unpackArchive(packed);
  assert.deepEqual([...blobs.get("m").bytes], [...media]);
  // The blob section is stored raw, so it is still findable verbatim.
  assert.ok(packed.length > media.length);
});

test("something that is not an archive is refused", async () => {
  await assert.rejects(
    () => unpackArchive(new TextEncoder().encode("hello there friend")),
    ArchiveError
  );
});

test("a truncated archive is refused rather than read out of bounds", async () => {
  const packed = await packArchive({}, [{ id: "m", mime: "x", bytes: bytes(1, 2, 3) }]);
  await assert.rejects(() => unpackArchive(packed.subarray(0, packed.length - 2)), ArchiveError);
  await assert.rejects(() => unpackArchive(packed.subarray(0, 3)), ArchiveError);
});

test("a manifest pointing past the data is refused", async () => {
  const out = handBuilt({ version: 1, blobs: [{ id: "x", mime: "x", offset: 0, length: 9999 }] }, 2);
  await assert.rejects(() => unpackArchive(out), ArchiveError);
});

test("a future archive version is refused with a useful message", async () => {
  await assert.rejects(() => unpackArchive(handBuilt({ version: 99, blobs: [] })), /newer version/);
});

test("an unknown manifest encoding is refused rather than guessed at", async () => {
  const out = handBuilt({ version: 1, blobs: [] }, 0, 7);
  await assert.rejects(() => unpackArchive(out), /encoding this version does not know/);
});

test("a manifest claiming gzip but holding garbage is refused", async () => {
  const out = handBuilt({ version: 1, blobs: [] }, 0, MANIFEST_GZIP);
  await assert.rejects(() => unpackArchive(out), /decompressed/);
});
