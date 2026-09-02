"""Prekey bundle storage for X3DH (§6, §13 Phase 4).

The server never sees a private key -- everything here is public material
a device publishes so *other* devices can run X3DH against it. The one
thing worth being careful about is exactly what "the server" is trusted to
do: it stores and hands out public keys, and it verifies the signed
prekey's signature on the way in so a malformed bundle can't get served to
a peer, but it never generates keys and never sees anything that would let
it (or anyone who compromises it) derive a session key on its own.
"""
from __future__ import annotations

import base64
import binascii

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from app.db import get_db

IDENTITY_KEY_BYTES = 32
X25519_PUBLIC_KEY_BYTES = 32
ED25519_SIGNATURE_BYTES = 64

# A device tops these up periodically; this just bounds how many
# unconsumed keys can pile up from a client that keeps uploading without
# anyone ever fetching a bundle from it. Signal's own guidance is "keep
# roughly 100 in reserve" -- there's nothing sacred about the number, it's
# just not "unbounded."
MAX_UNUSED_ONE_TIME_PREKEYS = 200


class NoIdentityKeyError(Exception):
    """Raised when a signed prekey or bundle is requested/uploaded for a
    device that hasn't published an identity key yet."""


class IdentityKeyMismatchError(Exception):
    """Raised when a device tries to publish a *different* identity key
    than the one already on file. An identity key is meant to be stable
    for the device's lifetime (§9's safety-number story assumes this) --
    a real rotation means revoking the device and provisioning a new one,
    not silently swapping the key underneath an existing device_id."""


class InvalidPrekeySignatureError(Exception):
    """Raised when a signed prekey's signature doesn't verify against the
    device's on-file identity key."""


class DuplicateOneTimePrekeyIdError(Exception):
    """Raised when a device re-uploads a key_id it already published,
    used or not -- key ids must be unique per device so a bundle fetch
    can unambiguously say which one it handed out."""


def _decode_fixed_length(value: str, expected_len: int, field_name: str) -> bytes:
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} is not valid base64") from exc
    if len(raw) != expected_len:
        raise ValueError(f"{field_name} must decode to {expected_len} bytes, got {len(raw)}")
    return raw


def validate_identity_key(value: str) -> bytes:
    return _decode_fixed_length(value, IDENTITY_KEY_BYTES, "identity_key")


def validate_x25519_public_key(value: str) -> bytes:
    return _decode_fixed_length(value, X25519_PUBLIC_KEY_BYTES, "public_key")


def validate_signature(value: str) -> bytes:
    return _decode_fixed_length(value, ED25519_SIGNATURE_BYTES, "signature")


def get_identity_key(device_id: str) -> str | None:
    db = get_db()
    row = db.execute(
        "SELECT public_key FROM identity_keys WHERE device_id = ?", (device_id,)
    ).fetchone()
    return row["public_key"] if row else None


def get_identity_dh_key(device_id: str) -> dict | None:
    db = get_db()
    row = db.execute(
        "SELECT public_key, signature FROM identity_dh_keys WHERE device_id = ?", (device_id,)
    ).fetchone()
    return dict(row) if row else None


def upload_identity_dh_key(device_id: str, public_key_b64: str, signature_b64: str) -> None:
    """Same verify-then-store shape as `upload_signed_prekey`, against the
    same Ed25519 identity key -- see 005_phase4_identity_dh_key.sql for
    why this is a second key rather than reusing the Ed25519 one for DH.
    Idempotent for a byte-identical re-upload; rejects a genuine change,
    same posture as the Ed25519 identity key itself."""
    identity_key_b64 = get_identity_key(device_id)
    if identity_key_b64 is None:
        raise NoIdentityKeyError(device_id)

    public_key_bytes = validate_x25519_public_key(public_key_b64)
    signature_bytes = validate_signature(signature_b64)
    identity_key_bytes = base64.b64decode(identity_key_b64)

    verifier = Ed25519PublicKey.from_public_bytes(identity_key_bytes)
    try:
        verifier.verify(signature_bytes, public_key_bytes)
    except InvalidSignature as exc:
        raise InvalidPrekeySignatureError(device_id) from exc

    existing = get_identity_dh_key(device_id)
    if existing is not None:
        if existing["public_key"] == public_key_b64 and existing["signature"] == signature_b64:
            return
        raise IdentityKeyMismatchError(device_id)

    db = get_db()
    db.execute(
        "INSERT INTO identity_dh_keys (device_id, public_key, signature) VALUES (?, ?, ?)",
        (device_id, public_key_b64, signature_b64),
    )
    db.commit()


def upload_identity_key(device_id: str, email: str, public_key_b64: str) -> None:
    """Publishes a device's identity key. Idempotent for a matching
    re-upload (a client that restarts and re-runs its setup path
    shouldn't fail here) but rejects an attempt to change it -- see
    `IdentityKeyMismatchError`."""
    validate_identity_key(public_key_b64)

    existing = get_identity_key(device_id)
    if existing is not None:
        if existing != public_key_b64:
            raise IdentityKeyMismatchError(device_id)
        return

    db = get_db()
    db.execute(
        "INSERT INTO identity_keys (device_id, email, public_key) VALUES (?, ?, ?)",
        (device_id, email, public_key_b64),
    )
    db.commit()


