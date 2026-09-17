# Signs local dev TLS certificates at `docker compose up`, so the stack
# comes up with certificates matching whatever PUBLIC_HOSTNAME /
# TURN_HOSTNAME currently are, without a manual step.
#
# Uses mkcert rather than plain openssl for one reason: the certificates
# have to be signed by the SAME local CA that is already installed in the
# host's trust store, or nothing trusts them and the whole point of the
# mkcert path (browsers, curl and `lk` working without -k) is lost. That
# CA lives on the host and is mounted in at /caroot -- see
# generate-certs.sh.
#
# Digest-pinned base, checksum-pinned binary: consistent with the rest of
# this repo (pip hash-locking, SRI on the harness's CDN scripts). The
# mkcert release has no published checksum file, so these are the hashes
# of what the official GitHub release URL served, recorded here so a
# future build that gets different bytes fails loudly.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

# Provided automatically by BuildKit (Docker Desktop's default builder).
# Defaults to amd64 for the legacy builder, which only runs on amd64.
ARG TARGETARCH=amd64

ARG MKCERT_VERSION=v1.4.4
ARG MKCERT_SHA256_AMD64=6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52
ARG MKCERT_SHA256_ARM64=b98f2cc69fd9147fe4d405d859c57504571adec0d3611c3eefd04107c7ac00d0

RUN apk add --no-cache ca-certificates curl openssl \
    && case "$TARGETARCH" in \
         amd64) sum="$MKCERT_SHA256_AMD64" ;; \
         arm64) sum="$MKCERT_SHA256_ARM64" ;; \
         *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/mkcert \
         "https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-${TARGETARCH}" \
    && echo "${sum}  /usr/local/bin/mkcert" | sha256sum -c - \
    && chmod +x /usr/local/bin/mkcert \
    && apk del curl

COPY generate-certs.sh /generate-certs.sh
RUN chmod +x /generate-certs.sh

# Runs as root deliberately, unlike every other container here: it writes
# into a bind-mounted ./certs whose ownership on a Linux host belongs to
# the operator, and it chmods the results so the unprivileged nginx/coturn
# uids can read them. It runs for a fraction of a second and exits.
ENTRYPOINT ["/generate-certs.sh"]
