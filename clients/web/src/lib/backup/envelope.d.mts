export const ENVELOPE_MAGIC: string;
export const KDF_PBKDF2_SHA256: number;
export const PBKDF2_ITERATIONS: number;
export class BackupError extends Error {}

export function sealBackup(
  plaintext: Uint8Array,
  passphrase: string,
  iterations?: number
): Promise<Uint8Array>;

export function readEnvelopeHeader(bytes: Uint8Array): {
  kdf: number;
  iterations: number;
  salt: Uint8Array;
  iv: Uint8Array;
  bodyOffset: number;
};

export function openBackup(bytes: Uint8Array, passphrase: string): Promise<Uint8Array>;
