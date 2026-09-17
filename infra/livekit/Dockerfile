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
FROM livekit/livekit-server:v1.13.3@sha256:483b8b7b5b0654f91f1e8bdc7b46fcd37fd9911612ecf627f97e3185a89825bd AS livekit-src
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
# ca-certificates: the scratch-ish alpine base ships no trust store, so
# any outbound TLS from livekit-server (a TURN/STUN service over TLS, a
# webhook endpoint, an egress target) fails with an opaque
# x509-unknown-authority error rather than anything that points at the
# missing root bundle. Nothing in the current config makes such a call,
# which is exactly why this would be diagnosed from scratch the first
# time something does.
RUN apk add --no-cache gettext libc6-compat ca-certificates \
    && adduser -D -u 10001 livekit
COPY --from=livekit-src /livekit-server /livekit-server
COPY livekit.yaml.template /etc/livekit/livekit.yaml.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh \
    && chown livekit /etc/livekit
USER livekit
ENTRYPOINT ["/docker-entrypoint.sh"]
