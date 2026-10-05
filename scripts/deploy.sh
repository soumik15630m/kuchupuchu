#!/usr/bin/env bash
# One command, from a bare machine to a running stack.
#
#   ./scripts/deploy.sh app.example.com you@example.com
#
# After the first run, .env exists and carries COMPOSE_FILE, so the only
# command needed from then on is:
#
#   docker compose up -d
#
# This script is the first run, and a safe no-op to repeat: bootstrap never
# replaces a secret that is already set.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
    if [ $# -lt 2 ]; then
        echo "deploy: no .env yet, so the hostname and contact email are needed:" >&2
        echo "  $0 <public-hostname> <admin-email> [turn-hostname]" >&2
        exit 2
    fi
    ./scripts/bootstrap.sh "$@"
else
    echo "deploy: .env already exists, leaving it alone"
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

echo
echo "deploy: checking DNS before asking Let's Encrypt to"
# Issuance fails if these do not resolve here, and the failure arrives several
# minutes later as a certificate that never appears. Catching it now turns a
# confusing timeout into a sentence.
for name in "$PUBLIC_HOSTNAME" "$TURN_HOSTNAME"; do
    if ! getent hosts "$name" >/dev/null 2>&1 && ! host "$name" >/dev/null 2>&1; then
        echo "  WARNING: $name does not resolve from this machine." >&2
        echo "           Let's Encrypt validates over HTTP-01 by connecting back to it," >&2
        echo "           so issuance will fail until DNS points here." >&2
    else
        echo "  ok: $name resolves"
    fi
done

echo
if [ -n "${IMAGE_PREFIX:-}" ]; then
    echo "deploy: pulling images from ${IMAGE_PREFIX}"
    docker compose pull
else
    echo "deploy: building images locally (set IMAGE_PREFIX to pull CI-built ones instead)"
    docker compose build
fi

echo
echo "deploy: starting"
docker compose up -d --remove-orphans

echo
echo "deploy: waiting for the stack to come up"
# nginx is last in the dependency chain and gated on a real certificate, so it
# being up is the signal that everything before it worked.
for _ in $(seq 1 60); do
    if docker compose ps --status running --services 2>/dev/null | grep -qx nginx; then
        echo "  nginx is running"
        break
    fi
    sleep 5
done

echo
docker compose ps
cat <<DONE

If nginx is not running, the certificate is the usual reason:
  docker compose logs acme | tail -40

Then check the app answers:
  curl -sfI https://${PUBLIC_HOSTNAME}/healthz && echo OK
DONE