def upload_signed_prekey(device_id: str, key_id: int, public_key_b64: str, signature_b64: str) -> None:
    """Verifies `signature_b64` is the device's identity key signing
    `public_key_b64`'s raw bytes, then replaces whatever signed prekey the
    device had on file. No history is kept -- a rotated-out signed prekey
    serves no purpose once a newer one is published."""
    identity_key_b64 = get_identity_key(device_id)
    if identity_key_b64 is None:
        raise NoIdentityKeyError(device_id)

    public_key_bytes = validate_x25519_public_key(public_key_b64)
    signature_bytes = validate_signature(signature_b64)
    identity_key_bytes = base64.b64decode(identity_key_b64)

    verifier = Ed25519PublicKey.from_public_bytes(identity_key_bytes)
    try:
        verifier.verify(signature_bytes, public_key_bytes)
    except InvalidSignature as exc:
        raise InvalidPrekeySignatureError(device_id) from exc

    db = get_db()
    db.execute(
        """
        INSERT INTO signed_prekeys (device_id, key_id, public_key, signature)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (device_id) DO UPDATE SET
            key_id = excluded.key_id,
            public_key = excluded.public_key,
            signature = excluded.signature,
            created_at = datetime('now')
        """,
        (device_id, key_id, public_key_b64, signature_b64),
    )
    db.commit()


def add_one_time_prekeys(device_id: str, keys: list[tuple[int, str]]) -> None:
    """`keys` is a list of (key_id, public_key_b64) pairs. Validates every
    entry before writing any of them, so a bad entry midway through a
    batch doesn't leave a partial upload on file."""
    for _, public_key_b64 in keys:
        validate_x25519_public_key(public_key_b64)

    db = get_db()
    current_unused = db.execute(
        "SELECT COUNT(*) AS n FROM one_time_prekeys WHERE device_id = ? AND used_at IS NULL",
        (device_id,),
    ).fetchone()["n"]
    if current_unused + len(keys) > MAX_UNUSED_ONE_TIME_PREKEYS:
        raise ValueError(
            f"upload would leave {current_unused + len(keys)} unused one-time prekeys, "
            f"cap is {MAX_UNUSED_ONE_TIME_PREKEYS}"
        )

    try:
        for key_id, public_key_b64 in keys:
            db.execute(
                "INSERT INTO one_time_prekeys (device_id, key_id, public_key) VALUES (?, ?, ?)",
                (device_id, key_id, public_key_b64),
            )
    except Exception as exc:
        db.rollback()
        if "UNIQUE constraint failed" in str(exc):
            raise DuplicateOneTimePrekeyIdError(device_id) from exc
        raise
    db.commit()


def unused_one_time_prekey_count(device_id: str) -> int:
    db = get_db()
    row = db.execute(
        "SELECT COUNT(*) AS n FROM one_time_prekeys WHERE device_id = ? AND used_at IS NULL",
        (device_id,),
    ).fetchone()
    return row["n"]


def _consume_one_time_prekey(device_id: str) -> dict | None:
    """Atomically claims the oldest unused one-time prekey for
    `device_id`, or returns None if the pool is empty (X3DH degrades
    gracefully without one -- it just loses that extra DH term). The
    UPDATE's WHERE-subquery pattern keeps the claim to a single statement
    so two concurrent bundle fetches can't both walk away with the same
    key -- SQLite serializes writes on this connection, so there's no
    window between "pick a row" and "mark it used" for a second caller to
    land in.
    """
    db = get_db()
    cur = db.execute(
        """
        UPDATE one_time_prekeys
        SET used_at = datetime('now')
        WHERE id = (
            SELECT id FROM one_time_prekeys
            WHERE device_id = ? AND used_at IS NULL
            ORDER BY id ASC LIMIT 1
        )
        """,
        (device_id,),
    )
    if cur.rowcount == 0:
        db.commit()
        return None

    row = db.execute(
        """
        SELECT key_id, public_key FROM one_time_prekeys
        WHERE device_id = ? AND used_at IS NOT NULL
        ORDER BY used_at DESC, id DESC LIMIT 1
        """,
        (device_id,),
    ).fetchone()
    db.commit()
    return {"key_id": row["key_id"], "public_key": row["public_key"]}


def get_bundle(device_id: str) -> dict | None:
    """Returns everything an X3DH initiator needs to start a session with
    `device_id`: its identity key, its current signed prekey, and one
    freshly-consumed one-time prekey if any are left. Returns None if the
    device hasn't published an identity key + signed prekey yet -- Phase 4
    setup incomplete, not an error condition the caller needs to retry."""
    db = get_db()
    identity_row = db.execute(
        "SELECT public_key FROM identity_keys WHERE device_id = ?", (device_id,)
    ).fetchone()
    identity_dh_row = db.execute(
        "SELECT public_key, signature FROM identity_dh_keys WHERE device_id = ?", (device_id,)
    ).fetchone()
    signed_row = db.execute(
        "SELECT key_id, public_key, signature FROM signed_prekeys WHERE device_id = ?",
        (device_id,),
    ).fetchone()
    if identity_row is None or identity_dh_row is None or signed_row is None:
        return None

    one_time = _consume_one_time_prekey(device_id)

    return {
        "identity_key": identity_row["public_key"],
        "identity_dh_key": {
            "public_key": identity_dh_row["public_key"],
            "signature": identity_dh_row["signature"],
        },
        "signed_prekey": {
            "key_id": signed_row["key_id"],
            "public_key": signed_row["public_key"],
            "signature": signed_row["signature"],
        },
        "one_time_prekey": one_time,
    }
