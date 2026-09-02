import asyncio
import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

import aiohttp
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.db import get_db
from app.devices import expire_stale_web_devices
from app.routers import auth as auth_router
from app.routers import devices as devices_router
from app.routers import quality as quality_router
from app.routers import room as room_router

logger = logging.getLogger(__name__)

# §4: web devices are checked for staleness on a timer, not on demand --
# there's no request that would otherwise trigger the sweep. Once an hour
# is frequent enough against a 14-day cutoff without adding meaningful load.
EXPIRY_SWEEP_INTERVAL_SECONDS = 60 * 60


async def _expiry_sweep_loop():
    while True:
        try:
            expired = expire_stale_web_devices()
            if expired:
                logger.info("web-heartbeat auto-expiry: expired %s", expired)
        except Exception:
            logger.exception("web-heartbeat auto-expiry sweep failed")
        await asyncio.sleep(EXPIRY_SWEEP_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_expiry_sweep_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="auth-service", version="0.2.0", lifespan=lifespan)


@app.get("/healthz")
async def healthz():
    # A static "ok" doesn't mean the app can actually serve a login --
    # check the dependencies OTP/token issuance actually needs.
    checks = {"sqlite": False, "livekit": False}

    try:
        get_db().execute("SELECT 1")
        checks["sqlite"] = True
    except Exception:
        logger.exception("healthz: sqlite check failed")

    livekit_url = os.environ.get("LIVEKIT_INTERNAL_URL")
    if livekit_url:
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=2)
            ) as session:
                async with session.get(f"{livekit_url}/") as resp:
                    # LiveKit's HTTP port answers (any status) as long as
                    # the process is up -- this isn't an authenticated
                    # admin call, just a reachability probe.
                    checks["livekit"] = resp.status < 500
        except Exception:
            logger.exception("healthz: livekit check failed")

    healthy = all(checks.values())
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ok" if healthy else "degraded", "checks": checks},
    )


# Mounted at "/", "/room", and "/devices" here; nginx strips the "/auth/"
# prefix it receives from clients (see infra/nginx/conf.d/app.conf.template),
# so the public paths end up as /auth/otp/request, /auth/room/token,
# /auth/devices/me, etc.
app.include_router(auth_router.router)
app.include_router(room_router.router, prefix="/room")
app.include_router(devices_router.router, prefix="/devices")
app.include_router(quality_router.router, prefix="/quality")
