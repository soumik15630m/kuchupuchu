import os
import sqlite3
import threading
from pathlib import Path

_local = threading.local()
_auth_local = threading.local()


def _database_path() -> Path:
    return Path(os.environ.get("WAKE_DB_PATH", "/data/wake.sqlite"))


def _auth_database_path() -> Path:
    return Path(os.environ.get("AUTH_DB_PATH", "/data/app.db"))


def _connect(path: Path, read_only: bool) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    if read_only:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    else:
        conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    if not read_only:
        conn.execute("PRAGMA journal_mode = WAL")
    return conn


def get_db() -> sqlite3.Connection:
    """One connection per thread -- sqlite3 objects are not safe to hand
    between threads, and a shared one makes BEGIN IMMEDIATE isolate nothing."""
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _connect(_database_path(), read_only=False)
        _local.conn = conn
    return conn


def get_auth_db() -> sqlite3.Connection:
    """Read-only handle on auth-service's database, for the same reason
    messaging-service holds one: a revoked device must stop being a valid
    push target immediately, not when its last access token expires. Read-only
    is enforced by the connection URI rather than by convention."""
    conn = getattr(_auth_local, "conn", None)
    if conn is None:
        conn = _connect(_auth_database_path(), read_only=True)
        _auth_local.conn = conn
    return conn


def run_migrations() -> None:
    db = get_db()
    db.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    db.commit()

    applied = {row["name"] for row in db.execute("SELECT name FROM schema_migrations")}
    migrations_dir = Path(__file__).resolve().parent.parent / "migrations"
    # Filename order is apply order, so prefixes must be unique.
    for path in sorted(migrations_dir.glob("*.sql")):
        if path.name in applied:
            continue
        db.executescript(path.read_text(encoding="utf-8"))
        db.execute(
            "INSERT INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))",
            (path.name,),
        )
        db.commit()
