import type { Session } from "../api/client";

import type { LinkPreview } from "./store";

const PREF_KEY = "kuchupuchu:link-previews";
const THUMB_EDGE = 320;
const THUMB_QUALITY = 0.6;

/** Previews are on by default, matching what people expect from a messenger,
 * but the switch is real: with it off no URL ever leaves the device, because
 * the composer never asks the server to fetch one. */
export function linkPreviewsEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(PREF_KEY) !== "off";
}

export function setLinkPreviewsEnabled(on: boolean): void {
  localStorage.setItem(PREF_KEY, on ? "on" : "off");
}

/** Resolves a preview for `url` on the sender's behalf.
 *
 * The image is downscaled here and embedded as a data URL rather than passed
 * along as a link: a remote <img src> in a received message would report to
 * the site every time the recipient scrolled past the bubble.
 */
export async function resolvePreview(session: Session, url: string): Promise<LinkPreview | null> {
  const meta = await session.unfurl(url);
  if (!meta.title && !meta.description && !meta.imageUrl) return null;

  let image: string | undefined;
  if (meta.imageUrl) {
    try {
      image = await thumbnailFrom(await session.unfurlImage(meta.imageUrl));
    } catch {
      // A missing image is a worse-looking card, not a failed preview.
    }
  }

  return {
    url: meta.url,
    title: meta.title ?? undefined,
    description: meta.description ?? undefined,
    siteName: meta.siteName ?? undefined,
    image,
  };
}

async function thumbnailFrom(blob: Blob): Promise<string | undefined> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", THUMB_QUALITY);
  } finally {
    bitmap.close();
  }
}
