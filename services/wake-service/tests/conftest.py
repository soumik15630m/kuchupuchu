import os
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

# Must be set before anything imports app.main, which reads a .env otherwise.
os.environ["KUCHUPUCHU_SKIP_DOTENV"] = "1"
os.environ.setdefault("JWT_SECRET", "test-secret-that-is-definitely-long-enough-32")
os.environ.setdefault("WAKE_INTERNAL_SECRET", "internal-secret-long-enough-for-the-check-32")
os.environ.setdefault("WAKE_VAPID_SUBJECT", "mailto:ops@example.com")

import jwt
from fastapi.testclient import TestClient

from app.vapid import generate_keypair

# One keypair for the whole session: generating a P-256 key per test is pure
# cost, and no test depends on the value.
_PRIVATE, _PUBLIC = generate_keypair()
os.environ.setdefault("WAKE_VAPID_PRIVATE_KEY", _PRIVATE)
os.environ.setdefault("WAKE_VAPID_PUBLIC_KEY", _PUBLIC)


def _build_auth_db(path) -> None:
    """A stand-in for auth-service's schema, narrowed to the table this
    service reads. Built here rather than imported so the suite doesn't depend
    on auth-service being importable from this package."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE allowlist (email TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0);
        CREATE TABLE devices (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            platform TEXT NOT NULL DEFAULT 'web',
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        """
    )
    conn.commit()
    conn.close()


@pytest.fixture
def env(tmp_path, monkeypatch):
    wake_db = tmp_path / "wake.sqlite"
    auth_db = tmp_path / "auth.sqlite"
    _build_auth_db(auth_db)

    monkeypatch.setenv("WAKE_DB_PATH", str(wake_db))
    monkeypatch.setenv("AUTH_DB_PATH", str(auth_db))

    # Connections are cached per thread; a new temp path per test has to clear
    # them or every test after the first reads the first test's db.
    from app import db as db_module

    db_module._local = type(db_module._local)()
    db_module._auth_local = type(db_module._auth_local)()

    yield {"auth_db": auth_db, "wake_db": wake_db, "tmp": tmp_path}

    db_module._local = type(db_module._local)()
    db_module._auth_local = type(db_module._auth_local)()


@pytest.fixture
def client(env):
    from app.main import app

    with TestClient(app) as c:
        yield c


def add_member(env, email: str, *device_ids: str, status: str = "active") -> None:
    conn = sqlite3.connect(env["auth_db"])
    conn.execute("INSERT OR IGNORE INTO allowlist (email) VALUES (?)", (email,))
    for device_id in device_ids:
        conn.execute(
            "INSERT OR REPLACE INTO devices (id, email, status) VALUES (?, ?, ?)",
            (device_id, email, status),
        )
    conn.commit()
    conn.close()


def revoke(env, device_id: str) -> None:
    conn = sqlite3.connect(env["auth_db"])
    conn.execute("UPDATE devices SET status = 'revoked' WHERE id = ?", (device_id,))
    conn.commit()
    conn.close()


def token_for(email: str, device_id: str, *, ttl_minutes: int = 15) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": email,
            "did": device_id,
            "type": "access",
            "iat": now,
            "exp": now + timedelta(minutes=ttl_minutes),
        },
        os.environ["JWT_SECRET"],
        algorithm="HS256",
    )


def auth(email: str, device_id: str) -> dict:
    return {"Authorization": f"Bearer {token_for(email, device_id)}"}


def internal() -> dict:
    return {"X-Wake-Secret": os.environ["WAKE_INTERNAL_SECRET"]}


AUTH_SECRET = b"0123456789abcdef"


def keyed_subscription(endpoint: str = "https://fcm.googleapis.com/fcm/send/abc123"):
    """A subscription shaped exactly like `PushSubscription.toJSON()` produces,
    plus the private key the browser would keep. Returned together so a test
    can decrypt what the service posted and prove the browser could read it."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    from app.vapid import b64url_encode

    key = ec.generate_private_key(ec.SECP256R1())
    p256dh = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    body = {
        "endpoint": endpoint,
        "p256dh": b64url_encode(p256dh),
        "auth": b64url_encode(AUTH_SECRET),
    }
    return body, key


def fake_subscription(endpoint: str = "https://fcm.googleapis.com/fcm/send/abc123") -> dict:
    return keyed_subscription(endpoint)[0]
