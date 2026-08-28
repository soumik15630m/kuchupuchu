import os
import sqlite3

_db: sqlite3.Connection | None = None


def get_db() -> sqlite3.Connection:
    """Single shared SQLite connection (§3, §4). WAL mode so the nightly-
    backup `.sqlite` snapshot process (§11) can run concurrently without
    locking writers out."""
    global _db
    if _db is not None:
        return _db

    path = os.environ.get("SQLITE_PATH", "/data/app.db")
    _db = sqlite3.connect(path, check_same_thread=False)
    _db.row_factory = sqlite3.Row
    _db.execute("PRAGMA journal_mode = WAL")
    _db.execute("PRAGMA foreign_keys = ON")
    return _db
