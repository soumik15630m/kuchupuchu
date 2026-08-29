#!/bin/bash
# network-emulation.sh — Phase 3 (§13) testing aid.
#
# Simulates the Russia-side link characteristics on ONE peer's traffic only,
# without touching either laptop's OS. Runs on the machine hosting the
# docker-compose stack, shaping traffic to/from a single client IP on the
# LAN interface. The other laptop's traffic is untouched, so you get a real
# asymmetric link instead of degrading both sides equally.
#
# Two independent things it can do:
#   1. tc (htb + netem), filtered by destination IP — added delay/jitter/loss
#      on the path to that one client.
#   2. iptables DROP on outbound UDP to that client's LiveKit media port
#      range (20000-20100) — simulates Russian DPI blocking raw UDP, which is
#      exactly what forces ICE onto the TURN/TLS-443 fallback path (§1, v5
#      fix). Leaves TCP/443 (and thus TURN/TLS) untouched, so the fallback
#      itself can be exercised rather than the whole call dying.
#
# Requires root (tc + iptables). Linux only.
#
# Usage:
#   sudo ./network-emulation.sh <iface> <client-ip> [options]
#   sudo ./network-emulation.sh <iface> <client-ip> --clear
#
# Options:
#   --delay MS        base one-way delay added to traffic toward client-ip (default: 100ms)
#   --jitter MS        delay variation (default: 20ms)
#   --loss PCT         packet loss percentage, e.g. 3 for 3% (default: 2)
#   --block-udp         also drop outbound UDP to the LiveKit media port range
#   --media-ports RANGE  UDP port range to block, must match infra/livekit's
#                        published range in docker-compose.yml (default: 20000-20100)
#   --clear              remove all rules previously added by this script for
#                        this iface + client-ip pair and exit
#
# Example — simulate the "Russia" laptop at 192.168.1.42, forcing it onto
# TURN/TLS by blocking raw UDP, plus a lossy 120ms link:
#   sudo ./network-emulation.sh eth0 192.168.1.42 --delay 120 --jitter 30 --loss 4 --block-udp
#
# Tear down when done:
#   sudo ./network-emulation.sh eth0 192.168.1.42 --clear

set -euo pipefail

DELAY_MS=100
JITTER_MS=20
LOSS_PCT=2
BLOCK_UDP=0
MEDIA_PORTS="20000-20100"
CLEAR=0

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <iface> <client-ip> [options]  (see header comment for options)" >&2
    exit 1
fi

IFACE="$1"
CLIENT_IP="$2"
shift 2

while [ "$#" -gt 0 ]; do
    case "$1" in
        --delay) DELAY_MS="$2"; shift 2 ;;
        --jitter) JITTER_MS="$2"; shift 2 ;;
        --loss) LOSS_PCT="$2"; shift 2 ;;
        --block-udp) BLOCK_UDP=1; shift ;;
        --media-ports) MEDIA_PORTS="$2"; shift 2 ;;
        --clear) CLEAR=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "Must run as root (tc + iptables need it)." >&2
    exit 1
fi

# A stable, short handle derived from the IP so multiple client-ip targets on
# the same iface can each get their own class/filter without colliding.
CLASS_ID="1:$(( (10#$(echo "$CLIENT_IP" | awk -F. '{print $4}')) + 100 ))"
COMMENT="netem-sim-${CLIENT_IP}"

clear_rules() {
    echo "Clearing emulation rules for ${CLIENT_IP} on ${IFACE}..."
    tc class del dev "$IFACE" classid "$CLASS_ID" 2>/dev/null || true
    tc qdisc del dev "$IFACE" parent "$CLASS_ID" 2>/dev/null || true
    tc filter del dev "$IFACE" parent 1: protocol ip prio 1 \
        u32 match ip dst "$CLIENT_IP" flowid "$CLASS_ID" 2>/dev/null || true
    # If this was the last class under the root htb, tear the root down too.
    if ! tc class show dev "$IFACE" 2>/dev/null | grep -q "parent 1:"; then
        tc qdisc del dev "$IFACE" root 2>/dev/null || true
    fi
    while iptables -D OUTPUT -d "$CLIENT_IP" -p udp \
        --dport "$MEDIA_PORTS" -m comment --comment "$COMMENT" -j DROP 2>/dev/null; do :; done
    echo "Done."
}

if [ "$CLEAR" -eq 1 ]; then
    clear_rules
    exit 0
fi

echo "Setting up asymmetric emulation for ${CLIENT_IP} on ${IFACE}:"
echo "  delay=${DELAY_MS}ms jitter=${JITTER_MS}ms loss=${LOSS_PCT}%"
[ "$BLOCK_UDP" -eq 1 ] && echo "  blocking outbound UDP to ports ${MEDIA_PORTS} (forces TURN/TLS-443 fallback)"

# Root qdisc: htb so we can carve out a class for just this one destination
# IP and leave everything else on the interface alone.
tc qdisc show dev "$IFACE" root 2>/dev/null | grep -q htb || \
    tc qdisc add dev "$IFACE" root handle 1: htb default 999

tc class add dev "$IFACE" parent 1: classid "$CLASS_ID" htb rate 1000mbit 2>/dev/null || \
    tc class change dev "$IFACE" parent 1: classid "$CLASS_ID" htb rate 1000mbit

tc qdisc add dev "$IFACE" parent "$CLASS_ID" handle "${CLASS_ID#1:}0:" netem \
    delay "${DELAY_MS}ms" "${JITTER_MS}ms" distribution normal \
    loss "${LOSS_PCT}%" 2>/dev/null || \
    tc qdisc change dev "$IFACE" parent "$CLASS_ID" handle "${CLASS_ID#1:}0:" netem \
    delay "${DELAY_MS}ms" "${JITTER_MS}ms" distribution normal \
    loss "${LOSS_PCT}%"

tc filter add dev "$IFACE" parent 1: protocol ip prio 1 \
    u32 match ip dst "$CLIENT_IP" flowid "$CLASS_ID" 2>/dev/null || true

if [ "$BLOCK_UDP" -eq 1 ]; then
    iptables -C OUTPUT -d "$CLIENT_IP" -p udp --dport "$MEDIA_PORTS" \
        -m comment --comment "$COMMENT" -j DROP 2>/dev/null || \
        iptables -A OUTPUT -d "$CLIENT_IP" -p udp --dport "$MEDIA_PORTS" \
        -m comment --comment "$COMMENT" -j DROP
fi

echo "Applied. Run with --clear (same iface + client-ip) to remove."
