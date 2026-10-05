# Pinned by digest, not just tag -- a tag is mutable and can be repointed at
# different bytes at any time. Matches the other images in this stack.
#
# To bump: change the tag, then re-resolve the digest with
#   docker buildx imagetools inspect <image>:<tag> --format '{{.Manifest.Digest}}'
FROM certbot/certbot:v5.8.0@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# certbot's own image sets an ENTRYPOINT of `certbot`; this replaces it, so the
# container is a renewal loop rather than a single invocation.
ENTRYPOINT ["/docker-entrypoint.sh"]
