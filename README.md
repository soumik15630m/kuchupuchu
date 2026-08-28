# Private Voice/Video App

Design doc: [`docs/design-doc-v6.md`](./docs/design-doc-v6.md) — read §1a (hosting), §3a (this
repo's layout), and §13 (implementation phases) first.

**Current status: Phase 1 (§13)** — SFU + minimal auth walking skeleton. `wake-service`,
`messaging-service`, and both `clients/` are placeholders until Phase 5/6.

## Prerequisites

- Docker + Docker Compose
- OpenSSL (for the local dev cert script)
- [`livekit-cli`](https://github.com/livekit/livekit-cli) (`lk`) or LiveKit's sample web
  client, to actually join a room and validate Phase 1 without a built client app yet

## Setup

```bash
cp .env.example .env
# edit .env: set PUBLIC_HOSTNAME, and generate real secrets for
# LIVEKIT_API_SECRET / TURN_SHARED_SECRET, e.g.:
openssl rand -hex 32
```

### §1a's open decision: reachability

Before this is reachable from outside your own network (i.e. before a real
Russia↔India call is possible, not just same-machine testing), pick one:

- **Port-forward** 443, 3478/udp+tcp, and the relay port ranges in
  `docker-compose.yml` on your router to this machine, and point
  `PUBLIC_HOSTNAME`'s DNS at your public IP (dynamic DNS if it's not static), or
- **Tunnel** (e.g. a Cloudflare Tunnel or Tailscale Funnel) terminating at this
  machine, with `PUBLIC_HOSTNAME` pointed at the tunnel's hostname instead.

This doc doesn't pick one for you — see design-doc-v6.md §1a. Same-machine
testing below works either way, without this decision made yet.

### TLS certs

Production: run acme.sh/certbot against `PUBLIC_HOSTNAME` and mount the result
into the `certs` volume at `/etc/letsencrypt` (Let's Encrypt's own directory
layout — `live/<hostname>/fullchain.pem` + `privkey.pem`).

Local dev, before §1a is resolved: generate a throwaway self-signed cert into
the same layout:

```bash
./scripts/dev-selfsigned-cert.sh
```

(You'll need to tell your test client to trust it, or accept the certificate
warning — expected for local-only testing, not something to do once this is
reachable for real.)

## Running it

```bash
docker compose up --build
```

This builds and starts nginx, coturn, LiveKit, Redis, and auth-service.
auth-service runs its SQLite migrations automatically on boot and seeds the
allowlist from `ADMIN_SEED_EMAILS` in `.env`.

Check everything's up:

```bash
curl -k https://localhost/healthz
```

## Phase 1 walkthrough: validate the whole path

This exercises §13 Phase 1's "done when" bar — OTP login → JWT → LiveKit room
token → an actual call. Steps 1-3 work on one machine; step 4 needs two, ideally
on the real India/Russia link once §1a is resolved.

**1. Request an OTP** (with `OTP_TRANSPORT=console` in `.env`, the code prints
to `docker compose logs -f auth-service` instead of sending real email):

```bash
curl -k -X POST https://localhost/auth/otp/request \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'
```

**2. Verify it** (grab the code from the logs):

```bash
curl -k -X POST https://localhost/auth/otp/verify \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","code":"123456"}'
```

Save the `accessToken` from the response.

**3. Mint a room token:**

```bash
curl -k -X POST https://localhost/auth/room/token \
  -H "Authorization: Bearer <accessToken>" \
  -H 'Content-Type: application/json' \
  -d '{"roomName":"test-room"}'
```

Save the `roomToken` and `livekitUrl` from the response.

**4. Join the room** with `livekit-cli`:

```bash
lk room join --url <livekitUrl> --api-key devkey --api-secret <LIVEKIT_API_SECRET> \
  --identity you@example.com test-room
```

Repeat steps 1-4 with a second allowlisted email from a second device to get
two participants in the same room — that's Phase 1's actual finish line.

## Repo layout

See design-doc-v6.md §3a.
