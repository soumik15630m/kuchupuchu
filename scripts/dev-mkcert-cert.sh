#!/usr/bin/env bash
# mkcert alternative to dev-selfsigned-cert.sh: certs signed by a local
# CA in the system trust store, so curl, lk and browsers accept them
# without a flag. Same output layout as the self-signed script.
#
# Same-machine/same-LAN testing only -- real TLS comes with §1a.
set -euo pipefail

command -v mkcert >/dev/null || {
  echo "mkcert not found on PATH. Install it: https://github.com/FiloSottile/mkcert#installation" >&2
  exit 1
}

# Deliberately not `source .env`: that executes it, so any value
# containing $(...) or backticks runs as a command -- and this file
# holds JWT_SECRET and TURN_SHARED_SECRET. Parameter expansion rather
# than sed so no value needs escaping to survive being read back.
read_env() {
  local key="$1" line value
  [ -f .env ] || return 0
  line="$(grep -m1 -E "^[[:space:]]*${key}[[:space:]]*=" .env || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"   # strip leading whitespace
  value="${value%"${value##*[![:space:]]}"}"   # strip trailing whitespace
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-$(read_env PUBLIC_HOSTNAME)}"
TURN_HOSTNAME="${TURN_HOSTNAME:-$(read_env TURN_HOSTNAME)}"

# Not a bare `mkcert -install`: mkcert exits non-zero if ANY trust store
# fails, including the Java keystore, which needs administrator rights.
# Under `set -e` that aborted the script before it generated a single
# certificate even when the system store -- the only one browsers, curl
# and lk read -- was fine. So judge success by that store alone.
install_local_ca() {
  local output status
  set +e
  output="$(mkcert -install 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"

  [ "$status" -eq 0 ] && return 0

  # Matches both "is now installed" and "is already installed".
  if printf '%s' "$output" | grep -qi "installed in the system trust store"; then
    echo "" >&2
    echo "note: mkcert reported a failure for a trust store this project doesn't use" >&2
    echo "      (Java keystore and/or Firefox/NSS). The system trust store -- the one" >&2
    echo "      browsers, curl and lk actually read -- has the CA, so continuing." >&2
    echo "      Re-run from an elevated shell if you specifically need Java to trust it." >&2
    echo "" >&2
    return 0
  fi

  echo "mkcert -install did not install the CA into the system trust store; aborting." >&2
  exit 1
}

install_local_ca

generate_cert() {
  local hostname="$1"
  local out_dir="./certs/live/${hostname}"
  mkdir -p "$out_dir"

  # -cert-file/-key-file write straight to the names the templates
  # expect. Generating into a mktemp dir instead bought nothing and
  # added a path for Git Bash's MSYS layer to rewrite.
  mkcert -cert-file "${out_dir}/fullchain.pem" -key-file "${out_dir}/privkey.pem" "$hostname"

  # mkcert can report success having written only one of the pair.
  if [ ! -s "${out_dir}/fullchain.pem" ] || [ ! -s "${out_dir}/privkey.pem" ]; then
    rm -f "${out_dir}/fullchain.pem" "${out_dir}/privkey.pem"
    echo "mkcert did not produce both fullchain.pem and privkey.pem for ${hostname}" >&2
    exit 1
  fi


  # Containers read these through a read-only bind mount as fixed
  # unprivileged uids. On Linux the mount preserves the host's mode
  # exactly, so a 0600 key is unreadable to them; Docker Desktop fakes
  # permissions and hides that until you deploy on a real host.
  # Acceptable for throwaway 30-day certs only -- for the acme.sh keys,
  # grant the container's uid access deliberately instead.
  chmod 644 "${out_dir}/privkey.pem" "${out_dir}/fullchain.pem"

  echo "mkcert cert written to ${out_dir}"
}

generate_cert "${PUBLIC_HOSTNAME:?Set PUBLIC_HOSTNAME in .env first}"
generate_cert "${TURN_HOSTNAME:?Set TURN_HOSTNAME in .env first}"

echo "Mount ./certs as the 'certs' volume for local testing (see docker-compose.yml)."
echo "Since these are mkcert-signed, curl and lk should trust them without -k / --insecure."
