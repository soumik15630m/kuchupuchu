export const ARCHIVE_MAGIC: string;
export const ARCHIVE_VERSION: number;
export class ArchiveError extends Error {}

export function packArchive(
  manifest: object,
  blobs: { id: string; mime: string; bytes: Uint8Array }[]
): Uint8Array;

export function unpackArchive(bytes: Uint8Array): {
  manifest: Record<string, unknown>;
  blobs: Map<string, { mime: string; bytes: Uint8Array }>;
};
