# Redeploy runbook

What to actually type, in order, to put this stack on a fresh Hetzner box —
and what to type when it is already running and something is wrong.

Design doc §11 sets the target: back up and serving again in under an hour.
That number is only meaningful if the steps below have been rehearsed, so
rehearse them on a throwaway server before you need them.

## First deploy

A CX22 (2 vCPU, 4 GB) is enough. 2 GB works only if images are pulled rather
than built — building the Next.js bundle needs more memory than that.

**1. DNS before anything else.** Point both names at the server's IPv4:

```
app.example.com     A    <server ip>
turn.example.com    A    <server ip>
```

Both are needed. §7.1 tells TURN traffic from app traffic apart by SNI, so
they cannot be the same name. Certificates are issued over HTTP-01, which
Let's Encrypt validates by connecting back to these names — if they do not
resolve yet, issuance fails and nginx never starts.

**2. Open the firewall.** Hetzner's cloud firewall, and ufw if you use it:

| Port | Why |
|---|---|
| 80/tcp | ACME HTTP-01 only. nginx never binds it. |
| 443/tcp | the app, and TURN over TLS via the SNI demux |
| 3478/tcp+udp | STUN/TURN |
| 49160-49200/udp | TURN relay range |
| 7881/tcp | LiveKit ICE/TCP fallback |
| 20000-20100/udp | LiveKit media |

**3. Install Docker**, clone, and run one command:

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/soumik15630m/kuchupuchu.git && cd kuchupuchu
./scripts/deploy.sh app.example.com you@example.com
```

That generates every secret, obtains certificates, and starts the stack.

**From then on, the only command is `docker compose up -d`.** `bootstrap.sh`
writes `COMPOSE_FILE` into `.env`, so compose picks up the production overlay
with no flags to remember.

**4. Check it.**

```bash
curl -sfI https://app.example.com/healthz && echo OK
docker compose ps
```

Then sign in as the address you passed as the admin email — it is seeded into
the allowlist.

### While debugging, use the staging CA

Let's Encrypt's production limits are unforgiving: five failures locks a name
out for an hour. If the first attempt does not work, set `ACME_STAGING=true`
in `.env` and `docker compose up -d acme` until it does, then set it back to
`false` and delete `./certs/live/<name>` so a trusted certificate is issued.

## Updating

Through CI, which builds images and restarts the server:

> Actions -> Deploy -> Run workflow

Or by hand on the server:

```bash
git pull && docker compose up -d
```

Set the repository variable `DEPLOY_ON_PUSH=true` to deploy every green push
to master instead. It is off by default: a push should not restart a call two
people are on.

CI needs four repository secrets: `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_SSH_KEY`, `DEPLOY_PATH`.

## Rolling back

Images are tagged by commit, so a rollback is a tag change:

```bash
sed -i 's|^IMAGE_TAG=.*|IMAGE_TAG=<previous sha>|' .env
docker compose up -d
```

Nothing in the database schema is removed by a migration, so an older image
reads a newer database. Going back more than a few releases is not something
to find out about during an outage — rehearse it.

## Restoring after losing the machine

Everything that cannot be rebuilt is in two places:

- the `sqlite-data` volume — accounts, devices, messages in flight, media,
  push subscriptions, and `vapid.json`
- `.env` — every secret

Both need backing up. The rest is in git.

```bash
# on the old machine, or from a backup
docker run --rm -v kuchupuchu_sqlite-data:/data -v "$PWD":/out alpine \
  tar czf /out/sqlite-data.tgz -C /data .

# on the new one, after cloning and copying .env back
docker volume create kuchupuchu_sqlite-data
docker run --rm -v kuchupuchu_sqlite-data:/data -v "$PWD":/in alpine \
  tar xzf /in/sqlite-data.tgz -C /data
docker compose up -d
```

Restoring `.env` matters more than it looks:

- a new `JWT_SECRET` signs every member out
- a new `WAKE_VAPID_PRIVATE_KEY` silently unsubscribes every browser from
  push, because a browser refuses a push signed by a key it did not subscribe
  with. The key lives in the volume as `vapid.json` and is generated once —
  restore the volume and it survives.

Members' own message history is on their devices and in their own
passphrase-encrypted backups. The server holds ciphertext it cannot read, so
losing it is not the same as losing the conversation.

## When something is wrong

```bash
docker compose ps                      # what is actually running
docker compose logs --tail 100 nginx   # usually a certificate
docker compose logs --tail 100 acme    # why there is no certificate
docker compose logs --tail 100 auth-service
```

**nginx will not start.** Almost always no certificate. `docker compose logs
acme` says why — usually DNS not resolving to this machine, or port 80
unreachable from outside.

**coturn restarts in a loop saying it has no readable certificate.** It runs
as uid 10001, and certbot writes both the key and the directories above it
root-only — nginx never notices because it reads them as root at config load.
The acme service re-grants read access to that group on every pass, renewals
included, so this should not happen. If the `./certs` tree was ever written
by something else, `docker compose restart acme` puts the permissions back.

**Calls connect but nobody hears anything.** The UDP ranges are closed.
Check 3478, 49160-49200 and 20000-20100 in the Hetzner firewall, not just ufw.

**Login codes never arrive.** `OTP_TRANSPORT` is still `console` — they are
being printed to the auth-service log instead of emailed. Set the SMTP
variables and switch it to `smtp`.

**Notifications do not arrive when the app is closed.** `docker compose logs
wake-service`. A `410 Gone` from the push service is normal and self-healing:
the subscription has been retired and the browser makes a new one. A `401`
means the VAPID key changed.
