import asyncio
import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import subscriptions
from app.auth import require_device
from app.sender import EndpointNotAllowed, check_endpoint

router = APIRouter()


class SubscribeBody(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)
    p256dh: str = Field(min_length=1, max_length=256)
    auth: str = Field(min_length=1, max_length=64)


@router.get("/key")
def vapid_key(caller: tuple[str, str] = Depends(require_device)):
    """The public half of the VAPID pair, which the browser must pin into the
    subscription it creates.

    Public by definition -- it is sent to every push service on every push --
    but still behind auth, because an unauthenticated endpoint here would let
    anyone confirm the service exists and is configured.
    """
    return {"publicKey": os.environ["WAKE_VAPID_PUBLIC_KEY"]}


@router.put("/subscription")
async def subscribe(body: SubscribeBody, caller: tuple[str, str] = Depends(require_device)):
    """Registers where to reach the calling device when it is not connected.

    PUT rather than POST: a browser may re-subscribe with the same values on
    every load, and that has to be idempotent rather than accumulating rows.
    """
    email, device_id = caller
    try:
        check_endpoint(body.endpoint)
    except EndpointNotAllowed as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        await asyncio.to_thread(
            subscriptions.put, device_id, email, body.endpoint, body.p256dh, body.auth
        )
    except subscriptions.InvalidSubscription as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "subscribed"}


@router.delete("/subscription")
async def unsubscribe(caller: tuple[str, str] = Depends(require_device)):
    """Turning background notifications off, or logging out. The row goes --
    there is no disabled state, because a stored endpoint this service has
    promised not to use is worse than no stored endpoint."""
    _, device_id = caller
    removed = await asyncio.to_thread(subscriptions.remove, device_id)
    return {"status": "unsubscribed", "removed": removed}


@router.get("/subscription")
async def status(caller: tuple[str, str] = Depends(require_device)):
    """So the settings screen can say whether *this* device is reachable,
    rather than guessing from the browser's permission state alone -- the two
    disagree whenever a subscription was dropped after a 410."""
    _, device_id = caller
    row = await asyncio.to_thread(subscriptions.get, device_id)
    return {
        "subscribed": row is not None,
        "createdAt": row["created_at"] if row else None,
        "lastPushAt": row["last_push_at"] if row else None,
    }
