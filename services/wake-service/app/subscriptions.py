"""The push-subscription registry.

Deliberately thin: this service stores where to knock and nothing about what
was knocked about. There is no per-message row, no sender, no chat id and no
history of deliveries -- a wake service that kept those would reconstruct the
social graph the messaging service goes out of its way not to hold.
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.db import get_db
from app.vapid import b64url_decode

_P256DH_LENGTH = 65
_AUTH_LENGTH = 16


class InvalidSubscription(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate_keys(p256dh: str, auth: str) -> None:
    """Checked on the way in rather than at push time. A subscription stored
    with an unusable key would fail every future push with no way to tell it
    apart from a member who simply turned notifications off."""
    try:
        key = b64url_decode(p256dh)
        secret = b64url_decode(auth)
    except Exception as exc:
        raise InvalidSubscription("p256dh and auth must be base64url") from exc
    if len(key) != _P256DH_LENGTH or key[0] != 0x04:
        raise InvalidSubscription("p256dh must be a 65-byte uncompressed P-256 point")
    if len(secret) != _AUTH_LENGTH:
        raise InvalidSubscription("auth must be 16 bytes")


def put(device_id: str, email: str, endpoint: str, p256dh: str, auth: str) -> None:
    """Replaces any existing row for the device.

    A browser can hand out a new endpoint for the same device without warning
    -- after a permission reset, a profile move, or the push service rotating
    its own URLs -- and the previous one then 410s forever. Keyed by device so
    the new one simply wins.
    """
    validate_keys(p256dh, auth)
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    db.execute(
        """INSERT INTO push_subscriptions (device_id, email, endpoint, p256dh, auth, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
               email = excluded.email,
               endpoint = excluded.endpoint,
               p256dh = excluded.p256dh,
               auth = excluded.auth,
               created_at = excluded.created_at,
               last_push_at = NULL""",
        (device_id, email.lower(), endpoint, p256dh, auth, _now()),
    )
    db.commit()


def remove(device_id: str) -> bool:
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    cursor = db.execute("DELETE FROM push_subscriptions WHERE device_id = ?", (device_id,))
    db.commit()
    return cursor.rowcount > 0


def get(device_id: str) -> dict | None:
    row = get_db().execute(
        "SELECT * FROM push_subscriptions WHERE device_id = ?", (device_id,)
    ).fetchone()
    return dict(row) if row else None


def for_devices(device_ids: list[str]) -> list[dict]:
    if not device_ids:
        return []
    placeholders = ",".join("?" for _ in device_ids)
    rows = get_db().execute(
        f"SELECT * FROM push_subscriptions WHERE device_id IN ({placeholders})",
        tuple(device_ids),
    ).fetchall()
    return [dict(row) for row in rows]


def mark_pushed(device_ids: list[str]) -> None:
    if not device_ids:
        return
    placeholders = ",".join("?" for _ in device_ids)
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    db.execute(
        f"UPDATE push_subscriptions SET last_push_at = ? WHERE device_id IN ({placeholders})",
        (_now(), *device_ids),
    )
    db.commit()


def count_for_email(email: str) -> int:
    row = get_db().execute(
        "SELECT COUNT(*) AS n FROM push_subscriptions WHERE email = ?", (email.lower(),)
    ).fetchone()
    return int(row["n"])
