#!/bin/sh
set -eu

envsubst '${TURN_HOSTNAME} ${TURN_REALM} ${TURN_SHARED_SECRET}' \
    < /etc/coturn/turnserver.conf.template > /etc/coturn/turnserver.conf

# The placeholder swaps below match whole lines, and a CRLF template
# makes every one of them silently no-op. (relay-ip uses a substring
# match, so it survives a CR and masked this.)
sed -i 's/\r$//' /etc/coturn/turnserver.conf

# Auto-detected; TURN_RELAY_IP overrides when the detected interface
# is the wrong one.
: "${TURN_RELAY_IP:=}"
if [ -z "$TURN_RELAY_IP" ]; then
    # Global scope excludes loopback and link-local, which are exactly
    # the addresses that must not be used here.
    TURN_RELAY_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1 {print $4}' | cut -d/ -f1)"
fi
if [ -z "$TURN_RELAY_IP" ]; then
    echo "coturn: could not determine a routable IPv4 for relay-ip; set TURN_RELAY_IP explicitly." >&2
    echo "        Without it coturn allocates relays on whichever interface the client" >&2
    echo "        arrived on -- loopback, behind nginx's demux -- and relays nothing." >&2
    exit 1
fi
echo "coturn: relaying media on ${TURN_RELAY_IP}"
sed -i "s|{{TURN_RELAY_IP}}|relay-ip=${TURN_RELAY_IP}|" /etc/coturn/turnserver.conf

# Unset is correct when there is no translation between coturn and
# its clients.
: "${TURN_EXTERNAL_IP:=}"
if [ -n "$TURN_EXTERNAL_IP" ]; then
    echo "coturn: advertising relay as ${TURN_EXTERNAL_IP} (bound on ${TURN_RELAY_IP})"
    sed -i "s|{{TURN_EXTERNAL_IP}}|external-ip=${TURN_EXTERNAL_IP}/${TURN_RELAY_IP}|" /etc/coturn/turnserver.conf
else
    sed -i '/{{TURN_EXTERNAL_IP}}/d' /etc/coturn/turnserver.conf
fi

# A placeholder swap, not an envsubst var: it expands to a variable
# number of lines, and to nothing when unset. An empty envsubst would
# leave a bare `allowed-peer-ip=`, which coturn rejects.
: "${TURN_ALLOWED_PEER_IPS:=}"
if [ -n "$TURN_ALLOWED_PEER_IPS" ]; then
    allow_lines="$(printf '%s' "$TURN_ALLOWED_PEER_IPS" \
        | tr ',' '\n' \
        | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; /^$/d; s/^/allowed-peer-ip=/')"
    echo "coturn: WARNING — allowing relay to ${TURN_ALLOWED_PEER_IPS} despite denied-peer-ip. Testing only." >&2
    awk -v repl="$allow_lines" '{ if ($0 == "{{TURN_ALLOWED_PEER_IPS}}") print repl; else print }' \
        /etc/coturn/turnserver.conf > /etc/coturn/turnserver.conf.tmp
    mv /etc/coturn/turnserver.conf.tmp /etc/coturn/turnserver.conf
else
    sed -i '/{{TURN_ALLOWED_PEER_IPS}}/d' /etc/coturn/turnserver.conf
fi

# Simulates a network that blocks raw UDP to the relay, without
# touching the client: the ICE list still advertises both transports,
# so falling back to TLS stays ICE's decision. Client listener only --
# the relay still speaks UDP to the SFU.
: "${TURN_DISABLE_UDP:=}"
case "$TURN_DISABLE_UDP" in
    true|TRUE|1|yes|YES)
        echo "coturn: UDP client listener DISABLED -- TURN/TLS on 443 is the only path in (test lever)" >&2
        printf '\n# Injected by TURN_DISABLE_UDP -- see docker-entrypoint.sh\nno-udp\n' >> /etc/coturn/turnserver.conf
        ;;
esac

# Readability, not just existence: this runs as uid 10001, and a
# bind-mounted 0600 key owned by the operator is present but
# unreadable. Docker Desktop fakes permissions, so this only bites on
# a real Linux host.
cert_dir="/etc/letsencrypt/live/${TURN_HOSTNAME}"
if [ ! -r "${cert_dir}/fullchain.pem" ] || [ ! -r "${cert_dir}/privkey.pem" ]; then
    echo "coturn: no readable TLS certificate for TURN_HOSTNAME=${TURN_HOSTNAME}" >&2
    echo "  expected: ./certs/live/${TURN_HOSTNAME}/{fullchain.pem,privkey.pem} on the host," >&2
    echo "            readable by uid $(id -u)" >&2
    echo "  present:  $(ls /etc/letsencrypt/live 2>/dev/null | tr '\n' ' ' || echo '(no ./certs directory at all)')" >&2
    echo "" >&2
    echo "  Generate them with:  ./scripts/dev-mkcert-cert.sh" >&2
    echo "  TURN_HOSTNAME must be a DIFFERENT hostname from PUBLIC_HOSTNAME (§7.1)." >&2
    exit 1
fi

exec turnserver -c /etc/coturn/turnserver.conf
