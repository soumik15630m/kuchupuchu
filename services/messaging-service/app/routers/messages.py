import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, EmailStr, Field

from app.auth import is_allowlisted, require_device, verify_access_token
from app.hub import hub
from app.messages import (
    EnvelopeTooLargeError,
    mark_delivered,
    mark_read,
    pending_for_device,
    store_message,
)

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_FANOUT = 10


class Recipient(BaseModel):
    email: EmailStr
    device_id: str = Field(min_length=1, max_length=256)
    envelope: str = Field(min_length=1)


class SendBody(BaseModel):
    """One logical message, pre-encrypted once per recipient device.

    The server never combines or re-encrypts these -- each `envelope` is
    sealed for exactly one device's ratchet, and the fan-out is the client's
    because only the client can encrypt.
    """

    client_msg_id: str = Field(min_length=1, max_length=128)
    kind: str = Field(default="text", pattern="^(text|media|voice)$")
    recipients: list[Recipient] = Field(min_length=1, max_length=MAX_FANOUT)


class ReceiptBody(BaseModel):
    message_ids: list[str] = Field(default_factory=list, max_length=500)
    client_msg_ids: list[str] = Field(default_factory=list, max_length=500)


def _wire(row: dict) -> dict:
    return {
        "id": row["id"],
        "client_msg_id": row["client_msg_id"],
        "from_email": row["from_email"],
        "from_device": row["from_device"],
        "to_email": row["to_email"],
        "to_device": row["to_device"],
        "kind": row["kind"],
        "envelope": row["envelope"],
        "created_at": row["created_at"],
    }


async def _deliver(row: dict) -> None:
    """Pushes to a live socket if there is one. A device that is offline
    simply leaves the row undelivered for /pending to pick up -- that is the
    store-and-forward path, not a failure."""
    await hub.send(row["to_device"], {"type": "message", "message": _wire(row)})


@router.post("/send")
async def send(body: SendBody, caller: tuple[str, str] = Depends(require_device)):
    from_email, from_device = caller

    for recipient in body.recipients:
        if not is_allowlisted(str(recipient.email).lower()):
            raise HTTPException(status_code=400, detail=f"not a known member: {recipient.email}")

    stored = []
    for recipient in body.recipients:
        try:
            row = await asyncio.to_thread(
                store_message,
                client_msg_id=body.client_msg_id,
                from_email=from_email,
                from_device=from_device,
                to_email=str(recipient.email).lower(),
                to_device=recipient.device_id,
                kind=body.kind,
                envelope=recipient.envelope,
            )
        except EnvelopeTooLargeError as e:
            raise HTTPException(status_code=413, detail=str(e))
        stored.append(row)

    for row in stored:
        await _deliver(row)

    return {"status": "sent", "ids": [r["id"] for r in stored]}


@router.get("/pending")
async def pending(caller: tuple[str, str] = Depends(require_device)):
    _, device_id = caller
    rows = await asyncio.to_thread(pending_for_device, device_id)
    return {"messages": [_wire(r) for r in rows]}


async def _notify_senders(rows: list[dict], kind: str) -> None:
    for row in rows:
        await hub.send(
            row["from_device"],
            {"type": kind, "client_msg_id": row["client_msg_id"], "by": row.get("to_email")},
        )


@router.post("/receipts/delivered")
async def delivered(body: ReceiptBody, caller: tuple[str, str] = Depends(require_device)):
    email, device_id = caller
    rows = await asyncio.to_thread(mark_delivered, body.message_ids, device_id)
    for row in rows:
        row["to_email"] = email
    await _notify_senders(rows, "delivered")
    return {"status": "ok", "count": len(rows)}


@router.post("/receipts/read")
async def read(body: ReceiptBody, caller: tuple[str, str] = Depends(require_device)):
    email, device_id = caller
    rows = await asyncio.to_thread(mark_read, body.client_msg_ids, device_id)
    for row in rows:
        row["to_email"] = email
    await _notify_senders(rows, "read")
    return {"status": "ok", "count": len(rows)}


@router.websocket("/ws")
async def websocket(socket: WebSocket, token: str = ""):
    """Live delivery channel.

    The token arrives as a query parameter because the browser WebSocket API
    cannot set an Authorization header. That puts it in this service's own
    access log, which is why it must be the short-lived access token and never
    the refresh token.
    """
    try:
        email, device_id = verify_access_token(token)
    except HTTPException:
        await socket.close(code=4401)
        return

    await socket.accept()
    await hub.add(device_id, socket, email)

    try:
        rows = await asyncio.to_thread(pending_for_device, device_id)
        await socket.send_json({"type": "backlog", "messages": [_wire(r) for r in rows]})

        while True:
            payload = await socket.receive_json()
            kind = payload.get("type")

            if kind == "ping":
                await socket.send_json({"type": "pong"})

            elif kind == "presence":
                # The client declares whether it shares presence. Enforced
                # here rather than client-side: this service is the relay, so
                # a rule it does not apply is not a rule.
                shares = bool(payload.get("share"))
                was_visible = hub.shares(email)
                hub.set_sharing(email, shares)
                await socket.send_json(
                    {"type": "presence_snapshot", "members": hub.snapshot_for(email)}
                )
                if shares and not was_visible:
                    await hub.broadcast_presence(email, True, None)
                elif was_visible and not shares:
                    # Going private reads as going offline to everyone else,
                    # with no last-seen to remember them by.
                    hub.set_sharing(email, True)
                    await hub.broadcast_presence(email, False, None)
                    hub.set_sharing(email, False)

            elif kind == "typing":
                to_device = payload.get("to_device")
                if isinstance(to_device, str) and to_device:
                    # chat_id must be relayed: a group's indicator belongs to
                    # the group, not to the sender's 1:1 thread. It is absent
                    # for a 1:1, where the recipient derives it from from_email.
                    chat_id = payload.get("chat_id")
                    await hub.send(
                        to_device,
                        {
                            "type": "typing",
                            "from_email": email,
                            "chat_id": chat_id if isinstance(chat_id, str) and chat_id else None,
                            "stopped": bool(payload.get("stopped")),
                        },
                    )

            elif kind == "delivered":
                ids = payload.get("message_ids") or []
                if isinstance(ids, list):
                    rows = await asyncio.to_thread(mark_delivered, ids[:500], device_id)
                    for row in rows:
                        row["to_email"] = email
                    await _notify_senders(rows, "delivered")

            elif kind == "read":
                ids = payload.get("client_msg_ids") or []
                if isinstance(ids, list):
                    rows = await asyncio.to_thread(mark_read, ids[:500], device_id)
                    for row in rows:
                        row["to_email"] = email
                    await _notify_senders(rows, "read")

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("websocket handler failed for device %s", device_id)
    finally:
        await hub.remove(device_id, socket)
        # Only once the member's *last* device goes: a phone disconnecting
        # while the laptop is still connected is not "went offline".
        if not hub.is_email_online(email):
            stamp = hub.mark_seen(email)
            await hub.broadcast_presence(email, False, stamp)
