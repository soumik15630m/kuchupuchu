"""Synchronous live-session teardown for revocation (§4 v5 fix).

Token-status checks only run when a client *establishes* a new connection,
so a device already mid-call or holding an open signaling connection was
never actually kicked by a DB-only revoke. This closes that gap by calling
LiveKit's RemoveParticipant for the revoked device's identity, as part of
the same revoke request -- not a background job -- so there's no window
between "marked revoked" and "actually disconnected."

Room membership isn't tracked in our own DB (nothing here needs it besides
this), so rather than add a session-tracking table just for this, we ask
LiveKit directly: scan its active rooms for the identity and remove it
wherever it's found. At this app's scale (<=10 members, <=5 participants
per room, a handful of rooms at most) that's a handful of API calls, not a
real cost.
"""
import logging
import os

import aiohttp
from livekit.api import (
    LiveKitAPI,
    ListParticipantsRequest,
    ListRoomsRequest,
    RoomParticipantIdentity,
    TwirpError,
)

logger = logging.getLogger(__name__)

# Anything network-shaped (LiveKit down, DNS hiccup, timeout) should degrade
# the same way a Twirp-level error does: log it and let the DB-side revoke
# (which already committed by the time this runs) stand on its own. A
# revoke request must never 500 just because LiveKit happens to be
# unreachable at that moment.
_LIVEKIT_UNAVAILABLE_ERRORS = (TwirpError, aiohttp.ClientError, TimeoutError, OSError)


async def remove_participant_everywhere(identity: str) -> bool:
    """Removes `identity` from any LiveKit room it currently holds a
    connection in. Returns True if it was found and removed anywhere,
    False if it wasn't in any live room (the common case -- most
    revocations don't happen mid-call). Never raises: a LiveKit-side
    problem here shouldn't block the DB-side revoke, which is what
    actually stops the device from reconnecting.
    """
    # Deliberately LIVEKIT_INTERNAL_URL, not LIVEKIT_URL -- see the comment
    # on auth-service's environment block in docker-compose.yml. LIVEKIT_URL
    # is what's handed to *external clients*; this is a server-to-server
    # call over the compose network and has no reason to go through nginx's
    # public TLS front door at all.
    url = os.environ.get("LIVEKIT_INTERNAL_URL")
    api_key = os.environ.get("LIVEKIT_API_KEY")
    api_secret = os.environ.get("LIVEKIT_API_SECRET")
    if not (url and api_key and api_secret):
        logger.warning(
            "LIVEKIT_INTERNAL_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET not set; "
            "skipping live-session teardown for %s",
            identity,
        )
        return False

    removed_from_any = False
    async with LiveKitAPI(url, api_key, api_secret) as lk:
        try:
            rooms = await lk.room.list_rooms(ListRoomsRequest(names=[]))
        except _LIVEKIT_UNAVAILABLE_ERRORS as e:
            logger.warning("list_rooms failed during revoke teardown for %s: %s", identity, e)
            return False

        for room in rooms.rooms:
            try:
                participants = await lk.room.list_participants(
                    ListParticipantsRequest(room=room.name)
                )
            except _LIVEKIT_UNAVAILABLE_ERRORS as e:
                logger.warning("list_participants(%s) failed: %s", room.name, e)
                continue

            if not any(p.identity == identity for p in participants.participants):
                continue

            try:
                await lk.room.remove_participant(
                    RoomParticipantIdentity(room=room.name, identity=identity)
                )
                removed_from_any = True
                logger.info("revoke: removed %s from live room %s", identity, room.name)
            except _LIVEKIT_UNAVAILABLE_ERRORS as e:
                logger.warning(
                    "remove_participant(%s, %s) failed: %s", room.name, identity, e
                )

    return removed_from_any
