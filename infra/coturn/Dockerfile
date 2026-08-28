FROM coturn/coturn:4.6.2-alpine
USER root
RUN apk add --no-cache gettext
COPY turnserver.conf.template /etc/coturn/turnserver.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
