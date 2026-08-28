import "dotenv/config";
import express from "express";
import { authRouter } from "./routes/auth.js";
import { roomRouter } from "./routes/room.js";

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));
app.use(authRouter);
app.use("/room", roomRouter);
// mounted at "/otp" and "/room" here; nginx strips the "/auth/" prefix it
// receives from clients (see infra/nginx/conf.d/app.conf.template), so the
// public paths end up as /auth/otp/request, /auth/room/token, etc.

const port = Number(process.env.AUTH_PORT ?? 8080);
app.listen(port, () => {
  console.log(`[auth-service] listening on :${port}`);
});
