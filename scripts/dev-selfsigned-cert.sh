#!/usr/bin/env bash
# Generates a throwaway self-signed cert for local Phase 1 testing, into the
# same layout the `certs` volume expects (Let's Encrypt's live/ layout), so
# nginx/coturn configs don't need a dev-only code path.
#
# NOT for anything beyond same-machine/same-LAN testing. Real TLS via
# acme.sh/Let's Encrypt is required once §1a's reachability decision is made.
set -euo pipefail

source .env 2>/dev/null || true
HOSTNAME="${PUBLIC_HOSTNAME:?Set PUBLIC_HOSTNAME in .env first}"

OUT_DIR="./certs/live/${HOSTNAME}"
mkdir -p "$OUT_DIR"

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "${OUT_DIR}/privkey.pem" \
  -out "${OUT_DIR}/fullchain.pem" \
  -days 30 \
  -subj "/CN=${HOSTNAME}"

echo "Self-signed cert written to ${OUT_DIR}"
echo "Mount ./certs as the 'certs' volume for local testing (see docker-compose.yml)."
