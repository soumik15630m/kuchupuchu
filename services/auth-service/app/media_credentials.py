import base64
import hashlib
import hmac
import os
import time
from datetime import timedelta

from livekit import api


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
        .with_ttl(timedelta(minutes=10))  # just long enough to connect
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


def mint_turn_credentials(email: str) -> dict:
    """Time-limited TURN REST-API credentials for coturn (§7.1), matching
    the `use-auth-secret` scheme configured in turnserver.conf.template.
    username = "<expiry-unix-ts>:<email>", password = HMAC-SHA1(username, secret), base64."""
    secret = os.environ["TURN_SHARED_SECRET"]
    ttl_seconds = 600  # 10 min — same order as the room token above
    expiry = int(time.time()) + ttl_seconds
    username = f"{expiry}:{email}"
    password = base64.b64encode(
        hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    ).decode()

    hostname = os.environ["PUBLIC_HOSTNAME"]
    return {
        "username": username,
        "password": password,
        "ttl": ttl_seconds,
        # Hard constraint (§7.1): hostname, never a bare IP — required for
        # the nginx SNI demux to route this correctly.
        "uris": [
            f"turns:{hostname}:443?transport=tcp",
            f"turn:{hostname}:3478?transport=udp",
        ],
    }
