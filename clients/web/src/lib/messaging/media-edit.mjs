/** Geometry for the media editor.
 *
 * Every rectangle here is normalised to 0..1 of the *rotated* image, so the
 * same numbers describe the crop whether the preview is 320px wide on a phone
 * or the full-resolution export. Pixel coordinates would have to be rescaled
 * at export time, and any rounding there shows up as a one-pixel seam.
 */

export const FULL_CROP = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

/** Rotation swaps the axes on the quarter turns, which changes what "16:9"
 * means — so callers must ask for the rotated size, not the natural one. */
export function rotatedSize(width, height, rotation) {
  const turns = normaliseRotation(rotation);
  return turns === 90 || turns === 270 ? { width: height, height: width } : { width, height };
}

export function normaliseRotation(rotation) {
  const turns = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  return turns;
}

/** Keeps a dragged rectangle inside the image and above a floor size. A crop
 * that collapses to zero area exports a blank canvas, which looks like a bug
 * rather than an empty selection. */
export function clampCrop(rect, minSize = 0.05) {
  const w = Math.min(1, Math.max(minSize, rect.w));
  const h = Math.min(1, Math.max(minSize, rect.h));
  return {
    x: Math.min(Math.max(0, rect.x), 1 - w),
    y: Math.min(Math.max(0, rect.y), 1 - h),
    w,
    h,
  };
}

/** Fits the largest rectangle of `aspect` (w/h) inside the image, centred.
 * `imageAspect` is the rotated image's own w/h, because normalised units are
 * square and would otherwise report every crop as 1:1. */
export function cropForAspect(aspect, imageAspect) {
  if (!aspect || aspect <= 0) return { ...FULL_CROP };
  // In normalised space a rectangle of on-screen aspect `a` has
  // w/h = a / imageAspect.
  const ratio = aspect / imageAspect;
  let w = 1;
  let h = w / ratio;
  if (h > 1) {
    h = 1;
    w = h * ratio;
  }
  return clampCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

/** Where a crop lands in the source image's own pixels, undoing the rotation
 * so the export can draw straight from the bitmap. */
export function cropPixels(crop, width, height, rotation) {
  const size = rotatedSize(width, height, rotation);
  return {
    x: Math.round(crop.x * size.width),
    y: Math.round(crop.y * size.height),
    w: Math.max(1, Math.round(crop.w * size.width)),
    h: Math.max(1, Math.round(crop.h * size.height)),
  };
}

/** A pointer position inside the preview box, as normalised image units. */
export function pointIn(box, clientX, clientY) {
  return {
    x: clamp01((clientX - box.left) / Math.max(1, box.width)),
    y: clamp01((clientY - box.top) / Math.max(1, box.height)),
  };
}

/** Annotations are stored against the uncropped image, so cropping after
 * drawing does not drag the strokes around. This maps them into the crop at
 * export time, and reports what falls outside so it can be dropped. */
export function intoCrop(point, crop) {
  return {
    x: (point.x - crop.x) / crop.w,
    y: (point.y - crop.y) / crop.h,
  };
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}
