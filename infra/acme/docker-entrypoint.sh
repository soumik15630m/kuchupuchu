#!/bin/sh
# Obtains and renews the TLS certificates nginx and coturn serve.
#
# Standalone HTTP-01 on port 80, not webroot: webroot needs a running web
# server to place the challenge file in, and on a first deploy nginx cannot
# start until the certificate exists. Standalone has no such ordering problem
# because this container owns port 80 outright -- nginx never binds it.
#
# section 7.1 demultiplexes TURN from app traffic by SNI, so both names need a
# certificate. They are requested separately rather than as one SAN
# certificate: coturn and nginx read different files, and a single
# certificate covering both would put the app's name in the TURN server's
# certificate for anyone who looked.
set -eu

: "${PUBLIC_HOSTNAME:?acme: PUBLIC_HOSTNAME is not set}"
: "${TURN_HOSTNAME:?acme: TURN_HOSTNAME is not set}"
: "${ACME_EMAIL:?acme: ACME_EMAIL is not set -- the ACME CA requires a contact address}"

CONFIG_DIR=/etc/letsencrypt
RENEW_EVERY_SECONDS="${ACME_RENEW_INTERVAL_SECONDS:-43200}" # twice a day

# Let's Encrypt's production rate limits are per registered domain per week
# and are not forgiving: five failures locks the name out for an hour, and
# fifty certificates a week is the ceiling. Staging exists so a deployment
# being debugged does not burn that allowance.
STAGING_FLAG=""
case "${ACME_STAGING:-false}" in
    true | TRUE | 1 | yes | YES)
        STAGING_FLAG="--staging"
        echo "acme: using Let's Encrypt STAGING -- certificates will NOT be trusted by browsers"
        ;;
esac

# A different CA entirely: a private ACME server, ZeroSSL, or a local Pebble
# when this stack is being tested without a public domain. Overrides staging.
if [ -n "${ACME_SERVER:-}" ]; then
    STAGING_FLAG="--server ${ACME_SERVER}"
    echo "acme: using the ACME server at ${ACME_SERVER}"
fi

# certbot writes live/ and archive/ as drwx------ root, and the private key as
# -rw------- root. nginx reads the key as root at config load, so it never
# noticed; coturn runs as uid 10001 and could not even traverse the directory,
# which it reported as "no readable TLS certificate ... present: (nothing)".
#
# The dev certificate generator solves the same problem with chmod 644 and
# says in as many words that that is not a pattern to carry over to real keys.
# It is not carried over: the directories become traversable and the chain
# world-readable, but the private key is opened only to coturn's group.
# Nothing else that mounts ./certs runs as that id.
COTURN_GID="${COTURN_GID:-10001}"

grant_read() {
    name="$1"
    chmod 0755 "${CONFIG_DIR}/live" "${CONFIG_DIR}/archive" 2>/dev/null || true
    chmod 0755 "${CONFIG_DIR}/live/${name}" "${CONFIG_DIR}/archive/${name}" 2>/dev/null || true
    # chmod follows the symlinks in live/ into archive/, which is what is
    # wanted: the mode that matters is the real file's.
    chmod 0644 "${CONFIG_DIR}/live/${name}/fullchain.pem" \
        "${CONFIG_DIR}/live/${name}/chain.pem" \
        "${CONFIG_DIR}/live/${name}/cert.pem" 2>/dev/null || true
    chgrp "${COTURN_GID}" "${CONFIG_DIR}/live/${name}/privkey.pem" 2>/dev/null || true
    chmod 0640 "${CONFIG_DIR}/live/${name}/privkey.pem" 2>/dev/null || true
}

issue() {
    name="$1"
    if [ -s "${CONFIG_DIR}/live/${name}/fullchain.pem" ]; then
        # Re-applied every time, not only after issuance: a renewal writes a
        # new archive/<name>/privkeyN.pem with certbot's own restrictive mode
        # and repoints the symlink, so without this TURN quietly stops working
        # weeks later, when the certificate renews.
        grant_read "$name"
        return 0
    fi
    echo "acme: requesting a certificate for ${name}"
    certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --email "${ACME_EMAIL}" \
        --cert-name "${name}" \
        -d "${name}" \
        --key-type ecdsa \
        ${STAGING_FLAG}
    grant_read "$name"
}

# A failure here must not wedge the container: nginx waits on the healthcheck
# below, and the loop will try again. Exiting would take the stack down for a
# transient DNS or rate-limit problem.
issue "${PUBLIC_HOSTNAME}" || echo "acme: could not obtain a certificate for ${PUBLIC_HOSTNAME}; will retry" >&2
issue "${TURN_HOSTNAME}" || echo "acme: could not obtain a certificate for ${TURN_HOSTNAME}; will retry" >&2

echo "acme: entering the renewal loop (every ${RENEW_EVERY_SECONDS}s)"
while true; do
    sleep "${RENEW_EVERY_SECONDS}"
    # Both the retry for anything that failed above and the actual renewal.
    issue "${PUBLIC_HOSTNAME}" || true
    issue "${TURN_HOSTNAME}" || true
    # certbot only acts inside the renewal window, so running this often is
    # cheap and means a near-expiry certificate is never missed by a day.
    certbot renew --standalone --non-interactive ${STAGING_FLAG} || \
        echo "acme: renewal attempt failed; will try again" >&2
done
