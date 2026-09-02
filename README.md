# Private Voice/Video App

Design doc: [`docs/design-doc-v6.md`](./docs/design-doc-v6.md) — read §1a (hosting), §3a (this
repo's layout), and §13 (implementation phases) first.

**Current status: Phase 3 (§13) done, validated 2026-09-02** — call quality &
Russia-path reliability, on top of Phase 1's SFU + minimal auth walking skeleton
and Phase 2's access control/revocation. Next up is Phase 4 (end-to-end
encryption). `wake-service`, `messaging-service`, and both real `clients/` are
placeholders until Phase 5/6 — `testing/webrtc-harness/` is a throwaway browser
harness standing in for them so Phase 3's features had somewhere to run.

## Prerequisites

- Docker + Docker Compose
- OpenSSL (for the local dev cert script)
- [`livekit-cli`](https://github.com/livekit/livekit-cli) (`lk`) or LiveKit's sample web
  client, to actually join a room and validate Phase 1 without a built client app yet

## Setup

```bash
cp .env.example .env
# edit .env: set PUBLIC_HOSTNAME and TURN_HOSTNAME (two DIFFERENT hostnames —
# see the comment above TURN_HOSTNAME in .env.example for why), and generate
# real secrets for LIVEKIT_API_SECRET / TURN_SHARED_SECRET / JWT_SECRET
# (three independent values, not the same one reused), e.g.:
openssl rand -hex 32
```

### Local DNS, before §1a is resolved

Neither hostname needs to actually be publicly resolvable for same-machine
testing, but something needs to resolve both `PUBLIC_HOSTNAME` and
`TURN_HOSTNAME` to `127.0.0.1`, since real clients (`lk`, a browser, etc.) —
unlike `curl -k https://localhost/...` — dial the hostname from
`livekitUrl`/the ICE server list directly, not `localhost`. Add both to your
hosts file:

- macOS/Linux: `/etc/hosts`
- Windows: `C:\Windows\System32\drivers\etc\hosts` (needs an elevated editor)

```
127.0.0.1  app.yourdomain.example
127.0.0.1  turn-relay.yourdomain.example
```

(substitute whatever you actually set `PUBLIC_HOSTNAME`/`TURN_HOSTNAME` to).

### §1a's open decision: reachability

Before this is reachable from outside your own network (i.e. before a real
Russia↔India call is possible, not just same-machine testing), pick one:

- **Port-forward** 443, 3478/udp+tcp, and the relay port ranges in
  `docker-compose.yml` on your router to this machine, and point both
  `PUBLIC_HOSTNAME`'s and `TURN_HOSTNAME`'s DNS at your public IP (dynamic DNS
  if it's not static), or
- **Tunnel** (e.g. a Cloudflare Tunnel or Tailscale Funnel) terminating at this
  machine, with `PUBLIC_HOSTNAME`/`TURN_HOSTNAME` pointed at the tunnel's
  hostname(s) instead.

This doc doesn't pick one for you — see design-doc-v6.md §1a. Same-machine
testing below works either way, without this decision made yet.

### TLS certs

Production: run acme.sh/certbot against both `PUBLIC_HOSTNAME` and
`TURN_HOSTNAME` and mount the results into the `certs` volume at
`/etc/letsencrypt` (Let's Encrypt's own directory layout —
`live/<hostname>/fullchain.pem` + `privkey.pem`, one directory per hostname).

Local dev, before §1a is resolved: two options, both writing into the same
layout. Prefer mkcert if you have it (or can install it) — its certs are
trusted automatically by `lk`, curl, and browsers, unlike a plain
self-signed cert:

```bash
./scripts/dev-mkcert-cert.sh   # preferred — https://github.com/FiloSottile/mkcert
# or, if you don't want to install mkcert:
./scripts/dev-selfsigned-cert.sh
```

With the plain self-signed script, `curl -k` and browser click-through-
warning both still work, but non-browser clients like `lk` validate TLS
strictly and will reject it — you'd need to manually trust the generated
cert (e.g. import it into your OS's trusted root store) for those to work.

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

**Implemented** (`services/auth-service/`, `infra/livekit/`, `infra/nginx/`, `infra/coturn/`):
- LiveKit SFU + Redis wired in, nginx's SNI stream-demux routing TURN/TLS-443
  traffic to coturn and everything else to the app on the same port.
- Bare-bones auth: allowlist + email OTP (`/otp/request`, `/otp/verify`) +
  short-lived JWT access/refresh tokens, backed by SQLite.
- Room token minting (`/room/token`) bundling both the LiveKit room token and
  TURN credentials in one call.
- §1a's reachability decision — port-forward vs. tunnel — is a per-deployment
  choice (see "§1a's open decision" above), not something baked into the code;
  either works with this stack once DNS/certs point at it.

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

**2. Verify it** (grab the code from the logs). Since Phase 2, this also registers a
device — `deviceId` is whatever your client generates and persists on first login
(§4); for this walkthrough, make one up:

```bash
curl -k -X POST https://localhost/auth/otp/verify \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","code":"123456","deviceId":"my-test-device","platform":"web"}'
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

**4. Join the room** with `livekit-cli`. Since Phase 2, the LiveKit participant
identity is your **device id**, not your email (§4/§13 — this is what lets
revocation disconnect one device without touching your other one):

```bash
lk room join --url <livekitUrl> --api-key devkey --api-secret <LIVEKIT_API_SECRET> \
  --identity my-test-device test-room
```

Repeat steps 1-4 with a second allowlisted email from a second device to get
two participants in the same room — that's Phase 1's actual finish line.

## Phase 2 walkthrough: access control & revocation

**Implemented** (`services/auth-service/app/devices.py` + `routers/devices.py`,
migration `002_phase2_access_control.sql`):
- Full device table (`active`/`revoked`/`expired`), a 2-devices-per-person cap
  (§4), and per-device + per-person (`revoke-all`) revocation endpoints.
- Synchronous `RemoveParticipant` teardown on revoke — awaited in the request
  path, not backgrounded, so there's no window where a device is revoked in
  the DB but still connected to a live call (§4 v5 fix).
- Device-list version counter (`/devices/versions`) that bumps on every
  revoke, standing in for a real push-based banner until Phase 5's
  wake-service exists.
- Web-identity heartbeat + auto-expiry sweep (hourly, `main.py`'s
  `_expiry_sweep_loop`) for the web platform's weaker persistent-identity
  story (§4).

This exercises §13 Phase 2's "done when" bar — revoking a device that's mid-call
disconnects it within a couple of seconds, and the other party sees a
device-list-changed signal without refreshing.

**1. Register a second device** for the same person (repeat the OTP dance from
above with a different `deviceId`, e.g. `my-test-device-2`, `platform: android`).
A third device for the same email gets rejected — `403`, "already has 2 active
devices" — that's the §4 per-person device cap.

**2. List your devices:**

```bash
curl -k https://localhost/auth/devices/me -H "Authorization: Bearer <accessToken>"
```

**3. Start a call from `my-test-device`** (step 4 above, left running in a
terminal), then, from a *second* terminal, **revoke it** using the access token
from `my-test-device-2` (a device can only revoke itself or its owner's other
devices — see `app/routers/devices.py` for the scope note on why this doesn't
extend to revoking someone else's devices yet):

```bash
curl -k -X POST https://localhost/auth/devices/my-test-device/revoke \
  -H "Authorization: Bearer <accessToken-for-my-test-device-2>"
```

The response's `disconnectedLiveSession` tells you whether it found and killed
a live LiveKit session for that device. Check the first terminal — `lk room
join` should exit within a couple of seconds, not hang until the room token's
10-minute TTL runs out. That's the RemoveParticipant teardown (§4 v5 fix), not
just a DB flag that the next connection attempt would have caught.

**4. Confirm it can't come back**: re-running step 3's `otp/verify` for
`my-test-device` now 403s ("this device was revoked"), and its old
`accessToken`/`refreshToken` are rejected by `/room/token` and `/token/refresh`
respectively — the DB-status lookup (§4), not just JWT signature/expiry.

**5. Watch the banner precursor.** There's no wake-service push until Phase 5,
so this is polling-based for now:

```bash
curl -k https://localhost/auth/devices/versions -H "Authorization: Bearer <accessToken>"
```

The revoke in step 3 bumped `you@example.com`'s counter. A real client polls
this for its contacts and shows the device-list-changed banner on a bump —
piggyback it on the existing 15-minute token refresh once there's an actual
client loop to hang it off of.

## Phase 3 walkthrough: call quality & Russia-path reliability

This exercises §13 Phase 3's revised "done when" bar — local network emulation
standing in for the real India/Russia link, since neither party needs to be on
it to run this.

**1. Bring up the testing overlay** (adds toxiproxy in front of the TURN/TLS path):

```bash
docker compose -f docker-compose.yml -f docker-compose.testing.yml up -d
./scripts/toxiproxy-scenarios.sh setup
```

**2. Serve the harness** and open it in two browser tabs:

```bash
cd testing/webrtc-harness && python3 -m http.server 8000
```

In each tab, paste a room token and the ICE server list — both come back from
the same call: `POST /auth/room/token` returns `{ roomToken, livekitUrl,
turnCredentials }`. Convert `turnCredentials` into the `iceServers` array the
harness expects (`[{ urls: turnCredentials.uris, username: ..., credential:
turnCredentials.password }]`).

**3. Apply Russia-representative conditions to one tab's peer** (find its LAN
IP first, e.g. via your router's client list or `arp -a`):

```bash
sudo ./scripts/network-emulation.sh eth0 <peer-ip> --delay 120 --jitter 30 --loss 4 --block-udp
```

The dashboard (`/auth/quality/dashboard`, paste in an access token) should
start showing `relay` / `tls` for that peer within a few seconds — that's the
UDP block forcing the TURN/TLS-443 fallback exactly as designed (§1 v5 fix).

**4. Trigger a scripted outage mid-call:**

```bash
./scripts/toxiproxy-scenarios.sh cut 5
```

Watch the harness log an `Reconnecting -> Reconnected` cycle, and confirm the
call didn't fully drop — that's the ICE-restart criterion from the done-bar.

**5. Clean up:**

```bash
sudo ./scripts/network-emulation.sh eth0 <peer-ip> --clear
./scripts/toxiproxy-scenarios.sh teardown
docker compose -f docker-compose.yml -f docker-compose.testing.yml down
```

## Repo layout

See design-doc-v6.md §3a.
