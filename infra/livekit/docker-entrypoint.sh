#!/bin/sh
set -eu

envsubst '${LIVEKIT_API_KEY} ${LIVEKIT_API_SECRET}' \
    < /etc/livekit/livekit.yaml.template > /etc/livekit/livekit.yaml

exec /livekit-server --config /etc/livekit/livekit.yaml
