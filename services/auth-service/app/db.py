"""SQLite connection management: one connection PER THREAD.

FastAPI runs every sync endpoint on a threadpool worker. On a single
shared connection `BEGIN IMMEDIATE` isolates nothing -- concurrent
threads raise "cannot start a transaction within a transaction", and
either one's commit() commits the other's writes. The device cap and
the OTP rate limit both rely on it meaning what it says.

`check_same_thread` is deliberately left at its default: with a
connection per thread the guard is an invariant worth enforcing.
"""
import os
import sqlite3
import threading

# Without this a concurrent writer gets an immediate SQLITE_BUSY
# instead of waiting its turn.
BUSY_TIMEOUT_MS = 5000

_local = threading.local()

# A registry of open connections cannot work here: check_same_thread
# applies to close() too, so closing another thread's connection
# raises, and a broad except around that makes the whole thing a
# silent no-op. A generation counter avoids touching them at all.
_generation = 0
_generation_lock = threading.Lock()


def _current_generation() -> int:
    with _generation_lock:
        return _generation


def get_db() -> sqlite3.Connection:
    """This thread's SQLite connection, opening one on first use.

    WAL mode so the nightly-backup `.sqlite` snapshot process (§11) can
    run concurrently without locking writers out -- and, now that there
    is more than one connection, so readers don't block the writer.
    """
    generation = _current_generation()
    existing = getattr(_local, "state", None)
    if existing is not None:
        conn, conn_generation = existing
        if conn_generation == generation:
            return conn
        # Stale. This thread owns it, so this thread is the one allowed
        # to close it.
        del _local.state
        conn.close()

    path = os.environ.get("SQLITE_PATH", "/data/app.db")
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    # Manual transaction control instead of pysqlite's implicit-BEGIN
    # default -- callers that need a check-then-act sequence to be atomic
    # (device-cap enforcement, OTP rate limiting) issue their own
    # `BEGIN IMMEDIATE`, which now genuinely excludes other writers for
    # the duration because those writers are on their own connections.
    conn.isolation_level = None
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")

    _local.state = (conn, generation)
    return conn


def reset_connections() -> None:
    """Invalidates every thread's connection.

    The calling thread's is closed immediately; every other thread closes
    and reopens its own the next time it calls get_db(). Used by tests
    between cases, where SQLITE_PATH changes underneath a threadpool that
    may outlive a single test.
    """
    global _generation
    with _generation_lock:
        _generation += 1

    existing = getattr(_local, "state", None)
    if existing is not None:
        del _local.state
        existing[0].close()
