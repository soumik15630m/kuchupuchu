"""§4/§13 Phase 2 endpoints: device listing, revocation, and the
device-list version counter clients poll for the "changed" banner.

Scope note on who can revoke what: the design doc (§4) describes both
"revoke one device" and "revoke a person" but doesn't define any admin
role above the allowlist itself, and this app has exactly the allowlisted
members and no separate admin concept. So both operations here are
self-service only — an authenticated person can revoke their *own*
devices (e.g. "lost my phone, killing it from my laptop"), not someone
else's. If a cross-person admin revoke ends up needed later (e.g. one
member permanently cutting the other off), that's a deliberate follow-up,
not an oversight of this pass.
"""
from fastapi import APIRouter, Header, HTTPException

from app.devices import (
    DeviceNotFoundError,
    NotDeviceOwnerError,
    get_all_device_versions,
    list_devices_for_email,
    revoke_all_devices,
    revoke_device,
)
from app.livekit_admin import remove_participant_everywhere
from app.session_tokens import verify_token

router = APIRouter()


def _require_access_token(authorization: str | None) -> str:
    """Same shape as room.py's, deliberately not shared: this router only
    ever needs the email, and importing across routers for one helper
    isn't worth the coupling. Notably does NOT re-check device status here
    — a device revoking itself, or listing devices after being revoked
    elsewhere, should still work rather than 401ing the person out of the
    one screen that would explain why they're locked out.
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
    return payload["sub"]


@router.get("/me")
def list_my_devices(authorization: str | None = Header(default=None)):
    email = _require_access_token(authorization)
    rows = list_devices_for_email(email)
    return {
        "devices": [
            {
                "id": row["id"],
                "platform": row["platform"],
                "status": row["status"],
                "lastSeenAt": row["last_seen_at"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]
    }


@router.post("/{device_id}/revoke")
async def revoke_one_device(device_id: str, authorization: str | None = Header(default=None)):
    email = _require_access_token(authorization)
    try:
        revoke_device(device_id, email)
    except DeviceNotFoundError:
        raise HTTPException(status_code=404, detail="no such device")
    except NotDeviceOwnerError:
        # Same 404 as not-found, not 403 — don't confirm to a caller that
        # a given device id belongs to someone else.
        raise HTTPException(status_code=404, detail="no such device")

    # Synchronous live-session teardown (§4 v5 fix) — awaited as part of
    # this request, not backgrounded, so there's no window where the
    # device is DB-revoked but still connected.
    removed_live = await remove_participant_everywhere(device_id)
    return {"status": "revoked", "deviceId": device_id, "disconnectedLiveSession": removed_live}


@router.post("/revoke-all")
async def revoke_all_my_devices(authorization: str | None = Header(default=None)):
    """"Revoke a person" (§4), scoped to the caller's own account — see
    module docstring for why this isn't cross-person yet."""
    email = _require_access_token(authorization)
    device_ids = revoke_all_devices(email)

    disconnected = []
    for device_id in device_ids:
        if await remove_participant_everywhere(device_id):
            disconnected.append(device_id)

    return {"status": "revoked", "deviceIds": device_ids, "disconnectedLiveSessions": disconnected}


@router.get("/versions")
def device_versions(authorization: str | None = Header(default=None)):
    """Polling-based stand-in for the wake-service push (§10.2) that
    doesn't exist until Phase 5. A client polls this for every known
    member — small allowlist (§1 cap: <=10), one round trip — to notice
    when a contact's device list changed and show the banner (§4),
    without needing a live WS/FCM channel yet."""
    _require_access_token(authorization)
    return {"versions": get_all_device_versions()}
