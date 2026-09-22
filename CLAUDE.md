# CLAUDE.md

**Read `houserules.md` first, before anything else in this repo.** It is not
committed, so it will be absent in a fresh clone — if it is missing, ask
before assuming any convention.

## What this is

Private voice/video app for a fixed group of ~10 people, built around an
India↔Russia link. Design doc: `docs/design-doc-v6.md` — §1a (hosting),
§3a (layout), §13 (phases and their done-bars).

Phases 1-4 are done and validated. Phase 5 is in progress: the web client
and messaging service are built and working; `clients/android/` and
`services/wake-service/` are still placeholders. Messaging (design-doc
Phase 6) was deliberately pulled forward into the web build, so §13's
Phase 5/6 split no longer matches what is here.

## Layout

- `services/auth-service/` — FastAPI + SQLite. Allowlist, OTP, JWTs, devices,
  revocation, prekeys, quality reports.
- `services/messaging-service/` — FastAPI + SQLite. Store-and-forward for
  encrypted messages, media blobs, receipts, and the delivery WebSocket. Reads
  auth-service's SQLite read-only for the device-status check.
- `clients/web/` — Next.js + TypeScript. Calls (LiveKit + the Phase 4 E2EE
  stack), messaging (its own bidirectional Double Ratchet), theming.
- `infra/` — nginx (SNI stream-demux on 443), coturn, livekit, cert generation.
- `testing/webrtc-harness/` — throwaway browser harness standing in for the
  real clients. Plain ES modules, no build step.
- `scripts/` — dev certs, network emulation, toxiproxy fault injection.

## Running tests

```bash
python -m pytest services/auth-service/tests -q
cd services/messaging-service && python -m pytest tests -q
cd testing/webrtc-harness && node --test test/*.test.mjs
cd clients/web && npm test && npm run build
```

End-to-end across both services (needs a running stack, `OTP_TRANSPORT=console`,
and the auth service's stdout captured):

```bash
AUTH_BASE=http://127.0.0.1:8080 MSG_BASE=http://127.0.0.1:8090   AUTH_LOG=/tmp/kp3/auth.log node --test testing/e2e/web-services.test.mjs
```

§4 caps a member at 2 active devices, so the suite uses stable device ids
rather than minting one per run, and revokes its throwaway device at the end.
It signs in 3 times per run. The OTP limits are **in-process sliding windows**
(`app/rate_limit.py`), not database state — so clearing `otp_codes` does
nothing for them, and a 429 clears only by restarting auth-service or waiting
out the hour. Browser testing on the same addresses eats the same quota.
auth-service must run unbuffered (`python -u`) or its console OTP lines never
reach the log.

## Bringing the stack up

Needs `.env` (copy `.env.example`). `docker compose up -d --build`; add
`-f docker-compose.testing.yml` for the toxiproxy overlay. auth-service
refuses to start on placeholder, short, or reused secrets.
