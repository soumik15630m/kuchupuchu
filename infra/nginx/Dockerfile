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
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
RUN apk add --no-cache gettext # envsubst
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY conf.d/app.conf.template /etc/nginx/conf.d/app.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
