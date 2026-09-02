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
    # Manual transaction control instead of pysqlite's implicit-BEGIN
    # default -- callers that need a check-then-act sequence to be atomic
    # (device-cap enforcement, OTP rate limiting) issue their own
    # `BEGIN IMMEDIATE` and are guaranteed no other statement on this
    # connection interleaves until they commit or roll back.
    _db.isolation_level = None
    _db.execute("PRAGMA journal_mode = WAL")
    _db.execute("PRAGMA foreign_keys = ON")
    return _db
