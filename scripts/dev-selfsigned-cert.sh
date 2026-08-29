#!/usr/bin/env bash
# Generates throwaway self-signed certs for local Phase 1/2 testing, into the
# same layout the `certs` volume expects (Let's Encrypt's live/ layout), so
# nginx/coturn configs don't need a dev-only code path.
#
# Two certs, not one: nginx's app vhost (PUBLIC_HOSTNAME) and coturn
# (TURN_HOSTNAME) are deliberately different hostnames — see
# infra/nginx/nginx.conf.template's demux comment for why — so each needs
# its own cert under its own live/<hostname>/ directory.
#
# NOT for anything beyond same-machine/same-LAN testing. Real TLS via
# acme.sh/Let's Encrypt is required once §1a's reachability decision is made.
set -euo pipefail

source .env 2>/dev/null || true

generate_cert() {
  local hostname="$1"
  local out_dir="./certs/live/${hostname}"
  mkdir -p "$out_dir"
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "${out_dir}/privkey.pem" \
    -out "${out_dir}/fullchain.pem" \
    -days 30 \
    -subj "/CN=${hostname}"
  echo "Self-signed cert written to ${out_dir}"
}

generate_cert "${PUBLIC_HOSTNAME:?Set PUBLIC_HOSTNAME in .env first}"
generate_cert "${TURN_HOSTNAME:?Set TURN_HOSTNAME in .env first}"

echo "Mount ./certs as the 'certs' volume for local testing (see docker-compose.yml)."
