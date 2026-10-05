#!/usr/bin/env bash
# Writes the .env a deployment needs, generating every secret in it.
#
# Why this exists as a separate step rather than inside `docker compose up`:
# Compose reads .env to interpolate the compose file *before* it starts any
# container, so nothing compose runs can create the file it has already
# parsed. One command has to come first; this is it, and it only has to be
# run once.
#
#   ./scripts/bootstrap.sh app.example.com you@example.com
#   docker compose up -d
#
# Idempotent on purpose. Re-running never replaces a secret that is already
# set to a real value -- on a live deployment that would invalidate every
# session, every TURN credential and every push subscription at once. It only
# fills in what is missing or still the placeholder from .env.example.
set -euo pipefail

cd "$(dirname "$0")/.."

PUBLIC_HOSTNAME="${1:-}"
ADMIN_EMAIL="${2:-}"
TURN_HOSTNAME="${3:-}"

if [ -z "$PUBLIC_HOSTNAME" ] || [ -z "$ADMIN_EMAIL" ]; then
    cat >&2 <<USAGE
usage: $0 <public-hostname> <admin-email> [turn-hostname]

  public-hostname  where the app is served, e.g. app.example.com
  admin-email      the first allowlisted member, and the contact Let's Encrypt
                   and the push services are given
  turn-hostname    defaults to turn.<parent domain of public-hostname>

Both hostnames must already resolve to this machine: certificates are issued
over HTTP-01, which Let's Encrypt checks by connecting back to them.
USAGE
    exit 2
fi

if [ -z "$TURN_HOSTNAME" ]; then
    # section 7.1 demultiplexes TURN from app traffic by SNI, so the two names must
    # differ. Derived rather than asked for, since there is one sane answer.
    parent="${PUBLIC_HOSTNAME#*.}"
    TURN_HOSTNAME="turn.${parent}"
fi

if [ "$PUBLIC_HOSTNAME" = "$TURN_HOSTNAME" ]; then
    echo "bootstrap: the app and TURN hostnames must differ (section 7.1 demuxes on SNI)" >&2
    exit 1
fi

[ -f .env ] || cp .env.example .env

current() {
    sed -n "s|^$1=||p" .env | head -1
}

shipped() {
    sed -n "s|^$1=||p" .env.example | head -1
}

# A value counts as never-set if it is empty, one of the obvious placeholder
# words, or still byte-identical to what .env.example ships for that key.
#
# Comparing against .env.example rather than matching patterns: the first
# version of this guessed with globs like *.yourdomain.example and silently
# kept ACME_EMAIL and WAKE_VAPID_SUBJECT at their placeholders, because
# "you@yourdomain.example" does not end in ".yourdomain.example". An exact
# comparison cannot be wrong in that direction.
placeholder() {
    # `local`, and a name nothing else uses. Without local this assigned to
    # whatever `value` was in scope -- bash scopes dynamically, so it
    # overwrote keep_or_set's local `value` with the placeholder it had just
    # read, and keep_or_set then wrote that placeholder straight back while
    # printing "set". Everything looked right and nothing was.
    local existing
    existing="$(current "$1")"
    [ -z "$existing" ] && return 0
    case "$existing" in
        change_me_to_a_long_random_secret | changeme | change_me | secret | devkey) return 0 ;;
    esac
    [ "$existing" = "$(shipped "$1")" ] && return 0
    return 1
}

put() {
    local key="$1" value="$2"
    if grep -q "^${key}=" .env; then
        # A temp file and a move: an in-place edit interrupted halfway leaves
        # a .env with half the secrets, which is harder to notice than none.
        local tmp
        tmp="$(mktemp)"
        awk -v k="$key" -v v="$value" \
            'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > "$tmp"
        mv "$tmp" .env
    else
        printf '%s=%s\n' "$key" "$value" >> .env
    fi
}

# Only writes when the existing value is missing or a placeholder.
keep_or_set() {
    local key="$1" value="$2"
    if placeholder "$key"; then
        put "$key" "$value"
        echo "  set $key"
    else
        echo "  kept $key (already set)"
    fi
}

secret() { openssl rand -hex 32; }

echo "bootstrap: writing .env for ${PUBLIC_HOSTNAME}"

keep_or_set PUBLIC_HOSTNAME "$PUBLIC_HOSTNAME"
keep_or_set TURN_HOSTNAME "$TURN_HOSTNAME"
keep_or_set ADMIN_SEED_EMAILS "$ADMIN_EMAIL"
keep_or_set ACME_EMAIL "$ADMIN_EMAIL"
keep_or_set WAKE_VAPID_SUBJECT "mailto:${ADMIN_EMAIL}"

keep_or_set JWT_SECRET "$(secret)"
keep_or_set LIVEKIT_API_KEY "kp$(openssl rand -hex 6)"
keep_or_set LIVEKIT_API_SECRET "$(secret)"
keep_or_set TURN_SHARED_SECRET "$(secret)"
keep_or_set REDIS_PASSWORD "$(secret)"
keep_or_set WAKE_INTERNAL_SECRET "$(secret)"

# Derived from whatever the hostnames ACTUALLY are now, not from the
# arguments. On a re-run with a different hostname the keep_or_set above
# deliberately keeps the old one -- deriving from the argument then produced
# an .env naming one host in PUBLIC_HOSTNAME and another in LIVEKIT_URL, so
# certificates were issued for one name and clients sent to the other.
effective_public="$(current PUBLIC_HOSTNAME)"
effective_turn="$(current TURN_HOSTNAME)"

if [ "$effective_public" != "$PUBLIC_HOSTNAME" ]; then
    echo
    echo "  NOTE: .env already names ${effective_public}, so ${PUBLIC_HOSTNAME} was ignored."
    echo "        Changing the hostname of a live deployment means new certificates;"
    echo "        edit PUBLIC_HOSTNAME and TURN_HOSTNAME in .env by hand, delete"
    echo "        ./certs/live/<old name>, and bring the stack back up."
    echo
fi

put LIVEKIT_URL "wss://${effective_public}"
put TURN_REALM "${effective_turn}"
put WEB_CLIENT_ORIGIN "https://${effective_public}"
put CORS_ALLOWED_ORIGINS "https://${effective_public}"

# Production posture, stated rather than assumed.
put DEV_AUTO_CERTS false
put LIVEKIT_USE_EXTERNAL_IP true
put TRUST_PROXY_HEADERS true

# So `docker compose up -d` on its own picks up the production overlay. Without
# this the operator has to remember two -f flags forever, and forgetting them
# silently starts the dev stack with no real certificates.
put COMPOSE_FILE "docker-compose.yml:docker-compose.prod.yml"

chmod 600 .env

cat <<DONE

bootstrap: done. .env holds real secrets now -- it is gitignored, back it up
somewhere safe, and note that regenerating JWT_SECRET signs everyone out.

Before starting, check that both names point at this machine:
  ${effective_public}
  ${effective_turn}

Then:
  docker compose up -d

OTP_TRANSPORT is still "$(current OTP_TRANSPORT)". Leave it as console only
while testing -- it prints login codes to the service log instead of emailing
them, which means anyone who can read the log can sign in as anyone.
DONE
