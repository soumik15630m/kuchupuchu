"""Shared request-auth helpers.

Two distinct checks exist on purpose, not by accident:

- `require_active_device` (used here by room.py and quality.py): signature
  + expiry + a live lookup that the *device* is still `active`. This is
  §4's stated posture -- "token validation includes a cheap lookup of the
  device's status in SQLite, not just signature+expiry" -- so a revoked
  device can't do anything with a token that hasn't expired yet, not just
  fail to start new calls.

- `devices.py`'s router deliberately does NOT use this: it needs a device
  that's just been revoked (or was revoked elsewhere) to still be able to
  call `/devices/me` and `/devices/{id}/revoke` on its *own* other devices,
  or the person would be locked out of the one screen that explains why
  they're locked out. That's a documented exception, not an oversight --
  see routers/devices.py's `_require_access_token` docstring.

Any new endpoint that touches live call state or anything else §4 treats
as trust-sensitive should use `require_active_device`, not the weaker
token-only check.
"""
from fastapi import Header, HTTPException

from app.devices import is_device_active
from app.session_tokens import verify_token


def require_active_device(authorization: str | None) -> tuple[str, str]:
    """Returns (email, device_id). Raises 401 on anything invalid,
    including a syntactically-valid, unexpired token whose device has
    since been revoked or expired.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")
    token = authorization[len("Bearer ") :]
    try:
        payload = verify_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="unauthorized")
    if payload["type"] != "access":
        raise HTTPException(status_code=401, detail="unauthorized")

    email, device_id = payload["sub"], payload["did"]
    if not device_id or not is_device_active(device_id, email):
        raise HTTPException(status_code=401, detail="device revoked or expired; log in again")

    return email, device_id


def require_active_device_header(
    authorization: str | None = Header(default=None),
) -> tuple[str, str]:
    """FastAPI-dependency-friendly wrapper around `require_active_device`,
    for routers that want `Depends(require_active_device_header)` instead
    of taking `authorization` as a plain parameter."""
    return require_active_device(authorization)
