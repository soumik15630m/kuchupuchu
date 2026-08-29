#!/usr/bin/env bash
# mkcert alternative to dev-selfsigned-cert.sh.
#
# mkcert generates certs signed by a local CA it installs into your system
# (and browser, on some platforms) trust stores via `mkcert -install`, so
# `lk`, curl without -k, and browsers all trust the result automatically --
# no manual Import-Certificate / --insecure flag needed. Same target layout
# as dev-selfsigned-cert.sh (Let's Encrypt's live/<hostname>/ directory
# structure), so nginx/coturn don't need a different code path either way.
#
# Requires: https://github.com/FiloSottile/mkcert installed and on PATH.
#
# NOT for anything beyond same-machine/same-LAN testing. Real TLS via
# acme.sh/Let's Encrypt is required once §1a's reachability decision is made.
set -euo pipefail

command -v mkcert >/dev/null || {
  echo "mkcert not found on PATH. Install it: https://github.com/FiloSottile/mkcert#installation" >&2
  exit 1
}

source .env 2>/dev/null || true

# One-time: installs mkcert's local CA into the system (and where supported,
# browser) trust store. Safe to re-run -- no-ops if already installed.
mkcert -install

generate_cert() {
  local hostname="$1"
  local out_dir="./certs/live/${hostname}"
  mkdir -p "$out_dir"

  # mkcert names output after the hostname; move into the fixed
  # fullchain.pem/privkey.pem names nginx/coturn's templates expect.
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  mkcert -cert-file "${tmp_dir}/cert.pem" -key-file "${tmp_dir}/key.pem" "$hostname"
  mv "${tmp_dir}/cert.pem" "${out_dir}/fullchain.pem"
  mv "${tmp_dir}/key.pem" "${out_dir}/privkey.pem"
  rmdir "$tmp_dir"

  echo "mkcert cert written to ${out_dir}"
}

generate_cert "${PUBLIC_HOSTNAME:?Set PUBLIC_HOSTNAME in .env first}"
generate_cert "${TURN_HOSTNAME:?Set TURN_HOSTNAME in .env first}"

echo "Mount ./certs as the 'certs' volume for local testing (see docker-compose.yml)."
echo "Since these are mkcert-signed, curl and lk should trust them without -k / --insecure."
