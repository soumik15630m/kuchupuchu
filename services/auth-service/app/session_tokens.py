import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal, TypedDict

import jwt

ACCESS_TTL_MIN = int(os.environ.get("JWT_ACCESS_TOKEN_TTL_MIN", "15"))
REFRESH_TTL_DAYS = int(os.environ.get("JWT_REFRESH_TOKEN_TTL_DAYS", "30"))


# An unchanged placeholder means anyone can mint a token for any
# allowlisted email, and every other control is decoration.
_PLACEHOLDER_SECRETS = frozenset(
    {
        "change_me_to_a_long_random_secret",
        "changeme",
        "change_me",
        "secret",
        "devkey",
    }
)

MIN_SECRET_LENGTH = 32


# Read with os.environ[...] deep inside request handling (see
# media_credentials.py), where a missing one surfaces as a KeyError -> 500
# on an otherwise valid call, at the worst possible moment and with no
# indication of what's wrong. There is no reason to discover this at call
# time: it's static configuration, known at boot.
_REQUIRED_SETTINGS = ("LIVEKIT_API_KEY", "LIVEKIT_URL", "TURN_HOSTNAME")


def validate_secrets() -> None:
    """Fails startup on a missing, placeholder, or too-short secret, and
    on missing non-secret configuration the request path assumes.

    Called from main.py's lifespan so the container dies loudly at boot
    instead of serving forgeable tokens indefinitely. Deliberately not
    done lazily on first use -- by then it's already accepting traffic.
    """
    missing = [name for name in _REQUIRED_SETTINGS if not os.environ.get(name)]
    if missing:
        raise RuntimeError(f"required settings are not set: {', '.join(missing)}; refusing to start")

    for name in ("JWT_SECRET", "LIVEKIT_API_SECRET", "TURN_SHARED_SECRET"):
        value = os.environ.get(name)
        if not value:
            raise RuntimeError(f"{name} is not set; refusing to start")
        if value.strip().lower() in _PLACEHOLDER_SECRETS:
            raise RuntimeError(
                f"{name} is still set to the placeholder from .env.example; "
                "generate a real one with `openssl rand -hex 32`"
            )
        if len(value) < MIN_SECRET_LENGTH:
            raise RuntimeError(
                f"{name} is {len(value)} characters; needs at least {MIN_SECRET_LENGTH}"
            )

    # §9/.env.example: these are three independent values. Reusing one
    # means a leak of the weakest-held secret is a leak of all three
    # trust domains at once -- session forgery, LiveKit admin, and TURN
    # relay credentials.
    secrets_in_use = [os.environ[n] for n in ("JWT_SECRET", "LIVEKIT_API_SECRET", "TURN_SHARED_SECRET")]
    if len(set(secrets_in_use)) != len(secrets_in_use):
        raise RuntimeError(
            "JWT_SECRET, LIVEKIT_API_SECRET and TURN_SHARED_SECRET must be three "
            "independent values, not the same one reused"
        )


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
