import asyncio

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import Response

from app.auth import is_allowlisted, require_device
from app.media import MAX_BLOB_BYTES, BlobTooLargeError, get_blob, record_download, store_blob

router = APIRouter()


@router.post("")
async def upload(
    file: UploadFile,
    audience: str = Form(...),
    caller: tuple[str, str] = Depends(require_device),
):
    """Uploads an already-encrypted blob. `audience` is a comma-separated
    list of the members allowed to fetch it; the per-file key is never sent
    here, it travels inside the message envelope."""
    email, device_id = caller

    recipients = [a.strip().lower() for a in audience.split(",") if a.strip()]
    if not recipients:
        raise HTTPException(status_code=400, detail="audience must name at least one member")
    for recipient in recipients:
        if not is_allowlisted(recipient):
            raise HTTPException(status_code=400, detail=f"not a known member: {recipient}")

    data = await file.read(MAX_BLOB_BYTES + 1)
    try:
        row = await asyncio.to_thread(
            store_blob, owner_email=email, owner_device=device_id, audience=recipients, data=data
        )
    except BlobTooLargeError as e:
        raise HTTPException(status_code=413, detail=str(e))

    return {"id": row["id"], "byte_size": row["byte_size"], "expires_at": row["expires_at"]}


@router.get("/{media_id}")
async def download(media_id: str, caller: tuple[str, str] = Depends(require_device)):
    email, _ = caller
    data = await asyncio.to_thread(get_blob, media_id, email)
    if data is None:
        # 404 whether it is missing or simply not ours -- distinguishing the
        # two would confirm a blob's existence to someone not in its audience.
        raise HTTPException(status_code=404, detail="not found")

    await asyncio.to_thread(record_download, media_id, email)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"cache-control": "no-store"},
    )
