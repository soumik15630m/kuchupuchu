from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel, Field

from app.media_credentials import mint_room_token, mint_turn_credentials
from app.session_tokens import verify_token
import os

router = APIRouter()


class RoomTokenBody(BaseModel):
    roomName: str = Field(min_length=1, max_length=128)


def _require_access_token(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized")
    token = authorization[len("Bearer ") :]
    try:
        payload = verify_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="unauthorized")
    if payload["type"] != "access":
        raise HTTPException(status_code=401, detail="unauthorized")
    return payload["sub"]  # email


@router.post("/token")
def room_token(body: RoomTokenBody, authorization: str | None = Header(default=None)):
    email = _require_access_token(authorization)

    return {
        "roomToken": mint_room_token(email, body.roomName),
        "livekitUrl": os.environ.get("LIVEKIT_URL"),
        "turnCredentials": mint_turn_credentials(email),
    }
