import asyncio
import json
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app import subscriptions
from app.auth import require_internal_caller
from app.sender import send_many

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_TARGETS = 20

# What actually travels inside the sealed payload. Note what is absent: no
# sender, no chat id, no message id, no count, no preview. The service worker
# is told only that something arrived and which kind of something, and then
# reads the real thing from the encrypted store itself.
#
# The reason field is the one concession, and it buys a lot: a ring has to
# produce a different notification from a text, and the worker cannot tell
# which without being told. A push service that logged every payload it
# forwarded -- which it can, encryption or not, by timing alone -- would learn
# "a message arrived for this subscription at this second", which it already
# knows from the request itself.
PAYLOAD_VERSION = 1


class WakeBody(BaseModel):
    device_ids: list[str] = Field(min_length=1, max_length=MAX_TARGETS)
    reason: str = Field(default="message", pattern="^(message|call|device-list)$")


@router.post("/wake", dependencies=[Depends(require_internal_caller)])
async def wake(body: WakeBody):
    """Wakes devices that are not holding a live socket.

    Called by messaging-service when store-and-forward applies. Deliberately
    tolerant: a device with no subscription is simply not woken, which is the
    normal case for a member who never granted notification permission, not an
    error worth failing a message send over.
    """
    rows = await asyncio.to_thread(subscriptions.for_devices, body.device_ids)
    if not rows:
        return {"status": "ok", "pushed": 0, "targets": 0}

    payload = json.dumps({"v": PAYLOAD_VERSION, "r": body.reason}, separators=(",", ":")).encode()
    pushed = await send_many(rows, payload, urgent=body.reason == "call")
    # Counts only -- logging which devices were woken would rebuild the
    # who-talks-to-whom-and-when record this service exists to avoid holding.
    logger.info("woke %d of %d subscribed devices", pushed, len(rows))
    return {"status": "ok", "pushed": pushed, "targets": len(rows)}
