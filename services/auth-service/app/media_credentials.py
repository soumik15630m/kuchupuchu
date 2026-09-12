import base64
import hashlib
import hmac
import os
import time
from datetime import timedelta

from livekit import api


def _credentials_ttl_minutes() -> int:
    """Shared TTL for both the room token and TURN credentials (§9) --
    one knob, not two, so they can't drift out of sync with each other.
    If TURN credentials expired mid-call while the room token was still
    valid (or vice versa), that's a connection that mysteriously breaks
    partway through rather than a clean up-front failure.

    Defaults to 10 minutes ("just long enough to connect" -- the
    original comment this replaced). ROOM_TOKEN_TTL_MINUTES exists
    purely as a testing knob (§13) for scenarios where re-minting every
    10 minutes gets in the way of a longer manual test session -- not
    something to raise in a real deployment without reconsidering why
    short-lived credentials (§9) were the choice in the first place.
    """
    raw = os.environ.get("ROOM_TOKEN_TTL_MINUTES", "10")
    try:
        minutes = int(raw)
    except ValueError:
        raise ValueError(f"ROOM_TOKEN_TTL_MINUTES must be an integer number of minutes, got {raw!r}")
    if minutes <= 0:
        raise ValueError(f"ROOM_TOKEN_TTL_MINUTES must be positive, got {minutes}")
    return minutes


def mint_room_token(device_id: str, email: str, room_name: str) -> str:
    """Short-lived, room-scoped JWT room tokens (§9) — not static shared
    credentials. §4's concurrency gate (max 5) is enforced server-side by
    LiveKit itself (room.max_participants in livekit.yaml), not here; this
    just grants join permission for an allowlisted, OTP-verified identity.

    Identity (§4/§13 Phase 2): the LiveKit participant identity is the
    *device* id, not the email. A person can hold up to 2 active devices
    (§4), and revocation needs to disconnect exactly the revoked device's
    live session without touching that same person's other device that
    might be on the same call — that's only possible if each device has
    its own identity. `email` is still carried as the human-readable
    participant name for client UI.
    """
    token = (
        api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
        .with_identity(device_id)
        .with_name(email)
        .with_ttl(timedelta(minutes=_credentials_ttl_minutes()))
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
            )
        )
    )
    return token.to_jwt()


def mint_turn_credentials(device_id: str) -> dict:
    """Time-limited TURN REST-API credentials for coturn (§7.1), matching
    the `use-auth-secret` scheme configured in turnserver.conf.template.
    username = "<expiry-unix-ts>:<device_id>", password = HMAC-SHA1(username, secret), base64.
    Device-scoped, not email-scoped, matching every other identity boundary
    in this codebase (LiveKit participant identity, quality-report
    attribution, the device table itself) -- avoids leaking the caller's
    email into their own browser's webrtc-internals and coturn's access logs.
    """
    secret = os.environ["TURN_SHARED_SECRET"]
    ttl_seconds = _credentials_ttl_minutes() * 60  # matches the room token's TTL, see _credentials_ttl_minutes
    expiry = int(time.time()) + ttl_seconds
    username = f"{expiry}:{device_id}"
    password = base64.b64encode(
        hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    ).decode()

    hostname = os.environ["TURN_HOSTNAME"]
    return {
        "username": username,
        "password": password,
        "ttl": ttl_seconds,
        # Hard constraint (§7.1): hostname, never a bare IP — required for
        # the nginx SNI demux to route this correctly. Deliberately
        # TURN_HOSTNAME, not PUBLIC_HOSTNAME — see nginx.conf.template's
        # demux comment for why they must be two different hostnames.
        "uris": [
            f"turns:{hostname}:443?transport=tcp",
            f"turn:{hostname}:3478?transport=udp",
        ],
    }
