# CLAUDE.md

**Read `houserules.md` first, before anything else in this repo.** It is not
committed, so it will be absent in a fresh clone — if it is missing, ask
before assuming any convention.

## What this is

Private voice/video app for a fixed group of ~10 people, built around an
India↔Russia link. Design doc: `docs/design-doc-v6.md` — §1a (hosting),
§3a (layout), §13 (phases and their done-bars).

Phases 1-4 are done and validated. Phases 5-8 are not started;
`clients/`, `services/wake-service/` and `services/messaging-service/`
are placeholders until then.

## Layout

- `services/auth-service/` — FastAPI + SQLite. Allowlist, OTP, JWTs, devices,
  revocation, prekeys, quality reports.
- `infra/` — nginx (SNI stream-demux on 443), coturn, livekit, cert generation.
- `testing/webrtc-harness/` — throwaway browser harness standing in for the
  real clients. Plain ES modules, no build step.
- `scripts/` — dev certs, network emulation, toxiproxy fault injection.

## Running tests

```bash
python -m pytest services/auth-service/tests -q
cd testing/webrtc-harness && node --test test/*.test.mjs
```

## Bringing the stack up

Needs `.env` (copy `.env.example`). `docker compose up -d --build`; add
`-f docker-compose.testing.yml` for the toxiproxy overlay. auth-service
refuses to start on placeholder, short, or reused secrets.
