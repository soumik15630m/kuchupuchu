#!/bin/sh
set -eu

# Defaults to coturn's actual address (same netns as this container — see
# docker-compose.yml). docker-compose.testing.yml overrides this to
# "toxiproxy" to route TURN/TLS traffic through scripted fault injection
# (scripts/toxiproxy-scenarios.sh) without any change needed here.
: "${TURN_BACKEND_HOST:=127.0.0.1}"
export TURN_BACKEND_HOST

# The stock nginx image only auto-envsubsts conf.d/*.conf, not the top-level
# nginx.conf (which is where our stream{} SNI-demux block lives) — so we do
# both explicitly here rather than relying on the built-in templating.
envsubst '${PUBLIC_HOSTNAME} ${TURN_HOSTNAME} ${TURN_BACKEND_HOST}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
envsubst '${PUBLIC_HOSTNAME}' < /etc/nginx/conf.d/app.conf.template > /etc/nginx/conf.d/app.conf

exec nginx -g 'daemon off;'
