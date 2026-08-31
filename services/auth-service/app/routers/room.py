from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel, Field

from app.auth_deps import require_active_device
from app.media_credentials import mint_room_token, mint_turn_credentials
import os

router = APIRouter()


class RoomTokenBody(BaseModel):
    roomName: str = Field(min_length=1, max_length=128)


@router.post("/token")
def room_token(body: RoomTokenBody, authorization: str | None = Header(default=None)):
    email, device_id = require_active_device(authorization)

    return {
        "roomToken": mint_room_token(device_id, email, body.roomName),
        "livekitUrl": os.environ.get("LIVEKIT_URL"),
        "turnCredentials": mint_turn_credentials(email),
    }
