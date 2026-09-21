export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export const FULL_CROP: Readonly<Rect>;

export function rotatedSize(
  width: number,
  height: number,
  rotation: number
): { width: number; height: number };
export function normaliseRotation(rotation: number): number;
export function clampCrop(rect: Rect, minSize?: number): Rect;
export function cropForAspect(aspect: number, imageAspect: number): Rect;
export function cropPixels(crop: Rect, width: number, height: number, rotation: number): Rect;
export function pointIn(
  box: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number
): Point;
export function intoCrop(point: Point, crop: Rect): Point;
