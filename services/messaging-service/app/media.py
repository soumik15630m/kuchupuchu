import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.db import get_db

# §10.4 specifies Cloudflare R2 with a lifecycle rule. Until the hosting
# question in §1a is settled there is no bucket to write to, so blobs land on
# a local volume with the same 7-day cap and the same delete-after-download
# rule enforced in code. The storage backend changes; the contract does not.
RETENTION_DAYS = 7
MAX_BLOB_BYTES = 25 * 1024 * 1024


def _media_root() -> Path:
    root = Path(os.environ.get("MEDIA_PATH", "/data/media"))
    root.mkdir(parents=True, exist_ok=True)
    return root


class BlobTooLargeError(Exception):
    pass


def _blob_path(media_id: str) -> Path:
    # media_id is always a server-generated uuid4; it is never taken from the
    # request, so it cannot traverse out of the media root.
    return _media_root() / media_id


def store_blob(*, owner_email: str, owner_device: str, audience: list[str], data: bytes) -> dict:
    if len(data) > MAX_BLOB_BYTES:
        raise BlobTooLargeError(f"blob is {len(data)} bytes, limit is {MAX_BLOB_BYTES}")

    media_id = str(uuid.uuid4())
    _blob_path(media_id).write_bytes(data)

    now = datetime.now(timezone.utc)
    row = {
        "id": media_id,
        "owner_email": owner_email,
        "owner_device": owner_device,
        "audience": ",".join(sorted({a.lower() for a in audience} | {owner_email.lower()})),
        "byte_size": len(data),
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(days=RETENTION_DAYS)).isoformat(),
    }
    db = get_db()
    db.execute(
        """INSERT INTO media (id, owner_email, owner_device, audience, byte_size, created_at, expires_at)
           VALUES (:id, :owner_email, :owner_device, :audience, :byte_size, :created_at, :expires_at)""",
        row,
    )
    db.commit()
    return row


def get_blob(media_id: str, requester_email: str) -> bytes | None:
    row = get_db().execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
    if row is None:
        return None
    if requester_email.lower() not in row["audience"].split(","):
        return None
    path = _blob_path(media_id)
    if not path.is_file():
        return None
    return path.read_bytes()


def record_download(media_id: str, requester_email: str) -> None:
    """§10.4's delete-after-both-downloaded: once every member of the
    audience has fetched it, the blob goes immediately rather than waiting
    out the retention window."""
    db = get_db()
    row = db.execute("SELECT audience, downloaded_by FROM media WHERE id = ?", (media_id,)).fetchone()
    if row is None:
        return

    downloaded = {e for e in row["downloaded_by"].split(",") if e}
    downloaded.add(requester_email.lower())
    db.execute(
        "UPDATE media SET downloaded_by = ? WHERE id = ?",
        (",".join(sorted(downloaded)), media_id),
    )
    db.commit()

    if downloaded >= set(row["audience"].split(",")):
        delete_blob(media_id)


def delete_blob(media_id: str) -> None:
    path = _blob_path(media_id)
    if path.is_file():
        path.unlink()
    db = get_db()
    db.execute("DELETE FROM media WHERE id = ?", (media_id,))
    db.commit()


def prune_expired() -> int:
    now = datetime.now(timezone.utc).isoformat()
    db = get_db()
    rows = db.execute("SELECT id FROM media WHERE expires_at < ?", (now,)).fetchall()
    for row in rows:
        delete_blob(row["id"])
    return len(rows)
