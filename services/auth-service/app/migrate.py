"""Run pending SQL migrations and seed the allowlist from ADMIN_SEED_EMAILS.

Run standalone (`python -m app.migrate`) before the app starts — see
Dockerfile's CMD.
"""
import os
from pathlib import Path

from app.db import get_db

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def run_migrations() -> None:
    db = get_db()
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS _migrations (
            filename TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    db.commit()

    applied = {row["filename"] for row in db.execute("SELECT filename FROM _migrations")}

    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if path.name in applied:
            continue
        print(f"[migrate] applying {path.name}")
        db.executescript(path.read_text())
        db.execute("INSERT INTO _migrations (filename) VALUES (?)", (path.name,))
        db.commit()

    seed_allowlist(db)


def seed_allowlist(db) -> None:
    seed_list = [
        e.strip().lower()
        for e in os.environ.get("ADMIN_SEED_EMAILS", "").split(",")
        if e.strip()
    ]

    # §1 hard cap — refuse to seed past 10 known members rather than
    # silently truncating, since that's a security-relevant constraint,
    # not a UX one.
    if len(seed_list) > 10:
        raise RuntimeError(
            f"ADMIN_SEED_EMAILS has {len(seed_list)} entries; §1 caps known members at 10."
        )

    for email in seed_list:
        db.execute("INSERT OR IGNORE INTO allowlist (email) VALUES (?)", (email,))
    db.commit()

    if seed_list:
        print(f"[migrate] allowlist seeded/verified for: {', '.join(seed_list)}")


if __name__ == "__main__":
    run_migrations()
