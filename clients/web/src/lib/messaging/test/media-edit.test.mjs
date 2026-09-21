import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampCrop,
  cropForAspect,
  cropPixels,
  intoCrop,
  normaliseRotation,
  pointIn,
  rotatedSize,
} from "../media-edit.mjs";

test("quarter turns swap the axes, half turns do not", () => {
  assert.deepEqual(rotatedSize(1600, 900, 0), { width: 1600, height: 900 });
  assert.deepEqual(rotatedSize(1600, 900, 90), { width: 900, height: 1600 });
  assert.deepEqual(rotatedSize(1600, 900, 180), { width: 1600, height: 900 });
  assert.deepEqual(rotatedSize(1600, 900, 270), { width: 900, height: 1600 });
});

test("rotation wraps in both directions", () => {
  assert.equal(normaliseRotation(360), 0);
  assert.equal(normaliseRotation(450), 90);
  assert.equal(normaliseRotation(-90), 270);
});

test("a crop cannot escape the image", () => {
  assert.deepEqual(clampCrop({ x: -0.5, y: 0.9, w: 0.5, h: 0.5 }), {
    x: 0,
    y: 0.5,
    w: 0.5,
    h: 0.5,
  });
});

test("a crop cannot collapse to nothing", () => {
  const rect = clampCrop({ x: 0.5, y: 0.5, w: 0, h: -1 });
  assert.equal(rect.w, 0.05);
  assert.equal(rect.h, 0.05);
});

test("a square crop of a landscape image is a square on screen", () => {
  // 1600x900 is 16:9; a 1:1 crop should be as tall as the image and
  // 9/16 of its width.
  const crop = cropForAspect(1, 1600 / 900);
  assert.equal(crop.h, 1);
  assert.ok(Math.abs(crop.w - 900 / 1600) < 1e-9);
  assert.ok(Math.abs(crop.x - (1 - 900 / 1600) / 2) < 1e-9);
});

test("a wider-than-the-image aspect is limited by width", () => {
  const crop = cropForAspect(16 / 9, 1);
  assert.equal(crop.w, 1);
  assert.ok(Math.abs(crop.h - 9 / 16) < 1e-9);
});

test("an aspect matching the image fills it", () => {
  const crop = cropForAspect(4 / 5, 4 / 5);
  assert.deepEqual(crop, { x: 0, y: 0, w: 1, h: 1 });
});

test("crop pixels are taken from the rotated size", () => {
  const crop = { x: 0.5, y: 0, w: 0.5, h: 1 };
  assert.deepEqual(cropPixels(crop, 1600, 900, 0), { x: 800, y: 0, w: 800, h: 900 });
  // After a quarter turn the same crop is the right half of a 900x1600 frame.
  assert.deepEqual(cropPixels(crop, 1600, 900, 90), { x: 450, y: 0, w: 450, h: 1600 });
});

test("a crop never exports a zero-pixel canvas", () => {
  const pixels = cropPixels({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, 10, 10, 0);
  assert.equal(pixels.w, 1);
  assert.equal(pixels.h, 1);
});

test("pointer positions are clamped to the preview box", () => {
  const box = { left: 100, top: 50, width: 200, height: 100 };
  assert.deepEqual(pointIn(box, 200, 100), { x: 0.5, y: 0.5 });
  assert.deepEqual(pointIn(box, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(pointIn(box, 9999, 9999), { x: 1, y: 1 });
});

test("a zero-width box does not divide by zero", () => {
  const point = pointIn({ left: 0, top: 0, width: 0, height: 0 }, 5, 5);
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
});

test("annotations move with the crop, and can land outside it", () => {
  const crop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  assert.deepEqual(intoCrop({ x: 0.5, y: 0.5 }, crop), { x: 0.5, y: 0.5 });
  assert.deepEqual(intoCrop({ x: 0.25, y: 0.25 }, crop), { x: 0, y: 0 });
  const outside = intoCrop({ x: 0.1, y: 0.1 }, crop);
  assert.ok(outside.x < 0 && outside.y < 0);
});
