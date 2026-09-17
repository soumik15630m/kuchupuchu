"""Shared test fixtures for auth-service.

Uses a throwaway on-disk SQLite file per test so tests never touch
/data/app.db, and don't need Docker or Redis running.

Deliberately a temp FILE rather than ":memory:". app.db hands out one
connection per thread (see its module docstring on why a single shared
connection made `BEGIN IMMEDIATE` meaningless), and an ":memory:"
database belongs to exactly one connection -- so the moment a test hit an
endpoint, FastAPI's threadpool worker would open a *second*, empty
in-memory DB with no schema in it. A file is also what production
actually runs against, so this exercises the real locking behaviour
rather than a mode the service never uses.
"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

# Never read a .env during tests. See app/main.py: a suite whose results
# depend on whether a .env happens to exist on disk is not a suite.
os.environ["KUCHUPUCHU_SKIP_DOTENV"] = "1"

os.environ.setdefault("SQLITE_PATH", str(Path(tempfile.mkdtemp()) / "test-app.db"))
os.environ.setdefault("LIVEKIT_API_KEY", "test-key")
os.environ.setdefault("LIVEKIT_URL", "wss://test.invalid")
os.environ.setdefault("WEB_CLIENT_ORIGIN", "https://app.test.invalid")
# Required by mint_turn_credentials. Previously set only by
# test_media_credentials' autouse fixture, and monkeypatch.setenv DELETES
# a variable on teardown when it didn't exist before -- so with
# pytest-randomly that module intermittently broke whoever ran next.
os.environ.setdefault("TURN_HOSTNAME", "turn.test.invalid")
os.environ.setdefault("TURN_REALM", "turn.test.invalid")
# No default any more -- mailer.validate_transport refuses to start
# without an explicit choice. See finding #3 in the audit.
os.environ.setdefault("OTP_TRANSPORT", "console")

# Three distinct values, each >= MIN_SECRET_LENGTH, so the suite runs
# against the same validate_secrets() gate production does rather than
# around it.
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-not-for-prod-0123456789abcdef")
os.environ.setdefault("LIVEKIT_API_SECRET", "test-livekit-secret-not-for-prod-0123456789abcdef")
os.environ.setdefault("TURN_SHARED_SECRET", "test-turn-secret-not-for-prod-0123456789abcdef")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

import app.db as db_module
from app.migrate import run_migrations
from app.session_tokens import sign_access_token


@pytest.fixture()
def fresh_db(tmp_path, monkeypatch):
    """A brand new DB file + fresh schema for each test.

    Invalidates every connection app.db has handed out (across all
    threads, including FastAPI threadpool workers that may outlive a
    single test) before pointing SQLITE_PATH at a new file, so nothing
    carries a handle to the previous test's database. Also resets the
    rate-limiter state, which is process-global and otherwise leaks
    across cases.
    """
    # Order matters: SQLITE_PATH must change BEFORE connections are
    # invalidated. Reversed, a live thread calling get_db() in the window
    # between opens a fresh connection -- current generation, so it looks
    # right -- against the previous test's database file.
    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "test-app.db"))
    db_module.reset_connections()
    run_migrations()
    from app.routers.quality import _reset_rate_limiter_state

    _reset_rate_limiter_state()
    yield db_module.get_db()
    db_module.reset_connections()


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
