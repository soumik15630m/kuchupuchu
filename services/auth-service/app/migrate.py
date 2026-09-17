"""Run pending SQL migrations and seed the allowlist from ADMIN_SEED_EMAILS.

Run standalone (`python -m app.migrate`) before the app starts — see
Dockerfile's CMD.
"""
import os
from pathlib import Path

from app.db import get_db

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

# Applied in filename order and recorded by filename, so two files
# sharing a numeric prefix are ordered by the rest of the name. Four
# had collided on 004/005; they're renumbered now, and this map keeps
# a database that recorded the old name from re-applying the same SQL
# under the new one.
_RENAMED_MIGRATIONS = {
    "005_refresh_token_rotation.sql": "004_refresh_token_rotation.sql",
    "006_phase4_identity_dh_key.sql": "005_phase4_identity_dh_key.sql",
    "007_quality_reports_retention_index.sql": "005_quality_reports_retention_index.sql",
    "008_admin_revoke.sql": "006_admin_revoke.sql",
}


def _assert_unique_prefixes(paths: list[Path]) -> None:
    """Fails loudly if two migrations share a numeric prefix, rather than
    letting the ambiguity sit there until it silently matters."""
    seen: dict[str, str] = {}
    for path in paths:
        prefix = path.name.split("_", 1)[0]
        if prefix in seen:
            raise RuntimeError(
                f"migrations {seen[prefix]} and {path.name} share the prefix {prefix!r}; "
                "renumber one of them so the apply order is unambiguous"
            )
        seen[prefix] = path.name


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

    paths = sorted(MIGRATIONS_DIR.glob("*.sql"))
    _assert_unique_prefixes(paths)

    for path in paths:
        if path.name in applied:
            continue
        former_name = _RENAMED_MIGRATIONS.get(path.name)
        if former_name is not None and former_name in applied:
            # Already applied under its old name -- record the new one so
            # this lookup isn't needed again, but don't re-run the SQL.
            print(f"[migrate] {path.name} already applied as {former_name}; recording rename")
            db.execute("INSERT INTO _migrations (filename) VALUES (?)", (path.name,))
            db.commit()
            continue
        print(f"[migrate] applying {path.name}")
        # executescript() commits before running, so the schema change
        # and the row recording it cannot share a transaction. Writing
        # the row first inverts the failure into one that rolls back.
        db.execute("BEGIN IMMEDIATE")
        db.execute("INSERT INTO _migrations (filename) VALUES (?)", (path.name,))
        db.commit()
        try:
            db.executescript(path.read_text())
        except Exception:
            db.execute("DELETE FROM _migrations WHERE filename = ?", (path.name,))
            db.commit()
            raise

    seed_allowlist(db)
    seed_admins(db)


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


def seed_admins(db) -> None:
    """ADMIN_SEED_EMAILS (above) just means "known member" -- it's named
    that way for historical reasons and predates the admin-privilege
    concept entirely. ADMIN_EMAILS is the actual privilege grant, layered
    on top: an email in here gets is_admin=1, but must already be on the
    allowlist (running seed_allowlist first doesn't imply admin emails
    were also added there -- they're independent lists on purpose, so
    granting admin never silently expands the known-members set)."""
    admin_emails = [
        e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()
    ]
    if not admin_emails:
        return

    for email in admin_emails:
        row = db.execute("SELECT 1 FROM allowlist WHERE email = ?", (email,)).fetchone()
        if row is None:
            raise RuntimeError(
                f"ADMIN_EMAILS contains {email}, which is not on the allowlist "
                "(add it to ADMIN_SEED_EMAILS first)"
            )
        db.execute("UPDATE allowlist SET is_admin = 1 WHERE email = ?", (email,))
    db.commit()
    print(f"[migrate] admin privilege granted to: {', '.join(admin_emails)}")


if __name__ == "__main__":
    run_migrations()
