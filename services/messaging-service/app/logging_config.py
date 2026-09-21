"""Structured (JSON, one object per line) logging for the whole process.

Plain `logger.info("x=%s", x)` calls scattered across the app were fine at
console-log-and-eyeball scale, but aren't queryable once this runs anywhere
with a log aggregator (or even just `journalctl | grep`). Every record gets
the same shape below instead -- callers keep writing normal `logger.info`
calls, this just controls how they're rendered.
"""
from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone


# Structured `extra=` fields are written to the log verbatim, so a key
# that happens to carry a credential ends up in whatever collects these.
# Redacting by key name is a backstop, not a licence to log secrets: the
# right fix is never passing them. It exists because the cost of being
# wrong here is a durable, replicated copy of the value.
_REDACTED_KEY_SUBSTRINGS = ("secret", "password", "token", "code_hash", "otp", "authorization", "api_key")
REDACTED = "[redacted]"


def _should_redact(key: str) -> bool:
    lowered = key.lower()
    return any(marker in lowered for marker in _REDACTED_KEY_SUBSTRINGS)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        # Anything passed via `logger.info(..., extra={...})` rides along
        # as its own top-level key rather than getting swallowed.
        for key, value in record.__dict__.items():
            if key in _RESERVED_LOG_RECORD_ATTRS or key in payload:
                continue
            payload[key] = REDACTED if _should_redact(key) else value
        return json.dumps(payload, default=str)


_RESERVED_LOG_RECORD_ATTRS = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys())


def configure_logging() -> None:
    """Called once, at process start, before any other module has a
    chance to call getLogger and log something under the default config.
    Idempotent -- safe if the test suite imports app.main more than once."""
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)

    # uvicorn's own loggers otherwise use their own colored-console
    # formatter regardless of the root handler above.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(name)
        uv_logger.handlers.clear()
        uv_logger.propagate = True
