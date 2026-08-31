#!/bin/sh
set -eu

: "${LIVEKIT_USE_EXTERNAL_IP:=true}"
export LIVEKIT_USE_EXTERNAL_IP

envsubst '${LIVEKIT_API_KEY} ${LIVEKIT_API_SECRET} ${LIVEKIT_USE_EXTERNAL_IP}' \
    < /etc/livekit/livekit.yaml.template > /etc/livekit/livekit.yaml

exec /livekit-server --config /etc/livekit/livekit.yaml
