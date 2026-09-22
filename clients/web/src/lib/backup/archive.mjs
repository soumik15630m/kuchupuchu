/** The container a backup is packed into before it is encrypted.
 *
 * Media has to travel inside the backup rather than as a reference: the
 * server drops blobs after seven days (§10.4), so a backup that only carried
 * MediaRefs would restore a history of broken photos. That means packing
 * binary next to JSON, and base64 inside the JSON would inflate every photo
 * by a third and force the whole archive through a string.
 *
 * Layout, all integers little-endian:
 *
 *   magic     6 bytes   "KPARC1"
 *   u8        manifest encoding (0 = raw utf-8, 1 = gzip)
 *   u32       manifest length, as stored
 *   manifest  JSON, utf-8, optionally gzipped
 *   blobs     concatenated, located by the offsets in the manifest
 *
 * Offsets are relative to the start of the blob section, so the manifest can
 * be grown without rewriting them.
 *
 * Only the manifest is compressed. It is JSON full of repeated keys, sender
 * addresses and base64 thumbnails, and gzip takes a large bite out of it. The
 * blobs are JPEG, WebM and Opus -- already entropy-coded, so gzipping them
 * burns CPU on every backup to save a fraction of a percent. Compressing the
 * whole archive would have looked tidier and been slower for less.
 */

export const ARCHIVE_MAGIC = "KPARC1";
export const ARCHIVE_VERSION = 1;

export const MANIFEST_RAW = 0;
export const MANIFEST_GZIP = 1;

const HEADER_SIZE = ARCHIVE_MAGIC.length + 1 + 4;

/** Below this, the gzip header and trailer cost more than the compression
 * saves, and the round trip is not worth the two stream allocations. */
const COMPRESS_ABOVE_BYTES = 512;

async function through(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function canCompress() {
  return typeof CompressionStream !== "undefined";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ArchiveError extends Error {}

/**
 * @param {object} manifest  anything JSON-serialisable; `blobs` is overwritten
 * @param {{id: string, mime: string, bytes: Uint8Array}[]} blobs
 * @returns {Uint8Array}
 */
export async function packArchive(manifest, blobs) {
  const entries = [];
  let offset = 0;
  for (const blob of blobs) {
    entries.push({ id: blob.id, mime: blob.mime ?? "application/octet-stream", offset, length: blob.bytes.length });
    offset += blob.bytes.length;
  }

  const raw = encoder.encode(
    JSON.stringify({ ...manifest, version: ARCHIVE_VERSION, blobs: entries })
  );

  let manifestBytes = raw;
  let encoding = MANIFEST_RAW;
  if (canCompress() && raw.length > COMPRESS_ABOVE_BYTES) {
    const packed = await through(raw, new CompressionStream("gzip"));
    // Pathological input can come out larger; keep whichever actually won.
    if (packed.length < raw.length) {
      manifestBytes = packed;
      encoding = MANIFEST_GZIP;
    }
  }

  const total = HEADER_SIZE + manifestBytes.length + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out.set(encoder.encode(ARCHIVE_MAGIC), 0);
  out[ARCHIVE_MAGIC.length] = encoding;
  view.setUint32(ARCHIVE_MAGIC.length + 1, manifestBytes.length, true);
  out.set(manifestBytes, HEADER_SIZE);

  let cursor = HEADER_SIZE + manifestBytes.length;
  for (const blob of blobs) {
    out.set(blob.bytes, cursor);
    cursor += blob.bytes.length;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{manifest: object, blobs: Map<string, {mime: string, bytes: Uint8Array}>}}
 */
export async function unpackArchive(bytes) {
  if (bytes.length < HEADER_SIZE) throw new ArchiveError("that backup file is truncated");
  if (decoder.decode(bytes.subarray(0, ARCHIVE_MAGIC.length)) !== ARCHIVE_MAGIC) {
    throw new ArchiveError("that does not look like a Kuchupuchu backup");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const encoding = bytes[ARCHIVE_MAGIC.length];
  if (encoding !== MANIFEST_RAW && encoding !== MANIFEST_GZIP) {
    throw new ArchiveError("that backup's index uses an encoding this version does not know");
  }
  const manifestLength = view.getUint32(ARCHIVE_MAGIC.length + 1, true);
  const manifestEnd = HEADER_SIZE + manifestLength;
  if (manifestEnd > bytes.length) throw new ArchiveError("that backup file is truncated");

  let manifestBytes = bytes.subarray(HEADER_SIZE, manifestEnd);
  if (encoding === MANIFEST_GZIP) {
    if (typeof DecompressionStream === "undefined") {
      throw new ArchiveError("this browser cannot read a compressed backup");
    }
    try {
      manifestBytes = await through(manifestBytes, new DecompressionStream("gzip"));
    } catch {
      throw new ArchiveError("that backup's index could not be decompressed");
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes));
  } catch {
    throw new ArchiveError("that backup's index could not be read");
  }
  if (manifest.version > ARCHIVE_VERSION) {
    throw new ArchiveError("that backup was made by a newer version of Kuchupuchu");
  }

  const blobs = new Map();
  const section = bytes.subarray(manifestEnd);
  for (const entry of manifest.blobs ?? []) {
    const start = entry.offset;
    const end = entry.offset + entry.length;
    // A manifest that points past the data is either corruption or a forged
    // archive; either way it must not be read as an out-of-bounds slice.
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > section.length) {
      throw new ArchiveError("that backup's index does not match its contents");
    }
    blobs.set(entry.id, { mime: entry.mime, bytes: section.subarray(start, end) });
  }

  delete manifest.blobs;
  return { manifest, blobs };
}
