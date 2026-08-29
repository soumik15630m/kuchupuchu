#!/bin/bash
# toxiproxy-scenarios.sh — Phase 3 (§13) testing aid.
#
# Drives toxiproxy (started via docker-compose.testing.yml) to inject
# scripted, repeatable faults on the TURN/TLS-443 path — so ICE-restart
# recovery can be tested on demand instead of waiting for the real link to
# hiccup. Talks to toxiproxy's HTTP API (default localhost:8474).
#
# Setup must happen once per stack restart:
#   ./toxiproxy-scenarios.sh setup
#
# Then run a scenario while a call is active:
#   ./toxiproxy-scenarios.sh cut 5          # hard-cut the TURN/TLS path for 5s, then restore
#   ./toxiproxy-scenarios.sh latency 300 50 # add 300ms +/-50ms jitter, until you call `restore`
#   ./toxiproxy-scenarios.sh restore        # remove all active toxics, leave the proxy in place
#   ./toxiproxy-scenarios.sh status         # show current toxics
#   ./toxiproxy-scenarios.sh teardown       # delete the proxy entirely

set -euo pipefail

TOXIPROXY_URL="${TOXIPROXY_URL:-http://localhost:8474}"
PROXY_NAME="turn_tls"
UPSTREAM="nginx:5349"   # coturn, reached via nginx's shared network namespace
LISTEN="0.0.0.0:5349"

cmd="${1:-}"

case "$cmd" in
    setup)
        echo "Creating toxiproxy proxy '${PROXY_NAME}' -> ${UPSTREAM}..."
        curl -sf -X POST "${TOXIPROXY_URL}/proxies" \
            -H 'Content-Type: application/json' \
            -d "{\"name\":\"${PROXY_NAME}\",\"listen\":\"${LISTEN}\",\"upstream\":\"${UPSTREAM}\"}" \
            && echo "Created." \
            || echo "(already exists, or toxiproxy isn't reachable at ${TOXIPROXY_URL})"
        ;;

    cut)
        SECONDS_DOWN="${2:-5}"
        echo "Cutting TURN/TLS path for ${SECONDS_DOWN}s..."
        curl -sf -X POST "${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics" \
            -H 'Content-Type: application/json' \
            -d '{"name":"hard-cut","type":"timeout","stream":"downstream","attributes":{"timeout":0}}' > /dev/null
        sleep "$SECONDS_DOWN"
        curl -sf -X DELETE "${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics/hard-cut" > /dev/null
        echo "Restored. Check whether ICE restart recovered the call without a full drop."
        ;;

    latency)
        MS="${2:-300}"
        JITTER="${3:-50}"
        echo "Adding ${MS}ms (+/-${JITTER}ms) latency to TURN/TLS path (run 'restore' to remove)..."
        curl -sf -X POST "${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics" \
            -H 'Content-Type: application/json' \
            -d "{\"name\":\"added-latency\",\"type\":\"latency\",\"stream\":\"downstream\",\"attributes\":{\"latency\":${MS},\"jitter\":${JITTER}}}" \
            && echo "Applied."
        ;;

    restore)
        echo "Removing all active toxics on '${PROXY_NAME}'..."
        curl -sf "${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics" \
            | grep -o '"name":"[^"]*"' | cut -d'"' -f4 \
            | while read -r toxic; do
                curl -sf -X DELETE "${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics/${toxic}" > /dev/null
                echo "  removed: ${toxic}"
            done
        echo "Done."
        ;;

    status)
        curl -sf "${TOXIPROXY_URL}/proxies/${PROXY_NAME}" | python3 -m json.tool 2>/dev/null \
            || curl -sf "${TOXIPROXY_URL}/proxies/${PROXY_NAME}"
        ;;

    teardown)
        curl -sf -X DELETE "${TOXIPROXY_URL}/proxies/${PROXY_NAME}" && echo "Proxy deleted."
        ;;

    *)
        echo "Usage: $0 {setup|cut [seconds]|latency [ms] [jitter_ms]|restore|status|teardown}" >&2
        exit 1
        ;;
esac
