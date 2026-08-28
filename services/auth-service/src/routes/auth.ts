import { Router } from "express";
import { z } from "zod";
import {
  requestOtp,
  verifyOtp,
  NotAllowlistedError,
  RateLimitedError,
  InvalidOtpError,
  OtpExpiredError,
  TooManyAttemptsError,
} from "../lib/otp.js";
import { sendOtpEmail } from "../lib/mailer.js";
import { signAccessToken, signRefreshToken, verifyToken } from "../lib/sessionTokens.js";

export const authRouter = Router();

const requestSchema = z.object({ email: z.string().email() });
const verifySchema = z.object({ email: z.string().email(), code: z.string().length(6) });
const refreshSchema = z.object({ refreshToken: z.string() });

authRouter.post("/otp/request", async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid email" });

  try {
    const code = requestOtp(parsed.data.email);
    await sendOtpEmail(parsed.data.email, code);
    return res.status(202).json({ status: "sent" });
  } catch (err) {
    if (err instanceof NotAllowlistedError) {
      // Deliberately vague response — don't confirm/deny which emails are
      // on the allowlist to an unauthenticated caller.
      return res.status(202).json({ status: "sent" });
    }
    if (err instanceof RateLimitedError) {
      return res.status(429).json({ error: "too many requests, try again later" });
    }
    console.error(err);
    return res.status(500).json({ error: "internal error" });
  }
});

authRouter.post("/otp/verify", (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid request" });

  try {
    verifyOtp(parsed.data.email, parsed.data.code);
    const accessToken = signAccessToken(parsed.data.email);
    const refreshToken = signRefreshToken(parsed.data.email);
    return res.status(200).json({ accessToken, refreshToken });
  } catch (err) {
    if (
      err instanceof InvalidOtpError ||
      err instanceof OtpExpiredError ||
      err instanceof TooManyAttemptsError
    ) {
      return res.status(401).json({ error: err.message });
    }
    console.error(err);
    return res.status(500).json({ error: "internal error" });
  }
});

authRouter.post("/token/refresh", (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid request" });

  try {
    const payload = verifyToken(parsed.data.refreshToken);
    if (payload.type !== "refresh") {
      return res.status(401).json({ error: "not a refresh token" });
    }
    // §4: refresh token rotated on every use.
    const accessToken = signAccessToken(payload.sub);
    const refreshToken = signRefreshToken(payload.sub);
    return res.status(200).json({ accessToken, refreshToken });
  } catch {
    return res.status(401).json({ error: "invalid or expired refresh token" });
  }
});
