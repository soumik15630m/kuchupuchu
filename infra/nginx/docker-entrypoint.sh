#!/bin/sh
set -eu

# The stock nginx image only auto-envsubsts conf.d/*.conf, not the top-level
# nginx.conf (which is where our stream{} SNI-demux block lives) — so we do
# both explicitly here rather than relying on the built-in templating.
envsubst '${PUBLIC_HOSTNAME} ${TURN_HOSTNAME}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
envsubst '${PUBLIC_HOSTNAME}' < /etc/nginx/conf.d/app.conf.template > /etc/nginx/conf.d/app.conf

exec nginx -g 'daemon off;'
