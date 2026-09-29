import hmac
import os

import jwt
from fastapi import Header, HTTPException

from app.db import get_auth_db
from app.vapid import load_private_key

_PLACEHOLDER_SECRETS = frozenset(
    {"change_me_to_a_long_random_secret", "changeme", "change_me", "secret", "devkey"}
)
MIN_SECRET_LENGTH = 32


def _require_secret(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set; refusing to start")
    if value.strip().lower() in _PLACEHOLDER_SECRETS:
        raise RuntimeError(f"{name} is still the placeholder from .env.example; refusing to start")
    if len(value) < MIN_SECRET_LENGTH:
        raise RuntimeError(f"{name} must be at least {MIN_SECRET_LENGTH} characters; refusing to start")
    return value


def validate_secrets() -> None:
    """Fails startup rather than running a wake service that cannot wake
    anything. A missing VAPID key is not a degraded mode -- every push would
    be rejected by the push service, silently, forever."""
    _require_secret("JWT_SECRET")
    _require_secret("WAKE_INTERNAL_SECRET")

    private = os.environ.get("WAKE_VAPID_PRIVATE_KEY")
    public = os.environ.get("WAKE_VAPID_PUBLIC_KEY")
    if not private or not public:
        raise RuntimeError(
            "WAKE_VAPID_PRIVATE_KEY and WAKE_VAPID_PUBLIC_KEY are not set; "
            "generate a pair with `python -m app.vapid keygen`"
        )
    # Parsed at startup, not at first push: a malformed key otherwise surfaces
    # as notifications that never arrive rather than as a service that refuses
    # to start.
    load_private_key(private)

    if not os.environ.get("WAKE_VAPID_SUBJECT", "").strip():
        raise RuntimeError(
            "WAKE_VAPID_SUBJECT is not set; RFC 8292 requires a mailto: or https: "
            "contact the push service operator can reach"
        )


def _secret() -> str:
    return os.environ["JWT_SECRET"]


def is_device_active(device_id: str, email: str) -> bool:
    row = get_auth_db().execute("SELECT email, status FROM devices WHERE id = ?", (device_id,)).fetchone()
    return row is not None and row["email"] == email and row["status"] == "active"


def verify_access_token(token: str) -> tuple[str, str]:
    """Returns (email, device_id). Raises 401 on anything invalid, including a
    valid unexpired token whose device has since been revoked."""
    try:
        payload = jwt.decode(token, _secret(), algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="unauthorized")
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="unauthorized")

    email, device_id = payload.get("sub", ""), payload.get("did", "")
    if not email or not device_id or not is_device_active(device_id, email):
        raise HTTPException(status_code=401, detail="device revoked or expired; log in again")
    return email, device_id


def require_device(authorization: str | None = Header(default=None)) -> tuple[str, str]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")
    return verify_access_token(authorization[len("Bearer ") :])


def require_internal_caller(x_wake_secret: str | None = Header(default=None)) -> None:
    """Guards /wake, which is called by messaging-service and by nothing else.

    A shared secret rather than a JWT because the caller is a service, not a
    device: there is no member on whose behalf it acts, and minting a device
    token for a service would mean this service could not tell the two apart.
    Compared with compare_digest -- a timing-distinguishable check on a static
    secret is worth closing even behind a compose network.
    """
    expected = os.environ.get("WAKE_INTERNAL_SECRET", "")
    if not x_wake_secret or not expected or not hmac.compare_digest(x_wake_secret, expected):
        raise HTTPException(status_code=401, detail="unauthorized")
