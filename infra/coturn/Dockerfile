# Pinned by digest, not just tag: a tag is mutable and can be repointed at
# different bytes at any time. The rest of this stack already refuses to
# trust mutable references -- pip deps are hash-locked
# (requirements.txt), and the harness SRI-pins both the LiveKit UMD build
# and its E2EE worker -- so leaving the base images on bare tags was the
# one unpinned link left in the supply chain. The tag is kept alongside
# the digest purely so a human can see what version this is.
#
# To bump: change the tag, then re-resolve the digest with
#   docker buildx imagetools inspect <image>:<tag> --format '{{.Manifest.Digest}}'
FROM coturn/coturn:4.6.2-alpine@sha256:74d898c492f9d9083b9c7e65be0eba6a73e3b05b1c2589edd9d1962c60d31039
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
