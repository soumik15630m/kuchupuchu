import { Router } from "express";
import { z } from "zod";
import { verifyToken } from "../lib/sessionTokens.js";
import { mintRoomToken, mintTurnCredentials } from "../lib/mediaCredentials.js";

export const roomRouter = Router();

const bodySchema = z.object({ roomName: z.string().min(1).max(128) });

function requireAccessToken(req: import("express").Request): string {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new Error("missing bearer token");
  const payload = verifyToken(token);
  if (payload.type !== "access") throw new Error("not an access token");
  return payload.sub; // email
}

roomRouter.post("/token", async (req, res) => {
  let email: string;
  try {
    email = requireAccessToken(req);
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid roomName" });

  const roomToken = await mintRoomToken(email, parsed.data.roomName);
  const turnCredentials = mintTurnCredentials(email);

  return res.status(200).json({
    roomToken,
    livekitUrl: process.env.LIVEKIT_URL,
    turnCredentials,
  });
});
