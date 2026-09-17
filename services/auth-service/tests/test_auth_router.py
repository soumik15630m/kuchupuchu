"""§4 /otp/*, /token/refresh endpoint tests. Covers the login flow end to
end plus the specific fixes this pass made: refresh-token rotation, reuse
detection, device-cap/revoked-device rejection at login."""
from app.db import get_db
from app.devices import DEVICE_CAP_PER_PERSON, get_device


def _allowlist(email: str) -> None:
    get_db().execute("INSERT OR IGNORE INTO allowlist (email) VALUES (?)", (email,))
    get_db().commit()


def _latest_otp_code(email: str) -> str:
    """Test-only shortcut: pulls the code back out via request_otp's own
    return value instead of re-deriving it from the DB (codes are only
    ever stored hashed)."""
    from app.otp import request_otp

    return request_otp(email)


def _login(client, email: str, device_id: str = "dev-1", platform: str = "web") -> dict:
    code = _latest_otp_code(email)
    res = client.post(
        "/otp/verify",
        json={"email": email, "code": code, "deviceId": device_id, "platform": platform},
    )
    assert res.status_code == 200, res.text
    return res.json()


def test_otp_request_for_allowlisted_email_returns_sent(client, fresh_db):
    _allowlist("a@example.com")
    res = client.post("/otp/request", json={"email": "a@example.com"})
    assert res.status_code == 202
    assert res.json() == {"status": "sent"}


def test_otp_request_for_unknown_email_also_returns_sent(client, fresh_db):
    # Deliberately vague: must not leak allowlist membership.
    res = client.post("/otp/request", json={"email": "nobody@example.com"})
    assert res.status_code == 202
    assert res.json() == {"status": "sent"}


def test_otp_request_over_the_per_hour_limit_is_indistinguishable_from_success(client, fresh_db):
    """Being rate-limited must not be observable to an unauthenticated
    caller, because only allowlisted addresses ever reach the per-email
    limiter -- request_otp raises NotAllowlistedError first. A 429 here
    therefore confirmed "this address IS on the allowlist", handing back
    exactly the enumeration answer the deliberately-vague 202 for
    not-allowlisted addresses exists to withhold.

    The limit itself still applies; it just isn't announced. See
    test_otp_request_over_limit_stops_storing_codes for the enforcement
    half of this.
    """
    _allowlist("a@example.com")
    from app.otp import MAX_REQUESTS_PER_HOUR

    for _ in range(MAX_REQUESTS_PER_HOUR):
        assert client.post("/otp/request", json={"email": "a@example.com"}).status_code == 202

    res = client.post("/otp/request", json={"email": "a@example.com"})
    assert res.status_code == 202
    assert res.json() == {"status": "sent"}

    # ...and identical to what an address that isn't allowlisted at all gets.
    unknown = client.post("/otp/request", json={"email": "nobody@example.com"})
    assert unknown.status_code == res.status_code
    assert unknown.json() == res.json()


def test_otp_request_over_limit_stops_storing_codes(client, fresh_db):
    """The flat 202 above hides the limit from the caller; this checks it
    is still actually enforced underneath."""
    _allowlist("a@example.com")
    from app.otp import MAX_REQUESTS_PER_HOUR

    for _ in range(MAX_REQUESTS_PER_HOUR + 3):
        client.post("/otp/request", json={"email": "a@example.com"})

    stored = fresh_db.execute(
        "SELECT COUNT(*) AS n FROM otp_codes WHERE email = ?", ("a@example.com",)
    ).fetchone()["n"]
    assert stored == MAX_REQUESTS_PER_HOUR


def test_otp_request_is_rate_limited_per_source_ip(client, fresh_db):
    """The per-email limit can't see an attacker walking a list of
    addresses, and burning one known member's per-email quota from
    anywhere on the internet is itself a lockout attack."""
    from app.routers.auth import _otp_request_ip_limiter

    for i in range(_otp_request_ip_limiter.max_events + 5):
        _allowlist(f"user{i}@example.com")
        client.post("/otp/request", json={"email": f"user{i}@example.com"})

    total = fresh_db.execute("SELECT COUNT(*) AS n FROM otp_codes").fetchone()["n"]
    assert total == _otp_request_ip_limiter.max_events


def test_full_login_flow_issues_access_and_refresh_tokens(client, fresh_db):
    _allowlist("a@example.com")
    tokens = _login(client, "a@example.com")
    assert "accessToken" in tokens and "refreshToken" in tokens


