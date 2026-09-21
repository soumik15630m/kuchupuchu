import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

# A bare load_dotenv() walks up with no stopping point; from a git worktree
# that reaches a different checkout's .env entirely. KUCHUPUCHU_SKIP_DOTENV=1
# disables it -- a suite whose results depend on whether a .env exists on disk
# is not a suite.
_SERVICE_DIR = Path(__file__).resolve().parent.parent
if os.environ.get("KUCHUPUCHU_SKIP_DOTENV") != "1":
    for _candidate in (_SERVICE_DIR / ".env", _SERVICE_DIR.parent.parent / ".env"):
        if _candidate.is_file():
            load_dotenv(_candidate)
            break

from app.logging_config import configure_logging

# Before anything else imports a logger: without this, every logger.info and
# logger.exception in this service goes nowhere, including the one that reports
# a failed WebSocket handler.
configure_logging()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import validate_secrets
from app.db import run_migrations
from app.media import prune_expired as prune_media
from app.messages import prune_expired as prune_messages
from app.routers import media as media_router
from app.routers import messages as messages_router

logger = logging.getLogger(__name__)

RETENTION_SWEEP_INTERVAL_SECONDS = 60 * 60


async def _retention_sweep_loop() -> None:
    while True:
        await asyncio.sleep(RETENTION_SWEEP_INTERVAL_SECONDS)
        try:
            messages = await asyncio.to_thread(prune_messages)
            blobs = await asyncio.to_thread(prune_media)
            if messages or blobs:
                logger.info("retention sweep removed %d messages and %d blobs", messages, blobs)
        except Exception:
            logger.exception("retention sweep failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    validate_secrets()
    run_migrations()
    task = asyncio.create_task(_retention_sweep_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="kuchupuchu messaging-service", lifespan=lifespan)

_origins = [o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["authorization", "content-type"],
    )

app.include_router(messages_router.router)
app.include_router(media_router.router, prefix="/media")


@app.get("/healthz")
def healthz():
    return {"status": "ok"}
