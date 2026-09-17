#!/usr/bin/env bash
# Throwaway self-signed certs for local testing, in the layout the
# `certs` volume expects, so nginx/coturn need no dev-only code path.
#
# Two certs: the app vhost and coturn are deliberately different
# hostnames (§7.1), so each needs its own live/<hostname>/ directory.
#
# Same-machine/same-LAN testing only -- real TLS comes with §1a.
set -euo pipefail

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

generate_cert() {
  local hostname="$1"
  local out_dir="./certs/live/${hostname}"
  mkdir -p "$out_dir"

  # Git Bash and MSYS2 rewrite any argument that looks like a Unix path
  # into a Windows one. `-subj "/CN=host"` looks exactly like a path and
  # arrived as `C:/Program Files/Git/CN=host`, which openssl rejects --
  # so this had never once worked on the environment it is developed in.
  # Both variables are no-ops on Linux and macOS.
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "${out_dir}/privkey.pem" \
    -out "${out_dir}/fullchain.pem" \
    -days 30 \
    -subj "/CN=${hostname}"

  # openssl writes the key before it validates -subj, so a failure leaves
  # a half-written pair behind. Check both exist rather than trusting the
  # exit code alone.
  if [ ! -s "${out_dir}/fullchain.pem" ] || [ ! -s "${out_dir}/privkey.pem" ]; then
    rm -f "${out_dir}/fullchain.pem" "${out_dir}/privkey.pem"
    echo "openssl did not produce both fullchain.pem and privkey.pem for ${hostname}" >&2
    exit 1
  fi

  # Containers read these through a read-only bind mount as fixed
  # unprivileged uids. On Linux the mount preserves the host's mode
  # exactly, so a 0600 key is unreadable to them; Docker Desktop fakes
  # permissions and hides that until you deploy on a real host.
  # Acceptable for throwaway 30-day certs only -- for the acme.sh keys,
  # grant the container's uid access deliberately instead.
  chmod 644 "${out_dir}/privkey.pem" "${out_dir}/fullchain.pem"

  echo "Self-signed cert written to ${out_dir}"
}

generate_cert "${PUBLIC_HOSTNAME:?Set PUBLIC_HOSTNAME in .env first}"
generate_cert "${TURN_HOSTNAME:?Set TURN_HOSTNAME in .env first}"

echo "Mount ./certs as the 'certs' volume for local testing (see docker-compose.yml)."