def test_verify_rejects_wrong_length_code(client, fresh_db):
    _allowlist("a@example.com")
    res = client.post(
        "/otp/verify",
        json={"email": "a@example.com", "code": "123", "deviceId": "dev-1", "platform": "web"},
    )
    assert res.status_code == 400


def test_verify_rejects_wrong_code(client, fresh_db):
    _allowlist("a@example.com")
    _latest_otp_code("a@example.com")
    res = client.post(
        "/otp/verify",
        json={"email": "a@example.com", "code": "000000", "deviceId": "dev-1", "platform": "web"},
    )
    assert res.status_code == 401


def test_verify_enforces_device_cap(client, fresh_db):
    _allowlist("a@example.com")
    for i in range(DEVICE_CAP_PER_PERSON):
        _login(client, "a@example.com", device_id=f"dev-{i}")

    code = _latest_otp_code("a@example.com")
    res = client.post(
        "/otp/verify",
        json={"email": "a@example.com", "code": code, "deviceId": "dev-overflow", "platform": "web"},
    )
    assert res.status_code == 403


def test_verify_rejects_revoked_device(client, fresh_db):
    _allowlist("a@example.com")
    _login(client, "a@example.com", device_id="dev-1")
    get_db().execute("UPDATE devices SET status = 'revoked' WHERE id = 'dev-1'")
    get_db().commit()

    code = _latest_otp_code("a@example.com")
    res = client.post(
        "/otp/verify",
        json={"email": "a@example.com", "code": code, "deviceId": "dev-1", "platform": "web"},
    )
    assert res.status_code == 403


def test_refresh_issues_new_tokens_and_rotates_jti(client, fresh_db):
    _allowlist("a@example.com")
    tokens = _login(client, "a@example.com")
    old_device_row = get_device("dev-1")

    res = client.post("/token/refresh", json={"refreshToken": tokens["refreshToken"]})
    assert res.status_code == 200
    new_tokens = res.json()
    # Refresh tokens carry a jti, so rotation always changes the encoded
    # token even minted within the same second. Access tokens don't and
    # can legitimately be byte-identical to the previous one when minted
    # in the same second -- the jti check on the device row below is what
    # actually proves rotation happened.
    assert new_tokens["refreshToken"] != tokens["refreshToken"]

    new_device_row = get_device("dev-1")
    assert new_device_row["refresh_jti"] != old_device_row["refresh_jti"]


def test_old_refresh_token_is_rejected_after_rotation(client, fresh_db):
    _allowlist("a@example.com")
    tokens = _login(client, "a@example.com")

    client.post("/token/refresh", json={"refreshToken": tokens["refreshToken"]})

    # The exact fix this pass made: a rotated-away-from refresh token is
    # not silently accepted, it's treated as reuse of a leaked token.
    res = client.post("/token/refresh", json={"refreshToken": tokens["refreshToken"]})
    assert res.status_code == 401
    assert "reuse" in res.json()["detail"]


def test_refresh_reuse_revokes_every_device_on_the_account(client, fresh_db):
    _allowlist("a@example.com")
    tokens = _login(client, "a@example.com", device_id="dev-1")
    _login(client, "a@example.com", device_id="dev-2")

    client.post("/token/refresh", json={"refreshToken": tokens["refreshToken"]})
    client.post("/token/refresh", json={"refreshToken": tokens["refreshToken"]})  # reuse

    assert get_device("dev-1")["status"] == "revoked"
    assert get_device("dev-2")["status"] == "revoked"


def test_refresh_rejects_revoked_device(client, fresh_db):
    _allowlist("a@example.com")
    tokens = _login(client, "a@example.com")
    get_db().execute("UPDATE devices SET status = 'revoked' WHERE id = 'dev-1'")
    get_db().commit()

    res = client.post("/token/refresh", json={"refreshToken": tokens["refreshToken"]})
    assert res.status_code == 401


def test_refresh_rejects_access_token(client, fresh_db):
    _allowlist("a@example.com")
    tokens = _login(client, "a@example.com")
    res = client.post("/token/refresh", json={"refreshToken": tokens["accessToken"]})
    assert res.status_code == 401


def test_refresh_rejects_garbage_token(client, fresh_db):
    res = client.post("/token/refresh", json={"refreshToken": "not-a-real-token"})
    assert res.status_code == 401
