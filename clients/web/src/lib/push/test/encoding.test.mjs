import assert from "node:assert/strict";
import { test } from "node:test";

// Node has atob/btoa globally since 16; the module targets the browser and
// uses them directly rather than Buffer, so the test exercises the same path.
import {
  b64urlToBytes,
  bytesToB64url,
  sameApplicationServerKey,
  subscriptionKeys,
} from "../encoding.mjs";

// The VAPID public key from RFC 8292's example: 65 bytes, uncompressed point,
// and containing both `-` and `_` so a standard-alphabet decode would fail.
const VAPID_KEY =
  "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";

test("a base64url key round-trips through bytes", () => {
  assert.equal(bytesToB64url(b64urlToBytes(VAPID_KEY)), VAPID_KEY);
});

test("a VAPID key decodes to a 65-byte uncompressed point", () => {
  const bytes = b64urlToBytes(VAPID_KEY);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 0x04);
});

test("the url alphabet is decoded, not the standard one", () => {
  // `-` and `_` are `+` and `/` in the standard alphabet. Decoding without
  // translating them throws or silently produces different bytes, and the
  // browser then refuses the subscription.
  assert.deepEqual(Array.from(b64urlToBytes("-_8")), [251, 255]);
});

test("output carries no padding and no standard-alphabet characters", () => {
  const encoded = bytesToB64url(new Uint8Array([251, 255, 254]));
  assert.ok(!encoded.includes("="));
  assert.ok(!encoded.includes("+"));
  assert.ok(!encoded.includes("/"));
});

test("every byte value survives the round trip", () => {
  const all = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(Array.from(b64urlToBytes(bytesToB64url(all))), Array.from(all));
});

test("an empty input is not an error", () => {
  assert.equal(bytesToB64url(new Uint8Array()), "");
  assert.equal(b64urlToBytes("").length, 0);
});

test("a subscription made with the same key is recognised", () => {
  assert.equal(sameApplicationServerKey(b64urlToBytes(VAPID_KEY).buffer, VAPID_KEY), true);
});

test("a subscription made with a different key is not", () => {
  const other = new Uint8Array(b64urlToBytes(VAPID_KEY));
  other[40] ^= 0xff;
  assert.equal(sameApplicationServerKey(other.buffer, VAPID_KEY), false);
});

test("a truncated key is not a match", () => {
  // `every` on a shorter array returns true against a longer one, so without
  // an explicit length check this is the case that passes wrongly.
  const short = b64urlToBytes(VAPID_KEY).slice(0, 32);
  assert.equal(sameApplicationServerKey(short.buffer, VAPID_KEY), false);
});

test("a missing key is not a match", () => {
  assert.equal(sameApplicationServerKey(null, VAPID_KEY), false);
  assert.equal(sameApplicationServerKey(undefined, VAPID_KEY), false);
});

test("subscription keys come back base64url", () => {
  const p256dh = b64urlToBytes(VAPID_KEY);
  const auth = new Uint8Array(16).map((_, i) => i);
  const fake = {
    getKey: (name) => (name === "p256dh" ? p256dh.buffer : auth.buffer),
  };
  assert.deepEqual(subscriptionKeys(fake), {
    p256dh: VAPID_KEY,
    auth: bytesToB64url(auth),
  });
});

test("a subscription missing a key yields nothing rather than a half record", () => {
  const fake = { getKey: (name) => (name === "p256dh" ? b64urlToBytes(VAPID_KEY).buffer : null) };
  assert.equal(subscriptionKeys(fake), null);
});
