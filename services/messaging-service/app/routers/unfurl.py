import asyncio
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from app.auth import require_device
from app.unfurl import UnfurlError, fetch_image, unfurl

router = APIRouter()
logger = logging.getLogger(__name__)

# A preview is one outbound fetch per pasted link, and a composer that types
# fast could ask for several a second. The cap is per member rather than per
# device so a second tab cannot double it.
RATE_LIMIT = 30
RATE_WINDOW_SECONDS = 60
_recent: dict[str, list[float]] = {}


def _check_rate(email: str) -> None:
    now = time.monotonic()
    hits = [t for t in _recent.get(email, []) if now - t < RATE_WINDOW_SECONDS]
    if len(hits) >= RATE_LIMIT:
        _recent[email] = hits
        raise HTTPException(status_code=429, detail="too many previews; try again shortly")
    hits.append(now)
    _recent[email] = hits


class UnfurlRequest(BaseModel):
    url: str


@router.post("")
async def preview(body: UnfurlRequest, caller: tuple[str, str] = Depends(require_device)):
    """Fetches a pasted link's metadata on the sender's behalf.

    This service sees the URL -- unavoidable, since browsers cannot read a
    third party's HTML -- but the recipient never does: the sender embeds the
    result in the encrypted envelope. Members who would rather not have links
    leave their device at all turn previews off in Privacy.
    """
    email, _ = caller
    _check_rate(email)
    try:
        result = await asyncio.to_thread(unfurl, body.url)
    except UnfurlError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception:
        logger.exception("unfurl failed for a link from %s", email)
        raise HTTPException(status_code=502, detail="that link could not be previewed")

    return {
        "url": result.url,
        "title": result.title,
        "description": result.description,
        "siteName": result.site_name,
        "imageUrl": result.image_url,
    }


@router.get("/image")
async def image(
    u: str = Query(..., description="absolute image URL from a previous preview"),
    caller: tuple[str, str] = Depends(require_device),
):
    """Returns the preview image's bytes so the sender can downscale it
    locally and put a thumbnail in the envelope. Validated from scratch
    rather than trusted because it arrived from a preview."""
    email, _ = caller
    _check_rate(email)
    try:
        fetched = await asyncio.to_thread(fetch_image, u)
    except UnfurlError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception:
        logger.exception("preview image fetch failed for %s", email)
        raise HTTPException(status_code=502, detail="that image could not be fetched")

    return Response(
        content=fetched.body,
        media_type=fetched.content_type,
        headers={"Cache-Control": "no-store"},
    )
