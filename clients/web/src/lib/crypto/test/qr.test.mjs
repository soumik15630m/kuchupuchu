import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { QUIET_ZONE, encodeQr, formatBits, qrPath } from "../qr.mjs";

/** Writes the symbol as a plain PGM, which OpenCV reads without any image
 * library on this side. 8 pixels per module and a 4-module quiet zone, both
 * of which a decoder needs. */
function toPgm(matrix, scale = 8) {
  const size = matrix.length;
  const full = (size + QUIET_ZONE * 2) * scale;
  const header = Buffer.from(`P5\n${full} ${full}\n255\n`, "ascii");
  const pixels = Buffer.alloc(full * full, 255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!matrix[y][x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        const row = (y + QUIET_ZONE) * scale + dy;
        const start = row * full + (x + QUIET_ZONE) * scale;
        pixels.fill(0, start, start + scale);
      }
    }
  }
  return Buffer.concat([header, pixels]);
}

function decodeWithOpenCv(t, text) {
  let available = true;
  try {
    execFileSync("python", ["-c", "import cv2"], { stdio: "ignore" });
  } catch {
    available = false;
  }
  if (!available) {
    t.skip("OpenCV not available to decode with an independent reader");
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), "kpqr-"));
  const imagePath = join(dir, "qr.pgm");
  const scriptPath = join(dir, "decode.py");
  writeFileSync(imagePath, toPgm(encodeQr(text).matrix));
  writeFileSync(
    scriptPath,
    [
      "import json, sys, cv2",
      "img = cv2.imread(sys.argv[1], cv2.IMREAD_GRAYSCALE)",
      "value, points, _ = cv2.QRCodeDetector().detectAndDecode(img)",
      "print(json.dumps({'value': value, 'found': points is not None}))",
    ].join("\n")
  );
  return JSON.parse(execFileSync("python", [scriptPath, imagePath], { encoding: "utf-8" }));
}

test("a safety number round-trips through an independent decoder", (t) => {
  // The decisive check. Every structural assertion below can pass while the
  // symbol is unscannable; only a real decoder settles it.
  const text = "38471 92058 11746 38290 55013 88264 19305 77428 60193 42815";
  const result = decodeWithOpenCv(t, text);
  if (!result) return;
  assert.equal(result.value, text);
});

test("short text round-trips", (t) => {
  const result = decodeWithOpenCv(t, "kuchupuchu");
  if (!result) return;
  assert.equal(result.value, "kuchupuchu");
});

test("a payload needing a larger version round-trips", (t) => {
  // Long enough to push past version 1-2 and exercise multi-block
  // interleaving, which single-block versions never touch.
  const text = "kuchupuchu:verify:" + "9182736450".repeat(12);
  const result = decodeWithOpenCv(t, text);
  if (!result) return;
  assert.equal(result.value, text);
});

test("non-ascii survives, since byte mode carries utf-8", (t) => {
  const text = "проверка कुचुपुचु";
  const result = decodeWithOpenCv(t, text);
  if (!result) return;
  assert.equal(result.value, text);
});

test("the version grows with the payload", () => {
  assert.equal(encodeQr("hi").version, 1);
  assert.ok(encodeQr("x".repeat(100)).version > 1);
  assert.ok(encodeQr("x".repeat(200)).version > encodeQr("x".repeat(100)).version);
});

test("a payload beyond version 10 is refused rather than silently truncated", () => {
  assert.throws(() => encodeQr("x".repeat(500)), /too large/);
});

test("the matrix is square and the right size for its version", () => {
  const { matrix, size, version } = encodeQr("hello");
  assert.equal(size, version * 4 + 17);
  assert.equal(matrix.length, size);
  for (const row of matrix) assert.equal(row.length, size);
});

test("every module is decided", () => {
  // A null anywhere means data placement missed a cell, which a decoder reads
  // as whatever the array coerces to.
  const { matrix } = encodeQr("hello");
  for (const row of matrix) for (const cell of row) assert.ok(cell === 0 || cell === 1);
});

test("the three finder patterns are present", () => {
  const { matrix, size } = encodeQr("hello");
  const finderAt = (ox, oy) =>
    matrix[oy][ox] === 1 &&
    matrix[oy + 1][ox + 1] === 0 &&
    matrix[oy + 2][ox + 2] === 1 &&
    matrix[oy + 3][ox + 3] === 1;
  assert.ok(finderAt(0, 0), "top-left");
  assert.ok(finderAt(size - 7, 0), "top-right");
  assert.ok(finderAt(0, size - 7), "bottom-left");
});

test("the dark module is dark", () => {
  // Required by the spec at (8, size - 8) and easy to lose when reserving
  // the format strips.
  const { matrix, size } = encodeQr("hello");
  assert.equal(matrix[size - 8][8], 1);
});

test("the timing patterns alternate", () => {
  const { matrix, size } = encodeQr("hello");
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(matrix[6][i], i % 2 === 0 ? 1 : 0, `horizontal at ${i}`);
    assert.equal(matrix[i][6], i % 2 === 0 ? 1 : 0, `vertical at ${i}`);
  }
});

test("format bits match the values published in the spec", () => {
  // ISO/IEC 18004 Table C.1, the level-M rows specifically. Wrong here and no
  // scanner can even work out which mask to undo.
  assert.equal(formatBits(0, 0), 0x5412);
  assert.equal(formatBits(0, 1), 0x5125);
  assert.equal(formatBits(0, 2), 0x5e7c);
  assert.equal(formatBits(0, 7), 0x4aa0);
});

test("the chosen mask is one of the eight", () => {
  const { mask } = encodeQr("hello");
  assert.ok(mask >= 0 && mask <= 7);
});

test("the svg path has one square per dark module", () => {
  const { matrix } = encodeQr("hello");
  const dark = matrix.flat().filter((v) => v === 1).length;
  assert.equal(qrPath(matrix).split("M").length - 1, dark);
});

test("encoding is deterministic", () => {
  assert.deepEqual(encodeQr("same input").matrix, encodeQr("same input").matrix);
});
