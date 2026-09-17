import { base64Decode, base64Encode } from "../crypto/signal-crypto";

/** §10.4: the blob is encrypted client-side under a fresh per-file key, and
 * only that key travels in the Signal-encrypted envelope. The media store
 * ever holds ciphertext. */
export async function encryptBlob(blob: Blob): Promise<{ data: Blob; key: string; iv: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await blob.arrayBuffer());
  return {
    data: new Blob([ciphertext]),
    key: base64Encode(raw),
    iv: base64Encode(iv),
  };
}

export async function decryptBlob(
  ciphertext: ArrayBuffer,
  keyB64: string,
  ivB64: string,
  mime: string
): Promise<Blob> {
  const key = await crypto.subtle.importKey("raw", base64Decode(keyB64), { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64Decode(ivB64) },
    key,
    ciphertext
  );
  return new Blob([plaintext], { type: mime });
}

/** §10.5/§5: client-side compression before upload. A 12MP phone photo is
 * several MB of ciphertext to push over a constrained link for no visible
 * benefit at chat-bubble size. */
export async function compressImage(
  file: File,
  maxEdge = 1600,
  quality = 0.82
): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return { blob: file, width: bitmap.width, height: bitmap.height };
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality)
  );
  return { blob: blob ?? file, width, height };
}

/** A tiny inline preview carried in the envelope itself, so a bubble can show
 * something immediately without a second round trip for the full blob. */
export async function makeThumbnail(file: Blob, maxEdge = 160): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return undefined;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.5);
  } catch {
    return undefined;
  }
}

export async function videoPoster(file: File): Promise<{ thumb?: string; durationMs?: number }> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("video metadata failed to load"));
    });
    // Seeking off frame zero avoids the black frame many encoders start with.
    video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
    });

    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 160 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);

    return {
      thumb: canvas.toDataURL("image/jpeg", 0.5),
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
    };
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Opus in a WebM container is what MediaRecorder gives us in Chrome and
 * Firefox; Safari produces mp4/aac. Both are sent as-is and played back by the
 * same <audio> element, so no transcoding is needed. */
export function pickVoiceMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}
