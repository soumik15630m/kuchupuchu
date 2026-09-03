FROM coturn/coturn:4.6.2-alpine
USER root
RUN apk add --no-cache gettext \
    && adduser -D -H -u 10001 turnserver
COPY turnserver.conf.template /etc/coturn/turnserver.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh \
    && chown turnserver /etc/coturn
# Root above is only needed transiently for apk add / file setup. Neither
# TURN listener here is on a privileged port (3478, 5349), so there's no
# reason to keep running as root -- drop to the unprivileged user created
# above for the actual process (entrypoint included, since it envsubsts
# turnserver.conf.template in place at startup).
USER turnserver
ENTRYPOINT ["/docker-entrypoint.sh"]
