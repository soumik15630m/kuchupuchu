"""Username validation, normalisation and the reservation rules around them.

Split from the router so the rules are testable on their own -- the character
policy and the confusable-collapsing below are the parts worth exhaustive
coverage, not the HTTP plumbing.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timedelta, timezone

from app.db import get_db

MIN_LENGTH = 3
MAX_LENGTH = 30

# A released handle stays parked this long before anyone *else* may take it.
# The original owner can always reclaim their own immediately.
RELEASE_COOLDOWN_DAYS = 30

# Deliberately narrow: ASCII letters, digits, underscore and dot. Unicode
# usernames read well but make impersonation trivial -- Cyrillic "а" renders
# identically to Latin "a" -- and this app's whole threat model is a small
# group who must be able to trust that a name refers to who they think.
_ALLOWED = re.compile(r"^[a-z0-9._]+$")

_RESERVED = frozenset(
    {
        "admin", "administrator", "root", "system", "support", "help",
        "kuchupuchu", "security", "moderator", "mod", "staff", "official",
        "me", "self", "you", "everyone", "all", "here", "channel",
        "null", "undefined", "none", "anonymous", "deleted",
    }
)


class UsernameError(ValueError):
    """Rejected for a reason worth showing the user verbatim."""


def normalize(raw: str) -> str:
    """The form uniqueness is enforced on.

    NFKC first, so full-width and other compatibility forms collapse onto their
    plain equivalents ("ａlice" and "alice" must not be two accounts), then
    casefold rather than lower() because casefold handles cases lower() does
    not.
    """
    return unicodedata.normalize("NFKC", raw).strip().casefold()


def validate(raw: str) -> tuple[str, str]:
    """Returns (display_form, normalized_form) or raises UsernameError.

    The display form keeps the caller's casing; only the normalized form is
    checked for uniqueness.
    """
    display = unicodedata.normalize("NFKC", raw).strip()
    normalized = display.casefold()

    if len(normalized) < MIN_LENGTH:
        raise UsernameError(f"username must be at least {MIN_LENGTH} characters")
    if len(normalized) > MAX_LENGTH:
        raise UsernameError(f"username must be at most {MAX_LENGTH} characters")
    if not _ALLOWED.match(normalized):
        raise UsernameError("username may only contain letters, digits, dots and underscores")
    if normalized[0] in "._" or normalized[-1] in "._":
        raise UsernameError("username cannot start or end with a dot or underscore")
    if ".." in normalized or "__" in normalized or "._" in normalized or "_." in normalized:
        raise UsernameError("username cannot contain two separators in a row")
    if normalized in _RESERVED:
        raise UsernameError("that username is reserved")
    # An all-digit handle is ambiguous with an id anywhere one is displayed.
    if normalized.replace(".", "").replace("_", "").isdigit():
        raise UsernameError("username cannot be only digits")

    return display, normalized


def owner_of(normalized: str) -> str | None:
    row = get_db().execute(
        "SELECT email FROM allowlist WHERE username_normalized = ?", (normalized,)
    ).fetchone()
    return row["email"] if row else None


def is_parked_for_others(normalized: str, email: str) -> bool:
    """Whether `normalized` was released recently by a *different* account."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RELEASE_COOLDOWN_DAYS)).isoformat()
    row = get_db().execute(
        """SELECT 1 FROM username_history
           WHERE username_normalized = ? AND email != ? AND released_at > ?
           LIMIT 1""",
        (normalized, email, cutoff),
    ).fetchone()
    return row is not None


class UsernameTakenError(UsernameError):
    pass


def set_username(email: str, raw: str) -> tuple[str, str]:
    """Claims `raw` for `email`, releasing whatever they held before.

    Raises UsernameTakenError if another account holds it, or released it
    inside the cooldown.
    """
    display, normalized = validate(raw)

    existing_owner = owner_of(normalized)
    if existing_owner is not None and existing_owner != email:
        raise UsernameTakenError("that username is taken")
    if existing_owner != email and is_parked_for_others(normalized, email):
        raise UsernameTakenError("that username was recently released and is not available yet")

    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    db.execute("BEGIN IMMEDIATE")
    try:
        previous = db.execute(
            "SELECT username_normalized FROM allowlist WHERE email = ?", (email,)
        ).fetchone()
        if previous is None:
            raise UsernameError("not a known member")

        old = previous["username_normalized"]
        if old and old != normalized:
            db.execute(
                "INSERT INTO username_history (username_normalized, email, released_at) VALUES (?, ?, ?)",
                (old, email, now),
            )

        db.execute(
            """UPDATE allowlist
               SET username = ?, username_normalized = ?, profile_updated_at = ?
               WHERE email = ?""",
            (display, normalized, now, email),
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return display, normalized


def set_profile(email: str, display_name: str | None, about: str | None) -> None:
    db = get_db()
    db.execute(
        """UPDATE allowlist
           SET display_name = COALESCE(?, display_name),
               about = COALESCE(?, about),
               profile_updated_at = ?
           WHERE email = ?""",
        (display_name, about, datetime.now(timezone.utc).isoformat(), email),
    )
    db.commit()


def profile_for(email: str) -> dict | None:
    row = get_db().execute(
        """SELECT email, username, display_name, about, profile_updated_at
           FROM allowlist WHERE email = ?""",
        (email,),
    ).fetchone()
    return dict(row) if row else None


def resolve(raw: str) -> dict | None:
    """Looks an account up by username. Returns the same shape as profile_for."""
    try:
        _, normalized = validate(raw)
    except UsernameError:
        return None
    row = get_db().execute(
        """SELECT email, username, display_name, about, profile_updated_at
           FROM allowlist WHERE username_normalized = ?""",
        (normalized,),
    ).fetchone()
    return dict(row) if row else None


def directory() -> list[dict]:
    """Every known member.

    A fixed <=10-person allowlist (§1) has no discovery problem to solve and no
    enumeration surface worth defending: everyone in it already knows who else
    is in it. Publishing the list to authenticated members is what replaces
    contact-book sync.
    """
    rows = get_db().execute(
        """SELECT email, username, display_name, about, profile_updated_at
           FROM allowlist ORDER BY COALESCE(username, email)"""
    ).fetchall()
    return [dict(r) for r in rows]
