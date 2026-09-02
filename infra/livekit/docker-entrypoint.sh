#!/bin/sh
set -eu

: "${LIVEKIT_USE_EXTERNAL_IP:=true}"
: "${LIVEKIT_NODE_IP:=}"
export LIVEKIT_USE_EXTERNAL_IP

envsubst '${LIVEKIT_API_KEY} ${LIVEKIT_API_SECRET} ${LIVEKIT_USE_EXTERNAL_IP} ${REDIS_PASSWORD}' \
    < /etc/livekit/livekit.yaml.template > /etc/livekit/livekit.yaml

# node_ip is only valid when it's a real IP -- an empty or malformed value
# would break LiveKit outright, unlike use_external_ip's plain true/false.
# So this is a template-placeholder swap, not a normal envsubst variable:
# inject a real node_ip line when set, or drop the placeholder entirely
# when not (leaving LiveKit's default STUN/internal-IP behavior untouched).
if [ -n "$LIVEKIT_NODE_IP" ]; then
    sed -i "s|{{LIVEKIT_NODE_IP_LINE}}|  node_ip: \"${LIVEKIT_NODE_IP}\"|" /etc/livekit/livekit.yaml
else
    sed -i "/{{LIVEKIT_NODE_IP_LINE}}/d" /etc/livekit/livekit.yaml
fi

exec /livekit-server --config /etc/livekit/livekit.yaml
