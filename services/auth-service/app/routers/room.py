from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel, Field

from app.devices import is_device_active
from app.media_credentials import mint_room_token, mint_turn_credentials
from app.session_tokens import verify_token
import os

router = APIRouter()


class RoomTokenBody(BaseModel):
    roomName: str = Field(min_length=1, max_length=128)


def _require_access_token(authorization: str | None) -> tuple[str, str]:
    """Returns (email, device_id). Raises 401 on anything invalid,
    including a syntactically-valid, unexpired token whose device has
    since been revoked (§4: "token validation includes a cheap lookup of
    the device's status in SQLite, not just signature+expiry") — this is
    what stops a revoked device from starting a *new* connection even
    within its old token's remaining lifetime; the live-session teardown
    in app/livekit_admin.py is what ends an already-open one.
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


@router.post("/token")
def room_token(body: RoomTokenBody, authorization: str | None = Header(default=None)):
    email, device_id = _require_access_token(authorization)

    return {
        "roomToken": mint_room_token(device_id, email, body.roomName),
        "livekitUrl": os.environ.get("LIVEKIT_URL"),
        "turnCredentials": mint_turn_credentials(email),
    }
