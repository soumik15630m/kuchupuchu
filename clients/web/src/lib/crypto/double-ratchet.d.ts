export class TransportChain {
  keyForGeneration(generation: number): Promise<CryptoKey>;
}

export function initTransportChain(
  sharedSecret: ArrayBuffer,
  bootstrapDh: ArrayBuffer
): Promise<TransportChain>;
export function fingerprint(roomKey: ArrayBuffer | Uint8Array): Promise<string>;
export function fingerprintProof(
  roomKey: ArrayBuffer | Uint8Array,
  generation: number,
  identity: string
): Promise<string>;
export function seal(
  key: CryptoKey,
  plaintext: ArrayBuffer | Uint8Array,
  associatedData: ArrayBuffer | Uint8Array
): Promise<{ iv: Uint8Array; ciphertext: ArrayBuffer }>;
export function open(
  key: CryptoKey,
  iv: ArrayBuffer | Uint8Array,
  ciphertext: ArrayBuffer | Uint8Array,
  associatedData: ArrayBuffer | Uint8Array
): Promise<ArrayBuffer>;
