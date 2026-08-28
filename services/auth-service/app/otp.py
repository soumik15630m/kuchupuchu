import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from app.db import get_db

OTP_TTL_MIN = 10
MAX_REQUESTS_PER_HOUR = 5  # §4
MAX_VERIFY_ATTEMPTS = 5    # §4


class NotAllowlistedError(Exception):
    pass


class RateLimitedError(Exception):
    pass


class InvalidOtpError(Exception):
    pass


class OtpExpiredError(Exception):
    pass


class TooManyAttemptsError(Exception):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def _is_allowlisted(email: str) -> bool:
    db = get_db()
    row = db.execute("SELECT 1 FROM allowlist WHERE email = ?", (email,)).fetchone()
    return row is not None


def request_otp(email: str) -> str:
    """Generates and stores a new OTP for `email`. Returns the raw code so
    the caller can hand it to the delivery transport (console/SMTP, §9).
    Never stored or logged in plaintext beyond that."""
    normalized = email.lower()
    if not _is_allowlisted(normalized):
        raise NotAllowlistedError(f"{normalized} is not on the allowlist")

    db = get_db()
    one_hour_ago = (_now() - timedelta(hours=1)).isoformat()
    recent = db.execute(
        "SELECT COUNT(*) as n FROM otp_codes WHERE email = ? AND created_at > ?",
        (normalized, one_hour_ago),
    ).fetchone()

    if recent["n"] >= MAX_REQUESTS_PER_HOUR:
        raise RateLimitedError(f"{normalized} has requested {recent['n']} OTPs in the last hour")

    code = f"{secrets.randbelow(1_000_000):06d}"
    expires_at = (_now() + timedelta(minutes=OTP_TTL_MIN)).isoformat()

    db.execute(
        "INSERT INTO otp_codes (email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
        (normalized, _hash_code(code), expires_at, _now().isoformat()),
    )
    db.commit()

    return code


def verify_otp(email: str, submitted_code: str) -> None:
    """Verifies a submitted OTP. Raises on any failure; returns nothing on success."""
    normalized = email.lower()
    db = get_db()

    row = db.execute(
        """
        SELECT id, code_hash, expires_at, attempts, consumed
        FROM otp_codes
        WHERE email = ? AND consumed = 0
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (normalized,),
    ).fetchone()

    if row is None:
        raise InvalidOtpError("no active OTP for this email")

    if row["attempts"] >= MAX_VERIFY_ATTEMPTS:
        db.execute("UPDATE otp_codes SET consumed = 1 WHERE id = ?", (row["id"],))
        db.commit()
        raise TooManyAttemptsError("too many verification attempts; request a new code")

    if datetime.fromisoformat(row["expires_at"]) < _now():
        raise OtpExpiredError("OTP expired; request a new code")

    if _hash_code(submitted_code) != row["code_hash"]:
        db.execute("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?", (row["id"],))
        db.commit()
        raise InvalidOtpError("incorrect code")

    db.execute("UPDATE otp_codes SET consumed = 1 WHERE id = ?", (row["id"],))
    db.commit()
