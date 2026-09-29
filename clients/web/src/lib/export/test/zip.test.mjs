import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { buildZip, crc32, dosDateTime, safeEntryName } from "../zip.mjs";

const bytes = (s) => new TextEncoder().encode(s);

test("crc32 matches the published check value", () => {
  // The standard CRC-32 check: "123456789" is 0xCBF43926. If this is wrong
  // every archive is subtly corrupt and only fails at extraction time.
  assert.equal(crc32(bytes("123456789")), 0xcbf43926);
});

test("crc32 of nothing is zero", () => {
  assert.equal(crc32(new Uint8Array()), 0);
});

test("crc32 agrees with zlib over random data", () => {
  // An independent implementation, so this is not the same arithmetic twice.
  const data = new Uint8Array(1024).map((_, i) => (i * 37 + 11) % 256);
  const viaZlib = gunzipViaRoundTrip(data);
  assert.equal(crc32(data), viaZlib);
});

function gunzipViaRoundTrip(data) {
  // gzip stores a CRC32 of the uncompressed data in its trailer; deflate it
  // with zlib and read that field back out.
  const gz = gzipSync(Buffer.from(data));
  assert.deepEqual(new Uint8Array(gunzipSync(gz)), data);
  return gz.readUInt32LE(gz.length - 8);
}

test("the archive begins with the local file header signature", () => {
  const zip = buildZip([{ name: "a.txt", bytes: bytes("hello") }]);
  assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
});

test("the archive ends with the end-of-central-directory record", () => {
  const zip = buildZip([{ name: "a.txt", bytes: bytes("hello") }]);
  const tail = zip.slice(zip.length - 22, zip.length - 18);
  assert.deepEqual(Array.from(tail), [0x50, 0x4b, 0x05, 0x06]);
});

test("the entry count in the trailer matches what went in", () => {
  const zip = buildZip([
    { name: "a.txt", bytes: bytes("one") },
    { name: "b.txt", bytes: bytes("two") },
    { name: "c.txt", bytes: bytes("three") },
  ]);
  const view = new DataView(zip.buffer, zip.byteOffset);
  assert.equal(view.getUint16(zip.length - 22 + 10, true), 3);
});

test("the utf-8 name flag is set", () => {
  const zip = buildZip([{ name: "café.txt", bytes: bytes("x") }]);
  const view = new DataView(zip.buffer, zip.byteOffset);
  // Without bit 11 a reader may decode the name as code page 437.
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800);
});

test("path traversal is stripped from entry names", () => {
  assert.equal(safeEntryName("../../etc/passwd"), "etc/passwd");
  assert.equal(safeEntryName("/absolute/path"), "absolute/path");
  assert.equal(safeEntryName("a/./b"), "a/b");
  assert.equal(safeEntryName("..\\..\\windows"), "windows");
});

test("characters no filesystem accepts are replaced", () => {
  assert.equal(safeEntryName('bad:name*here?.txt'), "bad_name_here_.txt");
});

test("a name that strips to nothing still gets one", () => {
  assert.equal(safeEntryName("../.."), "unnamed");
  assert.equal(safeEntryName(""), "unnamed");
});

test("duplicate names are made unique rather than colliding", () => {
  const zip = buildZip([
    { name: "photo.jpg", bytes: bytes("a") },
    { name: "photo.jpg", bytes: bytes("b") },
    { name: "photo.jpg", bytes: bytes("c") },
  ]);
  const text = Buffer.from(zip).toString("latin1");
  assert.ok(text.includes("photo.jpg"));
  assert.ok(text.includes("photo (2).jpg"));
  assert.ok(text.includes("photo (3).jpg"));
});

test("dos timestamps encode the date and clamp below 1980", () => {
  const { date } = dosDateTime(new Date(1990, 5, 15, 12, 30, 44));
  assert.equal((date >> 9) + 1980, 1990);
  assert.equal((date >> 5) & 0xf, 6);
  assert.equal(date & 0x1f, 15);
  // ZIP cannot represent anything earlier; writing a negative year would
  // produce a date readers reject.
  const { date: floored } = dosDateTime(new Date(1970, 0, 1));
  assert.equal((floored >> 9) + 1980, 1980);
});

test("an empty archive is still a valid one", () => {
  const zip = buildZip([]);
  assert.equal(zip.length, 22);
  assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x05, 0x06]);
});

test("a real unzip accepts the archive and returns the contents", (t) => {
  // The decisive check: everything above tests fields in isolation, and a
  // wrong offset passes all of them while producing a file nothing can open.
  let python;
  try {
    python = execFileSync("python", ["-c", "print(1)"], { encoding: "utf-8" }).trim();
  } catch {
    t.skip("python not available to verify with an independent reader");
    return;
  }
  assert.equal(python, "1");

  const dir = mkdtempSync(join(tmpdir(), "kpzip-"));
  const path = join(dir, "out.zip");
  const zip = buildZip([
    { name: "transcript.txt", bytes: bytes("line one\nline two\n") },
    { name: "media/photo.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]) },
  ]);
  writeFileSync(path, zip);

  // The script goes to a file and the archive path arrives via argv. Building
  // it by interpolating a Windows path into a `python -c` string was one
  // quoting mistake away from Python reading something else entirely, and an
  // archive writer whose verification can misfire is not verified.
  const scriptPath = join(dir, "check.py");
  writeFileSync(
    scriptPath,
    [
      "import json, sys, zipfile",
      "with zipfile.ZipFile(sys.argv[1]) as z:",
      "    print(json.dumps({",
      '        "bad": z.testzip(),',
      '        "names": z.namelist(),',
      '        "transcript": z.read("transcript.txt").decode(),',
      '        "photo": list(z.read("media/photo.jpg")),',
      "    }))",
    ].join("\n")
  );

  const result = JSON.parse(
    execFileSync("python", [scriptPath, path], { encoding: "utf-8" })
  );
  assert.equal(result.bad, null, "zipfile reported a corrupt entry");
  assert.deepEqual(result.names, ["transcript.txt", "media/photo.jpg"]);
  assert.equal(result.transcript, "line one\nline two\n");
  assert.deepEqual(result.photo, [0xff, 0xd8, 0xff, 0xe0, 0x00]);
});
