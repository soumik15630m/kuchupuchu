# Pinned by digest, not just tag -- a tag is mutable and can be repointed at
# different bytes at any time. Matches auth-service and messaging-service.
#
# To bump: change the tag, then re-resolve the digest with
#   docker buildx imagetools inspect <image>:<tag> --format '{{.Manifest.Digest}}'
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
WORKDIR /app
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY migrations ./migrations
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN useradd --system --no-create-home --uid 10001 appuser \
    && chown -R appuser /app \
    && mkdir -p /data && chown appuser /data \
    && chmod +x /docker-entrypoint.sh

EXPOSE 8095
# Stays root here -- the entrypoint fixes /data's ownership (volumes can
# predate appuser existing at all) and drops to appuser via gosu.
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${WAKE_PORT:-8095}"]
