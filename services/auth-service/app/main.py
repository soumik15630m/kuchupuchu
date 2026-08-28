from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI

from app.routers import auth as auth_router
from app.routers import room as room_router

app = FastAPI(title="auth-service", version="0.1.0")


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


# Mounted at "/" and "/room" here; nginx strips the "/auth/" prefix it
# receives from clients (see infra/nginx/conf.d/app.conf.template), so the
# public paths end up as /auth/otp/request, /auth/room/token, etc.
app.include_router(auth_router.router)
app.include_router(room_router.router, prefix="/room")
