import { randomInt, createHash } from "node:crypto";
import { getDb } from "./db.js";

const OTP_TTL_MIN = 10;
const MAX_REQUESTS_PER_HOUR = 5; // §4
const MAX_VERIFY_ATTEMPTS = 5;   // §4

export class RateLimitedError extends Error {}
export class NotAllowlistedError extends Error {}
export class InvalidOtpError extends Error {}
export class OtpExpiredError extends Error {}
export class TooManyAttemptsError extends Error {}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function isAllowlisted(email: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 FROM allowlist WHERE email = ?")
    .get(email.toLowerCase());
  return !!row;
}

/** Generates and stores a new OTP for `email`. Returns the raw code so the
 * caller can hand it to the delivery transport (console/SMTP, §9). Never
 * stored or logged in plaintext beyond that. */
export function requestOtp(email: string): string {
  const normalized = email.toLowerCase();
  if (!isAllowlisted(normalized)) {
    throw new NotAllowlistedError(`${normalized} is not on the allowlist`);
  }

  const db = getDb();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentCount = db
    .prepare(
      "SELECT COUNT(*) as n FROM otp_codes WHERE email = ? AND created_at > ?"
    )
    .get(normalized, oneHourAgo) as { n: number };

  if (recentCount.n >= MAX_REQUESTS_PER_HOUR) {
    throw new RateLimitedError(
      `${normalized} has requested ${recentCount.n} OTPs in the last hour`
    );
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000).toISOString();

  db.prepare(
    "INSERT INTO otp_codes (email, code_hash, expires_at) VALUES (?, ?, ?)"
  ).run(normalized, hashCode(code), expiresAt);

  return code;
}

/** Verifies a submitted OTP. Throws on any failure; returns nothing on success. */
export function verifyOtp(email: string, submittedCode: string): void {
  const normalized = email.toLowerCase();
  const db = getDb();

  const row = db
    .prepare(
      `SELECT id, code_hash, expires_at, attempts, consumed
       FROM otp_codes
       WHERE email = ? AND consumed = 0
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(normalized) as
    | { id: number; code_hash: string; expires_at: string; attempts: number; consumed: number }
    | undefined;

  if (!row) {
    throw new InvalidOtpError("no active OTP for this email");
  }

  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    db.prepare("UPDATE otp_codes SET consumed = 1 WHERE id = ?").run(row.id);
    throw new TooManyAttemptsError("too many verification attempts; request a new code");
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new OtpExpiredError("OTP expired; request a new code");
  }

  if (hashCode(submittedCode) !== row.code_hash) {
    db.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    throw new InvalidOtpError("incorrect code");
  }

  db.prepare("UPDATE otp_codes SET consumed = 1 WHERE id = ?").run(row.id);
}
