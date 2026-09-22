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
 *   u32       manifest length
 *   manifest  JSON, utf-8
 *   blobs     concatenated, located by the offsets in the manifest
 *
 * Offsets are relative to the start of the blob section, so the manifest can
 * be grown without rewriting them.
 */

export const ARCHIVE_MAGIC = "KPARC1";
export const ARCHIVE_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ArchiveError extends Error {}

/**
 * @param {object} manifest  anything JSON-serialisable; `blobs` is overwritten
 * @param {{id: string, mime: string, bytes: Uint8Array}[]} blobs
 * @returns {Uint8Array}
 */
export function packArchive(manifest, blobs) {
  const entries = [];
  let offset = 0;
  for (const blob of blobs) {
    entries.push({ id: blob.id, mime: blob.mime ?? "application/octet-stream", offset, length: blob.bytes.length });
    offset += blob.bytes.length;
  }

  const manifestBytes = encoder.encode(
    JSON.stringify({ ...manifest, version: ARCHIVE_VERSION, blobs: entries })
  );

  const total = ARCHIVE_MAGIC.length + 4 + manifestBytes.length + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out.set(encoder.encode(ARCHIVE_MAGIC), 0);
  view.setUint32(ARCHIVE_MAGIC.length, manifestBytes.length, true);
  out.set(manifestBytes, ARCHIVE_MAGIC.length + 4);

  let cursor = ARCHIVE_MAGIC.length + 4 + manifestBytes.length;
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
export function unpackArchive(bytes) {
  const headerSize = ARCHIVE_MAGIC.length + 4;
  if (bytes.length < headerSize) throw new ArchiveError("that backup file is truncated");
  if (decoder.decode(bytes.subarray(0, ARCHIVE_MAGIC.length)) !== ARCHIVE_MAGIC) {
    throw new ArchiveError("that does not look like a Kuchupuchu backup");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const manifestLength = view.getUint32(ARCHIVE_MAGIC.length, true);
  const manifestEnd = headerSize + manifestLength;
  if (manifestEnd > bytes.length) throw new ArchiveError("that backup file is truncated");

  let manifest;
  try {
    manifest = JSON.parse(decoder.decode(bytes.subarray(headerSize, manifestEnd)));
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
