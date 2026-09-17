export const MAX_SKIP: number;
export const MAX_SKIPPED_KEYS: number;

export interface RatchetHeader {
  dh: string;
  pn: number;
  n: number;
}

export interface RatchetEnvelope {
  header: RatchetHeader;
  iv: string;
  ciphertext: string;
}

export class MessageRatchet {
  constructor(state: unknown);
  state: unknown;
  static initSender(
    sharedSecret: ArrayBuffer,
    theirRatchetPublicKeyRaw: ArrayBuffer,
    associatedData: ArrayBuffer
  ): Promise<MessageRatchet>;
  static initReceiver(
    sharedSecret: ArrayBuffer,
    ownRatchetKeyPair: CryptoKeyPair,
    associatedData: ArrayBuffer
  ): Promise<MessageRatchet>;
  encrypt(plaintextBytes: Uint8Array): Promise<RatchetEnvelope>;
  decrypt(message: RatchetEnvelope): Promise<ArrayBuffer>;
}
