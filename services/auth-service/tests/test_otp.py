"""§4 OTP flow tests, independent of the HTTP layer (routers/auth.py has
its own tests in test_auth_router.py). Covers the gaps the audit flagged
as untested: allowlist gating, rate limiting, expiry, attempt exhaustion,
and that a consumed code can't be replayed."""
from datetime import datetime, timedelta, timezone

import pytest

from app.db import get_db
from app.otp import (
    MAX_REQUESTS_PER_HOUR,
    MAX_VERIFY_ATTEMPTS,
    InvalidOtpError,
    NotAllowlistedError,
    OtpExpiredError,
    RateLimitedError,
    TooManyAttemptsError,
    request_otp,
    verify_otp,
)


def _allowlist(db, email: str) -> None:
    db.execute("INSERT OR IGNORE INTO allowlist (email) VALUES (?)", (email,))
    db.commit()


def test_request_otp_rejects_non_allowlisted_email(fresh_db):
    with pytest.raises(NotAllowlistedError):
        request_otp("nobody@example.com")


def test_request_and_verify_round_trip(fresh_db):
    _allowlist(fresh_db, "a@example.com")
    code = request_otp("a@example.com")
    assert len(code) == 6 and code.isdigit()
    verify_otp("a@example.com", code)  # raises on failure, returns nothing on success


def test_verify_normalizes_email_case(fresh_db):
    _allowlist(fresh_db, "a@example.com")
    code = request_otp("A@Example.com")
    verify_otp("a@EXAMPLE.com", code)


def test_verify_rejects_wrong_code(fresh_db):
    _allowlist(fresh_db, "a@example.com")
    code = request_otp("a@example.com")
    wrong = f"{(int(code) + 1) % 1_000_000:06d}"
    with pytest.raises(InvalidOtpError):
        verify_otp("a@example.com", wrong)


def test_verify_with_no_outstanding_otp_fails(fresh_db):
    _allowlist(fresh_db, "a@example.com")
    with pytest.raises(InvalidOtpError):
        verify_otp("a@example.com", "123456")


def test_consumed_code_cannot_be_replayed(fresh_db):
    _allowlist(fresh_db, "a@example.com")
    code = request_otp("a@example.com")
    verify_otp("a@example.com", code)
    with pytest.raises(InvalidOtpError):
        verify_otp("a@example.com", code)


def test_expired_code_is_rejected(fresh_db):
    _allowlist(fresh_db, "a@example.com")
    code = request_otp("a@example.com")
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    fresh_db.execute("UPDATE otp_codes SET expires_at = ? WHERE email = ?", (past, "a@example.com"))
    fresh_db.commit()
    with pytest.raises(OtpExpiredError):
        verify_otp("a@example.com", code)


def test_too_many_attempts_locks_out_the_code(fresh_db):
    _allowlist(fresh_db, "a@example.com")
    code = request_otp("a@example.com")
    wrong = f"{(int(code) + 1) % 1_000_000:06d}"

    for _ in range(MAX_VERIFY_ATTEMPTS):
        with pytest.raises(InvalidOtpError):
            verify_otp("a@example.com", wrong)

    # The Nth+1 attempt hits the exhausted-attempts branch, not "wrong code"
    # again, even if the caller now submits the *right* code.
    with pytest.raises(TooManyAttemptsError):
        verify_otp("a@example.com", code)


def test_rate_limit_kicks_in_after_max_requests_per_hour(fresh_db):
    _allowlist(fresh_db, "a@example.com")
    for _ in range(MAX_REQUESTS_PER_HOUR):
        request_otp("a@example.com")
    with pytest.raises(RateLimitedError):
        request_otp("a@example.com")


def test_rate_limit_is_scoped_per_email(fresh_db):
    _allowlist(fresh_db, "a@example.com")
    _allowlist(fresh_db, "b@example.com")
    for _ in range(MAX_REQUESTS_PER_HOUR):
        request_otp("a@example.com")
    request_otp("b@example.com")  # must not be blocked by a's usage


def test_old_requests_dont_count_toward_the_hourly_window(fresh_db):
    _allowlist(fresh_db, "a@example.com")
    for _ in range(MAX_REQUESTS_PER_HOUR):
        request_otp("a@example.com")

    old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    get_db().execute("UPDATE otp_codes SET created_at = ? WHERE email = ?", (old, "a@example.com"))
    get_db().commit()

    request_otp("a@example.com")  # window is clear again


def test_new_request_supersedes_previous_code(fresh_db):
    """verify_otp only ever looks at the most recent unconsumed code --
    requesting a second OTP must invalidate the first."""
    _allowlist(fresh_db, "a@example.com")
    first = request_otp("a@example.com")
    second = request_otp("a@example.com")
    assert first != second

    with pytest.raises(InvalidOtpError):
        verify_otp("a@example.com", first)
    verify_otp("a@example.com", second)


def test_supersession_holds_even_with_identical_timestamps(fresh_db):
    """Deterministic version of the test above: forces both rows to the
    same created_at rather than relying on two calls landing in different
    timesteps, since on a coarse clock (observed on Windows) they can
    collide and a created_at-only ORDER BY has no way to break the tie."""
    _allowlist(fresh_db, "a@example.com")
    first = request_otp("a@example.com")
    second = request_otp("a@example.com")

    same_timestamp = datetime.now(timezone.utc).isoformat()
    get_db().execute(
        "UPDATE otp_codes SET created_at = ? WHERE email = ?", (same_timestamp, "a@example.com")
    )
    get_db().commit()

    with pytest.raises(InvalidOtpError):
        verify_otp("a@example.com", first)
    verify_otp("a@example.com", second)
