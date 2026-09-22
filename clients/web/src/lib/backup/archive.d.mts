export const ARCHIVE_MAGIC: string;
export const ARCHIVE_VERSION: number;
export class ArchiveError extends Error {}

export function packArchive(
  manifest: object,
  blobs: { id: string; mime: string; bytes: Uint8Array }[]
): Promise<Uint8Array>;

export function unpackArchive(bytes: Uint8Array): Promise<{
  manifest: Record<string, unknown>;
  blobs: Map<string, { mime: string; bytes: Uint8Array }>;
}>;

export const MANIFEST_RAW: number;
export const MANIFEST_GZIP: number;
