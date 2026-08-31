"""Shared test fixtures for auth-service.

Uses an in-memory SQLite DB (SQLITE_PATH=":memory:") so tests never touch
/data/app.db, and don't need Docker or Redis running. Env vars are set
before app.db is imported anywhere, since get_db() reads them lazily on
first call but caches a single connection afterward -- resetting that
cache between test modules is what `_reset_db` does.
"""
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("SQLITE_PATH", ":memory:")
os.environ.setdefault("LIVEKIT_API_KEY", "test-key")
os.environ.setdefault("LIVEKIT_API_SECRET", "test-secret-not-for-prod")
os.environ.setdefault("LIVEKIT_URL", "wss://test.invalid")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

import app.db as db_module
from app.migrate import run_migrations
from app.session_tokens import sign_access_token


@pytest.fixture()
def fresh_db():
    """Forces a brand new in-memory DB + fresh schema for each test --
    important because sqlite3's ':memory:' DB is dropped whenever the
    connection closes, but our own module-level cache in app.db would
    otherwise hand back a stale/closed connection across tests. Also
    resets the quality router's rate-limiter state, which is separate
    process-global state the DB reset doesn't touch."""
    db_module._db = None
    run_migrations()
    from app.routers.quality import _reset_rate_limiter_state

    _reset_rate_limiter_state()
    yield db_module.get_db()
    db_module._db = None


@pytest.fixture()
def client(fresh_db):
    from app.main import app as fastapi_app

    with TestClient(fastapi_app) as c:
        yield c


def register_device(db, email: str, device_id: str, platform: str = "web") -> None:
    db.execute("INSERT OR IGNORE INTO allowlist (email) VALUES (?)", (email,))
    db.execute(
        "INSERT INTO devices (id, email, status, platform) VALUES (?, ?, 'active', ?)",
        (device_id, email, platform),
    )
    db.commit()


def access_token_for(email: str, device_id: str) -> str:
    return sign_access_token(email, device_id)
