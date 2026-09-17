import uuid
from datetime import datetime, timedelta, timezone

from app.db import get_db

# §10.4: "7-day maximum retention". Applies to undelivered messages and to
# media blobs alike -- a message nobody ever came back for is not kept
# indefinitely just because the recipient never reconnected.
RETENTION_DAYS = 7

MAX_ENVELOPE_BYTES = 128 * 1024


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class EnvelopeTooLargeError(Exception):
    pass


def store_message(
    *,
    client_msg_id: str,
    from_email: str,
    from_device: str,
    to_email: str,
    to_device: str,
    kind: str,
    envelope: str,
) -> dict:
    if len(envelope) > MAX_ENVELOPE_BYTES:
        raise EnvelopeTooLargeError(
            f"envelope is {len(envelope)} bytes, limit is {MAX_ENVELOPE_BYTES}"
        )

    row = {
        "id": str(uuid.uuid4()),
        "client_msg_id": client_msg_id,
        "from_email": from_email,
        "from_device": from_device,
        "to_email": to_email,
        "to_device": to_device,
        "kind": kind,
        "envelope": envelope,
        "created_at": _now_iso(),
    }
    db = get_db()
    db.execute(
        """INSERT INTO messages
           (id, client_msg_id, from_email, from_device, to_email, to_device, kind, envelope, created_at)
           VALUES (:id, :client_msg_id, :from_email, :from_device, :to_email, :to_device, :kind, :envelope, :created_at)""",
        row,
    )
    db.commit()
    return row


def pending_for_device(device_id: str, limit: int = 500) -> list[dict]:
    rows = get_db().execute(
        """SELECT * FROM messages
           WHERE to_device = ? AND delivered_at IS NULL
           ORDER BY created_at LIMIT ?""",
        (device_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def mark_delivered(message_ids: list[str], device_id: str) -> list[dict]:
    """Marks this device's own copies delivered and returns what changed, so
    the sender can be told. Scoped to `device_id` so one device cannot
    acknowledge another's messages."""
    if not message_ids:
        return []
    db = get_db()
    placeholders = ",".join("?" for _ in message_ids)
    rows = db.execute(
        f"""SELECT id, client_msg_id, from_device, to_email FROM messages
            WHERE to_device = ? AND delivered_at IS NULL AND id IN ({placeholders})""",
        (device_id, *message_ids),
    ).fetchall()
    if not rows:
        return []
    db.execute(
        f"UPDATE messages SET delivered_at = ? WHERE to_device = ? AND id IN ({placeholders})",
        (_now_iso(), device_id, *message_ids),
    )
    db.commit()
    return [dict(r) for r in rows]


def mark_read(client_msg_ids: list[str], device_id: str) -> list[dict]:
    if not client_msg_ids:
        return []
    db = get_db()
    placeholders = ",".join("?" for _ in client_msg_ids)
    rows = db.execute(
        f"""SELECT id, client_msg_id, from_device FROM messages
            WHERE to_device = ? AND read_at IS NULL AND client_msg_id IN ({placeholders})""",
        (device_id, *client_msg_ids),
    ).fetchall()
    if not rows:
        return []
    db.execute(
        f"UPDATE messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) "
        f"WHERE to_device = ? AND client_msg_id IN ({placeholders})",
        (_now_iso(), _now_iso(), device_id, *client_msg_ids),
    )
    db.commit()
    return [dict(r) for r in rows]


def prune_expired() -> int:
    """§10.4: delivered messages go as soon as they are read, undelivered
    ones at the retention cap."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).isoformat()
    db = get_db()
    cur = db.execute(
        "DELETE FROM messages WHERE read_at IS NOT NULL OR created_at < ?",
        (cutoff,),
    )
    db.commit()
    return cur.rowcount
