/** base64url <-> bytes, for push subscription keys.
 *
 * `applicationServerKey` wants raw bytes, and `PushSubscription.getKey()`
 * hands back an ArrayBuffer, while the wire format on both sides is
 * base64url. Kept separate and pure because getting the URL alphabet wrong
 * fails in exactly one way -- the browser rejects the subscription with
 * "applicationServerKey is not valid" -- and that is worth a test rather
 * than a debugging session.
 */

export function b64urlToBytes(value) {
  // atob only accepts the standard alphabet, and rejects the unpadded form
  // the push ecosystem uses everywhere.
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToB64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Whether an existing subscription was made with this VAPID key.
 *
 * A subscription made with a different one is dead -- the push service
 * rejects anything signed by the current key -- and the only symptom is that
 * notifications stop. Length is compared first: `every` on a shorter array
 * returns true against a longer one, which would call a truncated key a match.
 */
export function sameApplicationServerKey(existingBuffer, expectedB64url) {
  if (!existingBuffer) return false;
  const existing = new Uint8Array(existingBuffer);
  const expected = b64urlToBytes(expectedB64url);
  if (existing.length !== expected.length) return false;
  return existing.every((byte, i) => byte === expected[i]);
}

/** The two keys a subscription carries, in the shape wake-service stores. */
export function subscriptionKeys(subscription) {
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (!p256dh || !auth) return null;
  return { p256dh: bytesToB64url(p256dh), auth: bytesToB64url(auth) };
}
