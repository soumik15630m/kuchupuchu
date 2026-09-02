FROM livekit/livekit-server:v1.7 AS livekit-src
FROM alpine:3.20
RUN apk add --no-cache gettext libc6-compat \
    && adduser -D -u 10001 livekit
COPY --from=livekit-src /livekit-server /livekit-server
COPY livekit.yaml.template /etc/livekit/livekit.yaml.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh \
    && chown livekit /etc/livekit
USER livekit
ENTRYPOINT ["/docker-entrypoint.sh"]
