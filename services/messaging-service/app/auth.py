import os

import jwt
from fastapi import Header, HTTPException

from app.db import get_auth_db

_PLACEHOLDER_SECRETS = frozenset(
    {"change_me_to_a_long_random_secret", "changeme", "change_me", "secret", "devkey"}
)
MIN_SECRET_LENGTH = 32


def validate_secrets() -> None:
    """Fails startup rather than serving forgeable tokens. JWT_SECRET is the
    same value auth-service signs with -- this service only verifies."""
    value = os.environ.get("JWT_SECRET")
    if not value:
        raise RuntimeError("JWT_SECRET is not set; refusing to start")
    if value.strip().lower() in _PLACEHOLDER_SECRETS:
        raise RuntimeError("JWT_SECRET is still the placeholder from .env.example; refusing to start")
    if len(value) < MIN_SECRET_LENGTH:
        raise RuntimeError(
            f"JWT_SECRET must be at least {MIN_SECRET_LENGTH} characters; refusing to start"
        )


def _secret() -> str:
    return os.environ["JWT_SECRET"]


def is_device_active(device_id: str, email: str) -> bool:
    row = get_auth_db().execute("SELECT email, status FROM devices WHERE id = ?", (device_id,)).fetchone()
    return row is not None and row["email"] == email and row["status"] == "active"


def is_allowlisted(email: str) -> bool:
    row = get_auth_db().execute("SELECT 1 FROM allowlist WHERE email = ?", (email.lower(),)).fetchone()
    return row is not None


def verify_access_token(token: str) -> tuple[str, str]:
    """Returns (email, device_id). Raises 401 on anything invalid, including
    a valid unexpired token whose device has since been revoked."""
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
