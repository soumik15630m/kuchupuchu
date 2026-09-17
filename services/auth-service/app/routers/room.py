import os

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, EmailStr, Field

from app.auth_deps import require_active_device
from app.devices import is_allowlisted
from app.media_credentials import mint_room_token, mint_turn_credentials
from app.rooms import canonical_room_name

router = APIRouter()

# §4: a room holds at most 5 participants (enforced independently by
# LiveKit via room.max_participants). Bounding the request here too keeps
# a caller from asking the server to hash an arbitrarily long list.
MAX_PARTICIPANTS = 5


class RoomTokenBody(BaseModel):
    """Who you want to call, not what to name the room.

    The room name is derived from the participant set (see app/rooms.py)
    rather than accepted from the caller, so a token can only ever be
    minted for a room the caller is actually part of.
    """

    participants: list[EmailStr] = Field(
        min_length=1,
        max_length=MAX_PARTICIPANTS,
        description="The other people on the call. The caller is included automatically.",
    )


@router.post("/token")
def room_token(body: RoomTokenBody, authorization: str | None = Header(default=None)):
    email, device_id = require_active_device(authorization)

    participants = {str(p).strip().lower() for p in body.participants}
    participants.add(email)

    if len(participants) > MAX_PARTICIPANTS:
        raise HTTPException(
            status_code=400,
            detail=f"a call can have at most {MAX_PARTICIPANTS} participants (§4)",
        )

    # Every participant must be a known member. Without this, the room
    # name could be derived from arbitrary addresses -- which wouldn't
    # grant the outsider anything (they still can't authenticate), but
    # would let a member create unbounded distinct rooms, and would make
    # the participant list in a room name meaningless as a record of who
    # a call was actually between.
    unknown = sorted(p for p in participants if not is_allowlisted(p))
    if unknown:
        # 400 with the addresses echoed back: the caller is an
        # authenticated member who just named someone, and telling them
        # "that person isn't set up" is the whole point. This is not the
        # unauthenticated enumeration surface that /otp/request is.
        raise HTTPException(
            status_code=400,
            detail=f"not known members: {', '.join(unknown)}",
        )

    room_name = canonical_room_name(sorted(participants))

    return {
        "roomName": room_name,
        "roomToken": mint_room_token(device_id, email, room_name),
        "livekitUrl": os.environ.get("LIVEKIT_URL"),
        "turnCredentials": mint_turn_credentials(device_id),
    }
