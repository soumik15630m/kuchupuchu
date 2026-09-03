"""Device table, revocation, device-list version counter, and web-identity
heartbeat/auto-expiry (§4, §13 Phase 2).

Kept as one module because these all touch the same `devices` and
`device_versions` rows and mostly need to happen inside the same
transaction (e.g. "mark revoked" + "bump version" must both land or
neither should).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.db import get_db
from app.metrics import device_revocations_total

# §4: "≤2-devices-per-person model" (one Android + one web, in practice).
DEVICE_CAP_PER_PERSON = 2

# §4: a web device that's gone silent (no token-refresh heartbeat) for this
# long is auto-expired -- routine cleanup, not a trust event.
WEB_HEARTBEAT_EXPIRY_DAYS = 14


class DeviceError(Exception):
    """Base for the deliberately-distinct device errors below, so routers
    can map each to the right HTTP status instead of a blanket 400."""


class DeviceLimitReachedError(DeviceError):
    pass


class DeviceRevokedError(DeviceError):
    pass


class DeviceNotFoundError(DeviceError):
    pass


class NotDeviceOwnerError(DeviceError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def bump_device_version(db, email: str) -> int:
    """Increments (or creates) `email`'s device-list version counter.
    Caller is responsible for commit -- this is meant to be called inside
    the same transaction as the device-table change that triggered it."""
    db.execute(
        """
        INSERT INTO device_versions (email, version, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(email) DO UPDATE SET
            version = version + 1,
            updated_at = excluded.updated_at
        """,
        (email, _now_iso()),
    )
    row = db.execute(
        "SELECT version FROM device_versions WHERE email = ?", (email,)
    ).fetchone()
    return row["version"]


def get_device_version(email: str) -> int:
    db = get_db()
    row = db.execute(
        "SELECT version FROM device_versions WHERE email = ?", (email,)
    ).fetchone()
    return row["version"] if row else 0


def get_all_device_versions() -> dict[str, int]:
    """Powers the polling-based banner (no wake-service until Phase 5):
    a client hits this for every known member at once instead of one
    request per contact."""
    db = get_db()
    rows = db.execute(
        "SELECT email, version FROM device_versions"
    ).fetchall()
    versions = {row["email"]: row["version"] for row in rows}
    # Members who've never had a device-table change yet (brand new
    # allowlist entry) implicitly start at version 0.
    for row in db.execute("SELECT email FROM allowlist"):
        versions.setdefault(row["email"], 0)
    return versions


def get_device(device_id: str):
    db = get_db()
    return db.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()


def list_devices_for_email(email: str):
    db = get_db()
    return db.execute(
        "SELECT * FROM devices WHERE email = ? ORDER BY created_at", (email,)
    ).fetchall()


def is_admin_email(email: str) -> bool:
    """Backs the two admin-only endpoints in routers/devices.py. is_admin
    is granted by ADMIN_EMAILS at migration time (app/migrate.py) -- there's
    no in-app way to self-promote."""
    db = get_db()
    row = db.execute("SELECT is_admin FROM allowlist WHERE email = ?", (email,)).fetchone()
    return bool(row and row["is_admin"])


def is_device_active(device_id: str, email: str) -> bool:
    """Cheap DB status lookup used on every access-token check (§4) --
    signature+expiry alone would let a revoked device ride out the token's
    remaining lifetime."""
    row = get_device(device_id)
    return row is not None and row["email"] == email and row["status"] == "active"


def register_or_touch_device(email: str, device_id: str, platform: str) -> str:
    """Called right after a successful OTP verify (§4/§10.3: "device
    registration at login time"). Returns the resulting status ('active').
    Raises DeviceRevokedError / DeviceLimitReachedError when login should
    be refused."""
    db = get_db()
    # BEGIN IMMEDIATE closes the TOCTOU between the active-device-count
    # read below and the insert that follows -- without it, two concurrent
    # registrations for the same email can both read a count under the cap
    # before either commits.
    db.execute("BEGIN IMMEDIATE")
    try:
        existing = get_device(device_id)

        if existing is not None:
            if existing["email"] != email:
                # A device id colliding across two different emails should
                # be essentially impossible (client-generated, high-
                # entropy), but never let one email's login touch another's
                # device row.
                raise DeviceNotFoundError(device_id)

            if existing["status"] == "revoked":
                raise DeviceRevokedError(
                    "this device was revoked; log in from a different device "
                    "and generate a new device identity to reconnect"
                )

            was_expired = existing["status"] == "expired"
            db.execute(
                "UPDATE devices SET status = 'active', platform = ?, last_seen_at = ? WHERE id = ?",
                (platform, _now_iso(), device_id),
            )
            if was_expired:
                # Reactivating an expired device is an "add" from the other
                # party's point of view -- it wasn't in their trusted list a
                # moment ago -- so it's version-bump-worthy like a brand new one.
                bump_device_version(db, email)
            db.commit()
            return "active"

        active_count = db.execute(
            "SELECT COUNT(*) AS n FROM devices WHERE email = ? AND status = 'active'",
            (email,),
        ).fetchone()["n"]
        if active_count >= DEVICE_CAP_PER_PERSON:
            raise DeviceLimitReachedError(
                f"{email} already has {active_count} active devices "
                f"(limit {DEVICE_CAP_PER_PERSON}); revoke one first"
            )

        db.execute(
            """
            INSERT INTO devices (id, email, status, platform, last_seen_at, created_at)
            VALUES (?, ?, 'active', ?, ?, ?)
            """,
            (device_id, email, platform, _now_iso(), _now_iso()),
        )
        bump_device_version(db, email)
        db.commit()
        return "active"
    except Exception:
        db.rollback()
        raise


def set_refresh_jti(device_id: str, jti: str) -> None:
    """Records `jti` as the only refresh token currently valid for this
    device (§4 refresh-token rotation). Called on login and on every
    successful refresh -- routers/auth.py rejects a refresh token whose
    jti doesn't match this as reuse of an already-rotated-away token."""
    db = get_db()
    db.execute("UPDATE devices SET refresh_jti = ? WHERE id = ?", (jti, device_id))
    db.commit()


def touch_heartbeat(device_id: str) -> None:
    """Piggybacked on the 15-minute token refresh (§4) -- no separate
    endpoint/traffic. Silently no-ops for an unknown device id; the caller
    (token refresh) has already independently rejected those."""
    db = get_db()
    db.execute(
        "UPDATE devices SET last_seen_at = ? WHERE id = ?", (_now_iso(), device_id)
    )
    db.commit()


def revoke_device(device_id: str, caller_email: str, trigger: str = "self_service"):
    """Revokes a single device. `caller_email` must be the device's own
    owner -- see routers/devices.py for the one exception (admin revoke,
    which calls admin_revoke_device instead of this). Returns the device
    row as it was *before* revocation (caller needs `platform`/prior
    status for logging/LiveKit teardown). Raises DeviceNotFoundError /
    NotDeviceOwnerError."""
    db = get_db()
    row = get_device(device_id)
    if row is None:
        raise DeviceNotFoundError(device_id)
    if row["email"] != caller_email:
        raise NotDeviceOwnerError(device_id)

    if row["status"] != "revoked":
        db.execute("UPDATE devices SET status = 'revoked' WHERE id = ?", (device_id,))
        bump_device_version(db, caller_email)
        db.commit()
        device_revocations_total.labels(trigger=trigger).inc()
    return row


def admin_revoke_device(device_id: str):
    """Same effect as revoke_device, for an admin acting on someone else's
    device -- skips the ownership check entirely, since checking it is the
    whole point of self-service revoke and would defeat this one. Raises
    DeviceNotFoundError. Returns the device row as it was before revocation."""
    db = get_db()
    row = get_device(device_id)
    if row is None:
        raise DeviceNotFoundError(device_id)

    if row["status"] != "revoked":
        db.execute("UPDATE devices SET status = 'revoked' WHERE id = ?", (device_id,))
        bump_device_version(db, row["email"])
        db.commit()
        device_revocations_total.labels(trigger="admin").inc()
    return row


def revoke_all_devices(email: str, trigger: str = "self_service") -> list[str]:
    """"Revoke a person" (§4) -- cascades to every device of `email`.
    Bumps the version counter once for the whole batch, not once per
    device. Returns the ids that were actually flipped to revoked (already-
    revoked/expired rows are left alone and excluded)."""
    db = get_db()
    rows = db.execute(
        "SELECT id FROM devices WHERE email = ? AND status = 'active'", (email,)
    ).fetchall()
    device_ids = [row["id"] for row in rows]
    if not device_ids:
        return []

    db.executemany(
        "UPDATE devices SET status = 'revoked' WHERE id = ?",
        [(did,) for did in device_ids],
    )
    bump_device_version(db, email)
    db.commit()
    device_revocations_total.labels(trigger=trigger).inc(len(device_ids))
    return device_ids


def expire_stale_web_devices() -> list[str]:
    """Auto-expiry sweep (§4): a `web` device that hasn't sent a heartbeat
    in WEB_HEARTBEAT_EXPIRY_DAYS is moved active -> expired. Deliberately
    does NOT bump the device-list version -- routine cleanup, not a trust
    event, so it must not trigger the device-list-changed banner. Android
    devices are never touched here (hardware-backed Keystore doesn't need
    this). Returns the ids that were expired, for logging."""
    db = get_db()
    cutoff = (_now() - timedelta(days=WEB_HEARTBEAT_EXPIRY_DAYS)).isoformat()
    rows = db.execute(
        """
        SELECT id FROM devices
        WHERE platform = 'web' AND status = 'active'
          AND (last_seen_at IS NULL OR last_seen_at < ?)
        """,
        (cutoff,),
    ).fetchall()
    device_ids = [row["id"] for row in rows]
    if device_ids:
        db.executemany(
            "UPDATE devices SET status = 'expired' WHERE id = ?",
            [(did,) for did in device_ids],
        )
        db.commit()
    return device_ids
