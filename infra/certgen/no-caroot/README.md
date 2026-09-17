# Placeholder — not a CA directory

This exists only so `docker-compose.yml`'s `/caroot` bind has a valid
source when `MKCERT_CAROOT` is unset. Docker resolves a bind's source
before any container runs, so pointing at a non-existent path would fail
the whole `up` with a mount error instead of the actionable message
`infra/certgen/generate-certs.sh` prints when it finds no CA here.

To make cert-init work, set `MKCERT_CAROOT` in `.env` to the output of:

    mkcert -CAROOT
