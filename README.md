# Private Voice/Video App

Design doc: [`docs/design-doc-v6.md`](./docs/design-doc-v6.md) — read §1a (hosting), §3a (this
repo's layout), and §13 (implementation phases) first.

**Current status: Phase 4 (§13) done, validated 2026-09-16** — end-to-end
encryption, on top of Phase 1's SFU + minimal auth walking skeleton, Phase 2's
access control/revocation, and Phase 3's call quality & Russia-path reliability
(done, validated 2026-09-02).

The done-bar was met with three real browser tabs against the local stack:
a 1:1 call and a 3-participant call with a mid-call join *and* leave, with
the displayed room-key fingerprint compared across every participant at
each step and remote video confirmed decrypting throughout. See "Phase 4
walkthrough" below for the exact sequence, and §13 Phase 4 in the design
doc for the recorded result.

`wake-service`, `messaging-service`, and both real `clients/` are
placeholders until Phase 5/6 — `testing/webrtc-harness/` is a throwaway browser
harness standing in for them so Phases 3 and 4 had somewhere to run.

## Dependencies

`services/auth-service/requirements*.txt` are hash-locked (`pip-compile
--generate-hashes`), generated from `requirements*.in`. To bump or add a
dependency, edit the `.in` file and regenerate:

```bash
pip install pip-tools
pip-compile --generate-hashes --output-file=requirements.txt requirements.in
pip-compile --generate-hashes --output-file=requirements-dev.txt requirements-dev.in
```

Don't hand-edit the `.txt` files — the hashes won't match a manually
bumped version pin, and `pip install` will refuse to proceed.

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

**Local dev: automatic.** With `DEV_AUTO_CERTS=true` in `.env` (the
default in `.env.example`), `docker compose up` signs certs for whatever
`PUBLIC_HOSTNAME`/`TURN_HOSTNAME` are currently set, before nginx and
coturn start. There is no manual cert step, and changing a hostname can't
leave you running against certs for the old one.

It needs one-time setup, because the certs have to be signed by the CA
that's already in *your* trust store — a CA generated inside a container
would be trusted by nobody:

```bash
mkcert -install    # once per machine: creates and trusts the local CA
mkcert -CAROOT     # prints the directory — put it in .env as MKCERT_CAROOT
```

That directory is mounted read-only into a short-lived `cert-init`
service which signs with it. Two guards worth knowing about: it does
nothing at all unless `DEV_AUTO_CERTS` is true, and it refuses to
overwrite any certificate its own CA didn't issue — so pointing this at a
deployment holding real acme.sh certificates stops with an error instead
of silently downgrading it to certs one machine trusts. **Set
`DEV_AUTO_CERTS=false` for any real deployment.**

The standalone scripts still exist for generating certs without bringing
the stack up, and both write the same layout:

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

**Certs are per-hostname, and the hostname is in `.env`.** Both scripts
write to `./certs/live/<hostname>/`, and nginx/coturn look up exactly the
`PUBLIC_HOSTNAME`/`TURN_HOSTNAME` currently set. So changing either one —
which happens on its own if you use a `nip.io`-style name with your LAN IP
embedded in it, and that IP changes — means the existing certs no longer
match and you need to re-run the script. Both containers now fail at
startup with the expected path, the hostnames they *did* find, and the
command to fix it, rather than an opaque TLS load error.

Two notes for Windows, both of which used to stop these scripts working
at all:

- `mkcert -install` exits non-zero if *any* trust store it knows about
  fails, including the Java keystore (needs administrator rights) and
  Firefox/NSS. Neither matters here. The script now treats the **system**
  trust store — the one browsers, `curl` and `lk` read — as the thing
  that has to succeed, and downgrades the rest to a warning.
- Git Bash/MSYS rewrites path-shaped arguments, which mangled openssl's
  `-subj "/CN=host"` into a filesystem path and made the self-signed
  script fail after writing the key but before writing the certificate.

## Running it

```bash
docker compose up --build
```

This builds and starts nginx, coturn, LiveKit, Redis, and auth-service.
auth-service runs its SQLite migrations automatically on boot, seeds the
allowlist from `ADMIN_SEED_EMAILS` in `.env`, and grants cross-person
revoke privilege to anyone listed in `ADMIN_EMAILS` (must already be in
`ADMIN_SEED_EMAILS` — see `app/migrate.py:seed_admins`).

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

**3. Mint a room token.** You name the *people* you're calling, not the
room — the server derives the room name from the participant set
(`app/rooms.py`) and mints a grant scoped to it:

```bash
curl -k -X POST https://localhost/auth/room/token \
  -H "Authorization: Bearer <accessToken>" \
  -H 'Content-Type: application/json' \
  -d '{"participants":["them@example.com"]}'
```

Save the `roomName`, `roomToken` and `livekitUrl` from the response.
Everyone on the call derives the same `roomName` from their own end
without coordinating, so the other party runs the same request with
*your* address in `participants` and lands in the same room.

This is what stops an allowlisted member joining a call they weren't
part of: a token can only ever be minted for a room whose name is
derived from a participant set the caller is in, so there's no request
an outsider can make that produces a grant for someone else's call.
Every address named must already be on the allowlist.

**4. Join the room** with `livekit-cli`. Since Phase 2, the LiveKit participant
identity is your **device id**, not your email (§4/§13 — this is what lets
revocation disconnect one device without touching your other one):

```bash
lk room join --url <livekitUrl> --api-key devkey --api-secret <LIVEKIT_API_SECRET> \
  --identity my-test-device <roomName-from-step-3>
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
the same call: `POST /auth/room/token` returns `{ roomName, roomToken,
livekitUrl, turnCredentials }`. Convert `turnCredentials` into the `iceServers` array the
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

## Phase 4 walkthrough: end-to-end encryption

**Implemented** (`testing/webrtc-harness/signal-crypto.js`, `double-ratchet.js`,
`rotation.js`, `group-e2ee.js`, `key-provider.js`; `services/auth-service/app/prekeys.py`
+ `routers/prekeys.py`, migrations `004_phase4_prekeys.sql` and
`006_phase4_identity_dh_key.sql`):

- X3DH key agreement on native WebCrypto X25519/Ed25519, with prekey
  bundle publish/fetch backed by the auth-service.
- A generation-indexed transport chain per peer, carrying room-key
  delivery (not a general-purpose message ratchet — see
  `double-ratchet.js`'s header for the scoping).
- Deterministic rotator election, pairwise room-key distribution over
  LiveKit's data channel, and §6.1's fingerprint/retry/rejoin policy.
- SFrame frame encryption via LiveKit's own worker-based key provider.
- Identity safety numbers, distinct from the room-key fingerprint.

The crypto modules have real unit tests (`node --test test/*.test.mjs`
from `testing/webrtc-harness/`, 43 of them). What they can't cover is
frame encryption actually working against a live SFU, which is what the
done-bar below is for.

**1. Serve the harness over HTTPS** — it's mounted into nginx at
`/harness/` (see `docker-compose.yml`), so `docker compose up` is enough.
Open `https://<PUBLIC_HOSTNAME>/harness/` in two browsers/profiles.
Don't use a separate `python3 -m http.server`: `getUserMedia` needs a
secure context, and the E2EE worker's CSP is set up for this origin.

**2. In each tab**, fill in the LiveKit URL, the room token and access
token from the Phase 1 walkthrough, and the **device → email roster** —
a JSON object mapping every *other* participant's device id to their
email, e.g. `{"dev-b": "b@example.com"}`. That roster is a harness
concession; a real client already knows its own contacts (see
`group-e2ee.js`'s header).

**3. Connect both tabs** and compare the fingerprint shown under the
video. They must match. Then compare the **identity safety numbers** —
those are the values worth reading out over a *different* channel (a
phone call, in person), since they're what actually pins who you're
talking to; the room-key fingerprint only says you currently share a key.

**4. Add a third participant mid-call**, then have one leave. The
fingerprint must change on every join/leave (rotation) and must still
agree across all remaining tabs afterward. That's §13 Phase 4's actual
finish line.

If a "keys don't match — rejoin" banner appears instead, that's §6.1's
mismatch policy firing; `rotation.js` has the retry-then-prompt logic and
the harness log panel shows what led up to it.

## Repo layout

See design-doc-v6.md §3a.
