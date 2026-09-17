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

# nginx's own error names a path inside the container, which doesn't
# obviously map back to ./certs or to the hostname it came from.
cert_dir="/etc/letsencrypt/live/${PUBLIC_HOSTNAME}"
if [ ! -r "${cert_dir}/fullchain.pem" ] || [ ! -r "${cert_dir}/privkey.pem" ]; then
    echo "nginx: no readable TLS certificate for PUBLIC_HOSTNAME=${PUBLIC_HOSTNAME}" >&2
    echo "  expected: ./certs/live/${PUBLIC_HOSTNAME}/{fullchain.pem,privkey.pem} on the host" >&2
    echo "  present:  $(ls /etc/letsencrypt/live 2>/dev/null | tr '\n' ' ' || echo '(no ./certs directory at all)')" >&2
    echo "" >&2
    echo "  Generate them with:  ./scripts/dev-mkcert-cert.sh" >&2
    echo "  (or ./scripts/dev-selfsigned-cert.sh if you don't have mkcert)" >&2
    echo "  Both read PUBLIC_HOSTNAME/TURN_HOSTNAME from .env, so change those first." >&2
    exit 1
fi

exec nginx -g 'daemon off;'
