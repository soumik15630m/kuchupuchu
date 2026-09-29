export function b64urlToBytes(value: string): Uint8Array;
export function bytesToB64url(buffer: ArrayBuffer | Uint8Array): string;
export function sameApplicationServerKey(
  existingBuffer: ArrayBuffer | null | undefined,
  expectedB64url: string
): boolean;
export function subscriptionKeys(
  subscription: Pick<PushSubscription, "getKey">
): { p256dh: string; auth: string } | null;
