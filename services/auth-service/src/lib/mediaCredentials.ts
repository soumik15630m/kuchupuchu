import { AccessToken } from "livekit-server-sdk";
import { createHmac } from "node:crypto";

/**
 * Short-lived, room-scoped JWT room tokens (§9) — not static shared
 * credentials. §4's concurrency gate (max 5) is enforced server-side by
 * LiveKit itself (room.max_participants in livekit.yaml), not here; this
 * just grants join permission for an allowlisted, OTP-verified identity.
 */
export async function mintRoomToken(email: string, roomName: string): Promise<string> {
  const apiKey = process.env.LIVEKIT_API_KEY!;
  const apiSecret = process.env.LIVEKIT_API_SECRET!;

  const at = new AccessToken(apiKey, apiSecret, {
    identity: email,
    ttl: "10m", // just long enough to connect; the room session itself outlives this
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });
  return at.toJwt();
}

/**
 * Time-limited TURN REST-API credentials for coturn (§7.1), matching the
 * `use-auth-secret` scheme configured in turnserver.conf.template.
 * username = "<expiry-unix-ts>:<email>", password = HMAC-SHA1(username, secret), base64.
 */
export function mintTurnCredentials(email: string) {
  const secret = process.env.TURN_SHARED_SECRET!;
  const ttlSeconds = 600; // 10 min — same order as the room token above
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${email}`;
  const password = createHmac("sha1", secret).update(username).digest("base64");

  return {
    username,
    password,
    ttl: ttlSeconds,
    uris: [
      // Hard constraint (§7.1): hostname, never a bare IP — required for the
      // nginx SNI demux to route this correctly.
      `turns:${process.env.PUBLIC_HOSTNAME}:443?transport=tcp`,
      `turn:${process.env.PUBLIC_HOSTNAME}:3478?transport=udp`,
    ],
  };
}
