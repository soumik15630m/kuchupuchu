"""§4/§13 Phase 2 endpoints: device listing, revocation, and the
device-list version counter clients poll for the "changed" banner.

Scope note on who can revoke what: the design doc (§4) describes both
"revoke one device" and "revoke a person". Self-service (an authenticated
person revoking their *own* devices, e.g. "lost my phone, killing it from
my laptop") never required an admin concept and works the same as before.
Cross-person revoke (one member permanently cutting the other off) does
need one, so it's gated on the is_admin flag on the allowlist row
(migrations/006_admin_revoke.sql, granted via ADMIN_EMAILS at migration
time — see app/migrate.py) rather than exposed to every allowlisted member.
"""
from fastapi import APIRouter, Header, HTTPException

from app.auth_deps import parse_access_token
from app.devices import (
    DeviceNotFoundError,
    NotDeviceOwnerError,
    admin_revoke_device,
    get_all_device_versions,
    is_admin_email,
    list_devices_for_email,
    revoke_all_devices,
    revoke_device,
)
from app.livekit_admin import remove_participant_everywhere

router = APIRouter()


def _require_access_token(authorization: str | None) -> str:
    """Only the email, no device-status check -- a device revoking itself,
    or listing devices after being revoked elsewhere, should still work
    rather than 401ing the person out of the one screen that would explain
    why they're locked out. Shares the actual token-parsing/verification
    path with auth_deps.require_active_device via parse_access_token; only
    this device-status check is intentionally skipped.
    """
    return parse_access_token(authorization)["sub"]


def _require_admin(authorization: str | None) -> str:
    email = _require_access_token(authorization)
    if not is_admin_email(email):
        # 404, not 403 -- these routes exist for exactly one purpose and
        # confirming that to a non-admin caller is its own small leak.
        raise HTTPException(status_code=404, detail="not found")
    return email


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


@router.post("/admin/{device_id}/revoke")
async def admin_revoke_one_device(device_id: str, authorization: str | None = Header(default=None)):
    """Cross-person single-device revoke -- admin-only, see module
    docstring. Same request/response shape as the self-service version
    above, just without the ownership check."""
    _require_admin(authorization)
    try:
        row = admin_revoke_device(device_id)
    except DeviceNotFoundError:
        raise HTTPException(status_code=404, detail="no such device")

    removed_live = await remove_participant_everywhere(device_id)
    return {
        "status": "revoked",
        "deviceId": device_id,
        "email": row["email"],
        "disconnectedLiveSession": removed_live,
    }


@router.post("/admin/{email}/revoke-all")
async def admin_revoke_all_devices_for(email: str, authorization: str | None = Header(default=None)):
    """"Revoke a person" (§4), cross-person -- admin-only. Not restricted
    to allowlisted `email` values on this end -- revoke_all_devices is a
    no-op for an email with no active devices, so there's nothing to
    validate up front, and rejecting typos with a different error than
    "nothing to revoke" would just be extra surface for no benefit."""
    _require_admin(authorization)
    normalized_email = email.lower()
    device_ids = revoke_all_devices(normalized_email, trigger="admin")

    disconnected = []
    for device_id in device_ids:
        if await remove_participant_everywhere(device_id):
            disconnected.append(device_id)

    return {
        "status": "revoked",
        "email": normalized_email,
        "deviceIds": device_ids,
        "disconnectedLiveSessions": disconnected,
    }


@router.get("/versions")
def device_versions(authorization: str | None = Header(default=None)):
    """Polling-based stand-in for the wake-service push (§10.2) that
    doesn't exist until Phase 5. A client polls this for every known
    member — small allowlist (§1 cap: <=10), one round trip — to notice
    when a contact's device list changed and show the banner (§4),
    without needing a live WS/FCM channel yet."""
    _require_access_token(authorization)
    return {"versions": get_all_device_versions()}
