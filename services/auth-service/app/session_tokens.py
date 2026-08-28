import os
from datetime import datetime, timedelta, timezone
from typing import Literal, TypedDict

import jwt

ACCESS_TTL_MIN = int(os.environ.get("JWT_ACCESS_TOKEN_TTL_MIN", "15"))
REFRESH_TTL_DAYS = int(os.environ.get("JWT_REFRESH_TOKEN_TTL_DAYS", "30"))


def _secret() -> str:
    # Reused as the app's JWT signing secret for now; split into its own
    # JWT_SECRET before this leaves Phase 1 if the two ever need to rotate
    # independently.
    s = os.environ.get("LIVEKIT_API_SECRET")
    if not s:
        raise RuntimeError("Missing signing secret (LIVEKIT_API_SECRET)")
    return s


class SessionPayload(TypedDict):
    sub: str  # email
    type: Literal["access", "refresh"]


def sign_access_token(email: str) -> str:
    payload = {
        "sub": email,
        "type": "access",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TTL_MIN),
    }
    return jwt.encode(payload, _secret(), algorithm="HS256")


def sign_refresh_token(email: str) -> str:
    payload = {
        "sub": email,
        "type": "refresh",
        "exp": datetime.now(timezone.utc) + timedelta(days=REFRESH_TTL_DAYS),
    }
    return jwt.encode(payload, _secret(), algorithm="HS256")


def verify_token(token: str) -> SessionPayload:
    payload = jwt.decode(token, _secret(), algorithms=["HS256"])
    return {"sub": payload["sub"], "type": payload["type"]}
