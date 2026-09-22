import assert from "node:assert/strict";
import { test } from "node:test";

import { packArchive, unpackArchive } from "../archive.mjs";
import {
  BackupError,
  ENVELOPE_MAGIC,
  openBackup,
  readEnvelopeHeader,
  sealBackup,
} from "../envelope.mjs";

// Real WebCrypto, real PBKDF2 — but a low count, because 600k iterations per
// assertion would make this suite take minutes. The count travels in the
// header, so exercising it at 1000 exercises the same code path.
const FAST = 1000;

test("a sealed backup opens with the right passphrase", async () => {
  const sealed = await sealBackup(new TextEncoder().encode("hello"), "correct horse", FAST);
  const opened = await openBackup(sealed, "correct horse");
  assert.equal(new TextDecoder().decode(opened), "hello");
});

test("the wrong passphrase does not open it", async () => {
  const sealed = await sealBackup(new TextEncoder().encode("hello"), "right", FAST);
  await assert.rejects(() => openBackup(sealed, "wrong"), BackupError);
});

test("a passphrase differing only in unicode form still opens it", async () => {
  // "é" composed vs decomposed. Someone typing the same passphrase on a
  // different keyboard must not be locked out of their own history.
  const sealed = await sealBackup(new TextEncoder().encode("x"), "caf\u00e9", FAST);
  const opened = await openBackup(sealed, "cafe\u0301", FAST);
  assert.equal(new TextDecoder().decode(opened), "x");
});

test("an empty passphrase is still a passphrase, not a bypass", async () => {
  const sealed = await sealBackup(new TextEncoder().encode("x"), "", FAST);
  await assert.rejects(() => openBackup(sealed, "not empty"), BackupError);
  assert.equal(new TextDecoder().decode(await openBackup(sealed, "")), "x");
});

test("two seals of the same data differ, so the server learns nothing from repeats", async () => {
  const data = new TextEncoder().encode("same every night");
  const a = await sealBackup(data, "pass", FAST);
  const b = await sealBackup(data, "pass", FAST);
  assert.notDeepEqual([...a], [...b]);
});

test("the header is readable without the passphrase", async () => {
  const sealed = await sealBackup(new TextEncoder().encode("x"), "pass", FAST);
  const header = readEnvelopeHeader(sealed);
  assert.equal(header.iterations, FAST);
  assert.equal(header.salt.length, 16);
  assert.equal(header.iv.length, 12);
});

test("flipping one ciphertext byte is detected", async () => {
  const sealed = await sealBackup(new TextEncoder().encode("hello"), "pass", FAST);
  sealed[sealed.length - 1] ^= 0x01;
  await assert.rejects(() => openBackup(sealed, "pass"), BackupError);
});

test("tampering with the iterations in the header is detected", async () => {
  // Not authenticated as AAD, but it changes the derived key, so GCM fails.
  const sealed = await sealBackup(new TextEncoder().encode("hello"), "pass", FAST);
  sealed[ENVELOPE_MAGIC.length + 1] ^= 0x02;
  await assert.rejects(() => openBackup(sealed, "pass"), BackupError);
});

test("a file that is not a backup is refused before any key derivation", () => {
  assert.throws(() => readEnvelopeHeader(new TextEncoder().encode("not a backup at all")), /does not look like/);
});

test("an unknown kdf id is refused rather than guessed at", async () => {
  const sealed = await sealBackup(new TextEncoder().encode("x"), "pass", FAST);
  sealed[ENVELOPE_MAGIC.length] = 99;
  assert.throws(() => readEnvelopeHeader(sealed), /key derivation/);
});

test("a full archive survives seal and open", async () => {
  const media = new Uint8Array(5000).map((_, i) => i % 256);
  const packed = packArchive(
    { email: "a@b.c", messages: [{ id: "1", body: "привет" }] },
    [{ id: "m1", mime: "image/jpeg", bytes: media }]
  );
  const sealed = await sealBackup(packed, "a long backup passphrase", FAST);
  const { manifest, blobs } = unpackArchive(await openBackup(sealed, "a long backup passphrase"));
  assert.equal(manifest.messages[0].body, "привет");
  assert.deepEqual([...blobs.get("m1").bytes], [...media]);
});
