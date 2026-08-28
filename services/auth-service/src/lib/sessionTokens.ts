import jwt from "jsonwebtoken";

const ACCESS_TTL_MIN = Number(process.env.JWT_ACCESS_TOKEN_TTL_MIN ?? 15);
const REFRESH_TTL_DAYS = Number(process.env.JWT_REFRESH_TOKEN_TTL_DAYS ?? 30);

function secret(): string {
  const s = process.env.LIVEKIT_API_SECRET; // reused as the app's JWT signing
  // secret for now; split into its own JWT_SECRET before this leaves Phase 1
  // if the two ever need to rotate independently.
  if (!s) throw new Error("Missing signing secret (LIVEKIT_API_SECRET)");
  return s;
}

export interface SessionPayload {
  sub: string; // email
  type: "access" | "refresh";
}

export function signAccessToken(email: string): string {
  return jwt.sign({ sub: email, type: "access" } satisfies SessionPayload, secret(), {
    expiresIn: `${ACCESS_TTL_MIN}m`,
  });
}

export function signRefreshToken(email: string): string {
  return jwt.sign({ sub: email, type: "refresh" } satisfies SessionPayload, secret(), {
    expiresIn: `${REFRESH_TTL_DAYS}d`,
  });
}

export function verifyToken(token: string): SessionPayload {
  return jwt.verify(token, secret()) as SessionPayload;
}
