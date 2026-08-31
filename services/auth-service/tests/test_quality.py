"""§13 Phase 3: /quality/* endpoint tests.

Covers the specific gaps that were flagged in review:
  - device-active auth check (not just token validity)
  - device_id ownership check on report bodies
  - input validation (bounded strings, enum fields, numeric ranges)
  - per-device rate limiting
"""
from tests.conftest import access_token_for, register_device


def _valid_report(device_id: str, **overrides) -> dict:
    body = {
        "room_name": "test-room",
        "device_id": device_id,
        "connection_quality": "good",
        "candidate_type": "relay",
        "relay_protocol": "tls",
        "rtt_ms": 120.5,
        "jitter_ms": 15.0,
        "packet_loss_pct": 1.2,
        "data_saver_on": False,
        "audio_only": False,
    }
    body.update(overrides)
    return body


def test_report_requires_auth(client):
    res = client.post("/quality/report", json=_valid_report("dev-1"))
    assert res.status_code == 401


def test_report_rejects_bad_token(client):
    res = client.post(
        "/quality/report",
        json=_valid_report("dev-1"),
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert res.status_code == 401


def test_report_accepted_and_visible_in_recent(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    token = access_token_for("a@example.com", "dev-1")
    headers = {"Authorization": f"Bearer {token}"}

    res = client.post("/quality/report", json=_valid_report("dev-1"), headers=headers)
    assert res.status_code == 200
    assert res.json() == {"status": "recorded"}

    res = client.get("/quality/recent", headers=headers)
    assert res.status_code == 200
    reports = res.json()["reports"]
    assert len(reports) == 1
    assert reports[0]["room_name"] == "test-room"
    assert reports[0]["candidate_type"] == "relay"
    assert reports[0]["relay_protocol"] == "tls"


def test_revoked_device_is_rejected_even_with_valid_token(client, fresh_db):
    """The fix this test exists for: a syntactically valid, unexpired
    token must NOT work once its device is revoked -- quality.py used to
    only check the token, not device status (§4's stated posture)."""
    register_device(fresh_db, "a@example.com", "dev-1")
    token = access_token_for("a@example.com", "dev-1")
    fresh_db.execute("UPDATE devices SET status = 'revoked' WHERE id = 'dev-1'")
    fresh_db.commit()

    res = client.post(
        "/quality/report",
        json=_valid_report("dev-1"),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 401


def test_cannot_report_on_behalf_of_another_device(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "a@example.com", "dev-2")
    token_for_dev1 = access_token_for("a@example.com", "dev-1")

    res = client.post(
        "/quality/report",
        json=_valid_report("dev-2"),  # body claims to be dev-2...
        headers={"Authorization": f"Bearer {token_for_dev1}"},  # ...but token is dev-1's
    )
    assert res.status_code == 403


def test_invalid_connection_quality_is_rejected(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    token = access_token_for("a@example.com", "dev-1")

    res = client.post(
        "/quality/report",
        json=_valid_report("dev-1", connection_quality="somewhat-bad"),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 422


def test_out_of_range_rtt_is_rejected(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    token = access_token_for("a@example.com", "dev-1")

    res = client.post(
        "/quality/report",
        json=_valid_report("dev-1", rtt_ms=-5),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 422


def test_oversized_room_name_is_rejected(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    token = access_token_for("a@example.com", "dev-1")

    res = client.post(
        "/quality/report",
        json=_valid_report("dev-1", room_name="x" * 200),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 422


def test_rate_limit_kicks_in_after_max_reports(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    token = access_token_for("a@example.com", "dev-1")
    headers = {"Authorization": f"Bearer {token}"}

    # _RATE_LIMIT_MAX_REPORTS is 5 per 10s window (routers/quality.py).
    for _ in range(5):
        res = client.post("/quality/report", json=_valid_report("dev-1"), headers=headers)
        assert res.status_code == 200

    res = client.post("/quality/report", json=_valid_report("dev-1"), headers=headers)
    assert res.status_code == 429


def test_dashboard_is_publicly_reachable_shell(client):
    # The shell page itself has no auth -- only /recent (fetched
    # client-side) does. See routers/quality.py's dashboard() docstring.
    res = client.get("/quality/dashboard")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
