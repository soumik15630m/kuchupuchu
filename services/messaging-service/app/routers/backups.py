import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from app.auth import require_device
from app.backups import (
    MAX_BACKUP_BYTES,
    BackupTooLargeError,
    backup_meta,
    delete_backup,
    read_backup,
    store_backup,
)

router = APIRouter()


@router.put("")
async def upload(request: Request, caller: tuple[str, str] = Depends(require_device)):
    """Stores a member's encrypted history backup, replacing any previous one.

    The body is opaque: AES-GCM ciphertext under a key derived on the device
    from a passphrase that is never sent here. This service can report its
    size and hand it back; it cannot read a byte of it.
    """
    email, device_id = caller

    # Read with a ceiling rather than calling request.body(): an oversized
    # upload should be refused without first buffering all of it in memory.
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BACKUP_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"backup exceeds the {MAX_BACKUP_BYTES // (1024 * 1024)}MB limit",
            )
        chunks.append(chunk)

    data = b"".join(chunks)
    if not data:
        raise HTTPException(status_code=400, detail="backup is empty")

    try:
        meta = await asyncio.to_thread(
            store_backup, email=email, device_id=device_id, data=data
        )
    except BackupTooLargeError as e:
        raise HTTPException(status_code=413, detail=str(e))
    return meta


@router.get("/meta")
async def meta(caller: tuple[str, str] = Depends(require_device)):
    """Size and date, so the UI can offer a restore without downloading."""
    email, _ = caller
    found = await asyncio.to_thread(backup_meta, email)
    if found is None:
        return {"exists": False}
    return {"exists": True, **found}


@router.get("")
async def download(caller: tuple[str, str] = Depends(require_device)):
    email, _ = caller
    data = await asyncio.to_thread(read_backup, email)
    if data is None:
        raise HTTPException(status_code=404, detail="no backup stored")
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


@router.delete("")
async def remove(caller: tuple[str, str] = Depends(require_device)):
    email, _ = caller
    existed = await asyncio.to_thread(delete_backup, email)
    if not existed:
        raise HTTPException(status_code=404, detail="no backup stored")
    return {"deleted": True}
