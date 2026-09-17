"""§9/§13: room-token and TURN-credential TTL, now env-gated via
ROOM_TOKEN_TTL_MINUTES (both share one knob -- see media_credentials.py's
_credentials_ttl_minutes for why they're not independent settings).
"""
import base64
import json
import os

import pytest

import app.media_credentials as media_credentials


def _decode_jwt_payload(token: str) -> dict:
    payload_b64 = token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)  # restore stripped padding
    return json.loads(base64.urlsafe_b64decode(payload_b64))


@pytest.fixture(autouse=True)
def _turn_env(monkeypatch):
    # Long enough to satisfy session_tokens.validate_secrets, which runs
    # at app startup for any test in this module that uses the `client`
    # fixture.
    monkeypatch.setenv("TURN_SHARED_SECRET", "test-turn-secret-not-for-prod-0123456789abcdef")
    monkeypatch.setenv("TURN_HOSTNAME", "turn.test.invalid")


def test_default_ttl_is_ten_minutes_when_env_var_unset(monkeypatch):
    monkeypatch.delenv("ROOM_TOKEN_TTL_MINUTES", raising=False)
    assert media_credentials._credentials_ttl_minutes() == 10


def test_room_token_ttl_respects_env_var(monkeypatch):
    monkeypatch.setenv("ROOM_TOKEN_TTL_MINUTES", "60")
    token = media_credentials.mint_room_token("dev-a", "a@example.com", "test-room")
    payload = _decode_jwt_payload(token)
    ttl_seconds = payload["exp"] - payload["nbf"]
    assert ttl_seconds == 60 * 60


def test_room_token_ttl_defaults_to_ten_minutes(monkeypatch):
    monkeypatch.delenv("ROOM_TOKEN_TTL_MINUTES", raising=False)
    token = media_credentials.mint_room_token("dev-a", "a@example.com", "test-room")
    payload = _decode_jwt_payload(token)
    ttl_seconds = payload["exp"] - payload["nbf"]
    assert ttl_seconds == 10 * 60


def test_turn_credentials_ttl_matches_room_token_ttl(monkeypatch):
    """The whole point of sharing one env var: these must never drift
    apart from each other, or a call could have its TURN relay expire
    while the room token's still valid, or vice versa."""
    monkeypatch.setenv("ROOM_TOKEN_TTL_MINUTES", "60")
    creds = media_credentials.mint_turn_credentials("dev-a")
    assert creds["ttl"] == 60 * 60


def test_turn_credentials_username_expiry_matches_ttl(monkeypatch):
    monkeypatch.setenv("ROOM_TOKEN_TTL_MINUTES", "60")
    import time

    before = int(time.time())
    creds = media_credentials.mint_turn_credentials("dev-a")
    after = int(time.time())

    expiry = int(creds["username"].split(":")[0])
    assert before + 60 * 60 <= expiry <= after + 60 * 60


@pytest.mark.parametrize("bad_value", ["not-a-number", "", "10.5", "-5", "0"])
def test_invalid_ttl_env_var_fails_loudly_not_silently(monkeypatch, bad_value):
    """A malformed or non-positive TTL should be a startup-time error a
    deployer notices immediately, not something that silently mints
    tokens with a nonsensical or zero lifetime."""
    monkeypatch.setenv("ROOM_TOKEN_TTL_MINUTES", bad_value)
    with pytest.raises(ValueError):
        media_credentials._credentials_ttl_minutes()


def test_room_token_endpoint_reflects_env_ttl(client, fresh_db, monkeypatch):
    """End-to-end: the actual /auth/room/token response's TURN ttl field
    reflects the env var, not just the underlying function in isolation."""
    from tests.conftest import access_token_for, register_device

    monkeypatch.setenv("ROOM_TOKEN_TTL_MINUTES", "60")
    register_device(fresh_db, "a@example.com", "dev-a")
    register_device(fresh_db, "b@example.com", "dev-b")
    token = access_token_for("a@example.com", "dev-a")

    res = client.post(
        "/room/token",
        json={"participants": ["b@example.com"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["turnCredentials"]["ttl"] == 60 * 60

    payload = _decode_jwt_payload(body["roomToken"])
    assert payload["exp"] - payload["nbf"] == 60 * 60
