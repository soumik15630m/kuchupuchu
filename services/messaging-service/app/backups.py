import os
from datetime import datetime, timezone
from pathlib import Path

from app.db import get_db

# A backup carries a member's whole history including media, so the cap is
# well above the per-blob media limit. It is still a cap: without one, a
# client bug becomes a disk-filling bug on a server nobody is watching.
MAX_BACKUP_BYTES = 512 * 1024 * 1024


class BackupTooLargeError(Exception):
    pass


def _backup_root() -> Path:
    root = Path(os.environ.get("BACKUP_PATH", os.environ.get("MEDIA_PATH", "/data/media")))
    root = root / "backups"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _backup_path(email: str) -> Path:
    # Derived from the authenticated email rather than anything in the request
    # path, and hex-encoded so an address can never walk out of the directory.
    return _backup_root() / f"{email.lower().encode('utf-8').hex()}.kpbkp"


def store_backup(*, email: str, device_id: str, data: bytes) -> dict:
    if len(data) > MAX_BACKUP_BYTES:
        raise BackupTooLargeError(f"backup is {len(data)} bytes, limit is {MAX_BACKUP_BYTES}")

    path = _backup_path(email)
    # Written beside and renamed, so an interrupted upload cannot leave a
    # member with a half-file where their history used to be.
    temp = path.with_suffix(".part")
    temp.write_bytes(data)
    temp.replace(path)

    created_at = datetime.now(timezone.utc).isoformat()
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    db.execute(
        """INSERT INTO backups (email, byte_size, created_at, device_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             byte_size = excluded.byte_size,
             created_at = excluded.created_at,
             device_id = excluded.device_id""",
        (email.lower(), len(data), created_at, device_id),
    )
    db.commit()
    return {"byteSize": len(data), "createdAt": created_at, "deviceId": device_id}


def backup_meta(email: str) -> dict | None:
    row = get_db().execute(
        "SELECT byte_size, created_at, device_id FROM backups WHERE email = ?",
        (email.lower(),),
    ).fetchone()
    if row is None:
        return None
    if not _backup_path(email).exists():
        # The row outlived its file -- a restored database, a wiped volume.
        # Reporting a backup that cannot be downloaded is worse than none.
        return None
    return {
        "byteSize": row["byte_size"],
        "createdAt": row["created_at"],
        "deviceId": row["device_id"],
    }


def read_backup(email: str) -> bytes | None:
    path = _backup_path(email)
    if not path.exists():
        return None
    return path.read_bytes()


def delete_backup(email: str) -> bool:
    path = _backup_path(email)
    existed = path.exists()
    if existed:
        path.unlink()
    db = get_db()
    db.execute("BEGIN IMMEDIATE")
    db.execute("DELETE FROM backups WHERE email = ?", (email.lower(),))
    db.commit()
    return existed
