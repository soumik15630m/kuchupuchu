export interface DeviceIdentity {
  signingKeyPair: CryptoKeyPair;
  dhIdentityKeyPair: CryptoKeyPair;
  signedPrekeyId: number;
  signedPrekeyPair: CryptoKeyPair;
  oneTimePrekeys: Map<number, CryptoKeyPair>;
  nextOneTimePrekeyId: number;
}

export interface SignedKey {
  public_key: string;
  signature: string;
}

export interface PublishPayload {
  identity_key: string;
  identity_dh_key: SignedKey;
  signed_prekey: { key_id: number; public_key: string; signature: string };
  one_time_prekeys: { key_id: number; public_key: string }[];
}

export interface PrekeyBundle {
  identity_key: string;
  identity_dh_key: SignedKey;
  signed_prekey: { key_id: number; public_key: string; signature: string };
  one_time_prekey: { key_id: number; public_key: string } | null;
}

export interface X3dhInitialMessage {
  identity_key: string;
  identity_dh_key: string;
  ephemeral_key: string;
  used_signed_prekey_id: number;
  used_one_time_prekey_id: number | null;
}

export function assertSecureCurvesSupported(): Promise<void>;
export function base64Encode(buf: ArrayBuffer | Uint8Array): string;
export function base64Decode(str: string): ArrayBuffer;
export function concatBytes(...arrays: (ArrayBuffer | Uint8Array)[]): ArrayBuffer;
export function computeIdentitySafetyNumber(
  myIdentityKeyRaw: ArrayBuffer | Uint8Array,
  theirIdentityKeyRaw: ArrayBuffer | Uint8Array
): Promise<string>;
export function generateIdentity(opts?: { oneTimePrekeyCount?: number }): Promise<DeviceIdentity>;
export function buildPublishPayload(
  identity: DeviceIdentity,
  opts?: { oneTimePrekeyIds?: number[] | null }
): Promise<PublishPayload>;
export function generateMoreOneTimePrekeys(
  identity: DeviceIdentity,
  count: number
): Promise<PublishPayload>;
export function verifyIdentityDhKey(identityKeyB64: string, identityDhKey: SignedKey): Promise<void>;
export function verifyBundle(bundle: PrekeyBundle): Promise<void>;
export function initiateSession(
  myIdentity: DeviceIdentity,
  theirBundle: PrekeyBundle
): Promise<{
  sharedSecret: ArrayBuffer;
  associatedData: ArrayBuffer;
  bootstrapDh: ArrayBuffer;
  initialMessage: X3dhInitialMessage;
}>;
export function respondToSession(
  myIdentity: DeviceIdentity,
  initialMessage: X3dhInitialMessage
): Promise<{ sharedSecret: ArrayBuffer; associatedData: ArrayBuffer; bootstrapDh: ArrayBuffer }>;
