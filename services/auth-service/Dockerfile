FROM python:3.12-slim
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

EXPOSE 8080
# Stays root here -- entrypoint fixes /data's ownership (volumes can
# predate appuser existing at all) and drops to appuser via gosu before
# actually running anything. See docker-entrypoint.sh.
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["sh", "-c", "python -m app.migrate && exec uvicorn app.main:app --host 0.0.0.0 --port ${AUTH_PORT:-8080}"]
