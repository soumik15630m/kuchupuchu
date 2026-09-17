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
        # Reachability is checked separately from creation. Collapsing
        # both into one "(already exists, or toxiproxy isn't reachable)"
        # message meant a stack that wasn't running at all looked
        # identical to a proxy that was already set up -- so every later
        # scenario would quietly do nothing, and the call under test
        # would look like it had survived a cut that never happened.
        if ! curl -sf -o /dev/null "${TOXIPROXY_URL}/proxies"; then
            echo "toxiproxy is not reachable at ${TOXIPROXY_URL}." >&2
            echo "Start it with: docker compose -f docker-compose.yml -f docker-compose.testing.yml up -d" >&2
            exit 1
        fi
        if curl -sf -o /dev/null "${TOXIPROXY_URL}/proxies/${PROXY_NAME}"; then
            echo "Proxy '${PROXY_NAME}' already exists — nothing to do."
            exit 0
        fi
        echo "Creating toxiproxy proxy '${PROXY_NAME}' -> ${UPSTREAM}..."
        curl -sf -X POST "${TOXIPROXY_URL}/proxies" \
            -H 'Content-Type: application/json' \
            -d "{\"name\":\"${PROXY_NAME}\",\"listen\":\"${LISTEN}\",\"upstream\":\"${UPSTREAM}\"}" > /dev/null
        echo "Created."
        ;;

    cut)
        SECONDS_DOWN="${2:-5}"
        echo "Cutting TURN/TLS path for ${SECONDS_DOWN}s..."
        curl -sf -X POST "${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics" \
            -H 'Content-Type: application/json' \
            -d '{"name":"hard-cut","type":"timeout","stream":"downstream","attributes":{"timeout":0}}' > /dev/null
        # Ctrl-C during the sleep below used to leave the TURN/TLS path
        # cut indefinitely, with nothing on screen saying so -- every
        # subsequent test would then be running against a severed relay
        # path and blaming it on something else.
        restore_cut() {
            curl -sf -X DELETE "${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics/hard-cut" > /dev/null 2>&1 || true
        }
        trap 'echo; echo "Interrupted — removing the cut."; restore_cut; exit 130' INT TERM
        sleep "$SECONDS_DOWN"
        trap - INT TERM
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
        toxics_json="$(curl -sf "${TOXIPROXY_URL}/proxies/${PROXY_NAME}/toxics")"
        # `tr -d '\r'` is load-bearing on Windows. Python writes text in
        # text mode, so on Git Bash/MSYS every name comes back with a
        # trailing CR that `read -r` faithfully preserves -- and the CR
        # then ends up inside the DELETE URL:
        #     curl -sf -X DELETE '.../toxics/added-latency\r'
        # curl rejects that as a malformed URL (exit 3), which under
        # `set -e` aborted the whole command. The net effect was that
        # `restore` never removed anything on Windows while looking like
        # it had started to: the toxic stayed applied, silently degrading
        # every subsequent test on that path.
        echo "$toxics_json" | python3 -c '
import json, sys
names = [t["name"] for t in json.load(sys.stdin)]
print("\n".join(names))
' | tr -d '\r' | while read -r toxic; do
            [ -z "$toxic" ] && continue
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
