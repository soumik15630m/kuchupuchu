import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal, TypedDict

import jwt

ACCESS_TTL_MIN = int(os.environ.get("JWT_ACCESS_TOKEN_TTL_MIN", "15"))
REFRESH_TTL_DAYS = int(os.environ.get("JWT_REFRESH_TOKEN_TTL_DAYS", "30"))


def _secret() -> str:
    # Own trust domain, separate from LIVEKIT_API_SECRET (which authenticates
    # server-to-LiveKit admin calls and room-token minting). Session JWTs and
    # LiveKit admin credentials must never share a key -- a leak of one must
    # not also leak the other.
    s = os.environ.get("JWT_SECRET")
    if not s:
        raise RuntimeError("Missing signing secret (JWT_SECRET)")
    return s


class SessionPayload(TypedDict):
    sub: str  # email
    did: str  # device id (§4/§13 Phase 2) — lets revocation act on one device
    type: Literal["access", "refresh"]
    jti: str  # refresh tokens only — rotation/reuse-detection id, see devices.refresh_jti


def sign_access_token(email: str, device_id: str) -> str:
    payload = {
        "sub": email,
        "did": device_id,
        "type": "access",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TTL_MIN),
    }
    return jwt.encode(payload, _secret(), algorithm="HS256")


def sign_refresh_token(email: str, device_id: str) -> tuple[str, str]:
    """Returns (token, jti). The jti is the caller's responsibility to
    persist as the device's current refresh_jti -- that's what makes
    rotation real: a refresh token presented with any other jti was
    already rotated away from and gets treated as reuse, not honored."""
    jti = secrets.token_hex(16)
    payload = {
        "sub": email,
        "did": device_id,
        "type": "refresh",
        "jti": jti,
        "exp": datetime.now(timezone.utc) + timedelta(days=REFRESH_TTL_DAYS),
    }
    return jwt.encode(payload, _secret(), algorithm="HS256"), jti


def verify_token(token: str) -> SessionPayload:
    payload = jwt.decode(token, _secret(), algorithms=["HS256"])
    # "did"/"jti" didn't exist on tokens minted before Phase 2/this rotation
    # fix. Rather than hard 401ing every outstanding session the moment this
    # ships, surface them as empty -- callers that require device/jti checks
    # reject those themselves, with a clear cause instead of a raw KeyError.
    return {
        "sub": payload["sub"],
        "did": payload.get("did", ""),
        "type": payload["type"],
        "jti": payload.get("jti", ""),
    }
