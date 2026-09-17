#!/bin/sh
# Signs dev TLS certificates for PUBLIC_HOSTNAME and TURN_HOSTNAME, using
# the mkcert CA mounted at /caroot. Runs to completion and exits; nginx
# and coturn wait on it via `service_completed_successfully`.
set -eu

CERT_ROOT=/certs
CAROOT=/caroot
export CAROOT

# --- Gate ------------------------------------------------------------
# Off unless explicitly enabled. This service writes into ./certs, and
# ./certs is also where real acme.sh/Let's Encrypt certificates live in a
# production deployment (see the README's TLS section). A cert generator
# that runs by default would be one `docker compose up` away from
# replacing real certificates with dev ones signed by a CA nobody outside
# this machine trusts -- silently, since the stack would still start.
case "${DEV_AUTO_CERTS:-false}" in
    true|TRUE|1|yes|YES) ;;
    *)
        echo "cert-init: DEV_AUTO_CERTS is not enabled — leaving ./certs untouched."
        exit 0
        ;;
esac

: "${PUBLIC_HOSTNAME:?cert-init: PUBLIC_HOSTNAME is not set}"
: "${TURN_HOSTNAME:?cert-init: TURN_HOSTNAME is not set}"

if [ "$PUBLIC_HOSTNAME" = "$TURN_HOSTNAME" ]; then
    # §7.1: nginx's SNI demux distinguishes TURN traffic from app traffic
    # purely by hostname. Equal values aren't a cert problem, they're a
    # routing one -- but this is the earliest point that can see it, and
    # the symptom otherwise is TURN traffic being handed to a server that
    # doesn't speak it.
    echo "cert-init: PUBLIC_HOSTNAME and TURN_HOSTNAME must be different hostnames (§7.1)." >&2
    exit 1
fi

# --- The CA ----------------------------------------------------------
if [ ! -r "${CAROOT}/rootCA.pem" ] || [ ! -r "${CAROOT}/rootCA-key.pem" ]; then
    echo "cert-init: no mkcert CA found at ${CAROOT}." >&2
    echo "" >&2
    echo "  Certificates must be signed by the CA that is already installed in" >&2
    echo "  THIS MACHINE's trust store -- otherwise browsers, curl and lk won't" >&2
    echo "  trust them, which is the entire reason for using mkcert here." >&2
    echo "" >&2
    echo "  On the host, once:" >&2
    echo "    mkcert -install        # creates and trusts the local CA" >&2
    echo "    mkcert -CAROOT         # prints the directory to use below" >&2
    echo "" >&2
    echo "  Then set MKCERT_CAROOT in .env to that directory." >&2
    echo "  Or set DEV_AUTO_CERTS=false and manage ./certs yourself." >&2
    exit 1
fi

# --- Signing ---------------------------------------------------------

# Whether an existing certificate is safe to replace. Two cases qualify,
# and the distinction is what keeps this from being either useless or
# dangerous:
#
#   1. Issued by this machine's dev CA -- ours already, just refreshing.
#   2. Self-signed (issuer == subject). Nothing vouched for it, so it
#      cannot be a real certificate: acme.sh/Let's Encrypt certs are
#      issued BY a CA, which makes issuer != subject by construction.
#      In practice these are leftovers from
#      scripts/dev-selfsigned-cert.sh, which browsers and `lk` don't
#      trust anyway -- replacing them with mkcert-issued ones is a
#      strict improvement, and refusing would mean "automatic" certs
#      required a manual delete first.
#
# Anything else -- a certificate signed by some CA that isn't ours -- is
# left alone, because that is what a real deployment looks like.
is_overwritable() {
    cert="$1"

    if openssl verify -CAfile "${CAROOT}/rootCA.pem" "$cert" >/dev/null 2>&1; then
        return 0
    fi

    issuer="$(openssl x509 -in "$cert" -noout -issuer 2>/dev/null | sed 's/^issuer=//')"
    subject="$(openssl x509 -in "$cert" -noout -subject 2>/dev/null | sed 's/^subject=//')"
    if [ -n "$issuer" ] && [ "$issuer" = "$subject" ]; then
        echo "  (replacing a self-signed certificate — it was not trusted by anything)"
        return 0
    fi

    return 1
}

sign() {
    host="$1"
    dir="${CERT_ROOT}/live/${host}"

    if [ -s "${dir}/fullchain.pem" ] && ! is_overwritable "${dir}/fullchain.pem"; then
        echo "cert-init: ${dir}/fullchain.pem was issued by a CA that isn't this machine's dev CA." >&2
        echo "  That's what a real (acme.sh/Let's Encrypt) certificate looks like, so it is" >&2
        echo "  being left alone rather than downgraded to one only this machine trusts." >&2
        echo "  Set DEV_AUTO_CERTS=false if this stack is using real certificates." >&2
        exit 1
    fi

    mkdir -p "$dir"
    # mkcert warns that the CA isn't in the container's own trust store.
    # That's expected and irrelevant: the container never validates
    # anything, it only signs. What matters is the host trust store,
    # which already has this CA.
    mkcert -cert-file "${dir}/fullchain.pem" -key-file "${dir}/privkey.pem" "$host" 2>&1 \
        | sed 's/^/  mkcert: /'

    if [ ! -s "${dir}/fullchain.pem" ] || [ ! -s "${dir}/privkey.pem" ]; then
        rm -f "${dir}/fullchain.pem" "${dir}/privkey.pem"
        echo "cert-init: mkcert did not produce both files for ${host}" >&2
        exit 1
    fi

    # nginx runs its workers as `nginx` and coturn as uid 10001; on a
    # Linux host a bind mount preserves mode exactly, so a key only the
    # owner can read is present-but-unreadable to them. See the same note
    # in scripts/dev-*-cert.sh -- these are throwaway certs for hostnames
    # that don't resolve publicly, and this is not a pattern to carry over
    # to real keys.
    chmod 644 "${dir}/fullchain.pem" "${dir}/privkey.pem"
    echo "cert-init: signed ${host}"
}

sign "$PUBLIC_HOSTNAME"
sign "$TURN_HOSTNAME"
echo "cert-init: done."
