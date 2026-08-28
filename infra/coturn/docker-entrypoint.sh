#!/bin/sh
set -eu

envsubst '${PUBLIC_HOSTNAME} ${TURN_REALM} ${TURN_SHARED_SECRET}' \
    < /etc/coturn/turnserver.conf.template > /etc/coturn/turnserver.conf

exec turnserver -c /etc/coturn/turnserver.conf
