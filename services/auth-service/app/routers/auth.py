from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr, Field

from app.devices import (
    DeviceLimitReachedError,
    DeviceNotFoundError,
    DeviceRevokedError,
    is_device_active,
    register_or_touch_device,
    touch_heartbeat,
)
from app.mailer import send_otp_email
from app.otp import (
    InvalidOtpError,
    NotAllowlistedError,
    OtpExpiredError,
    RateLimitedError,
    TooManyAttemptsError,
    request_otp,
    verify_otp,
)
from app.session_tokens import sign_access_token, sign_refresh_token, verify_token

router = APIRouter()


class OtpRequestBody(BaseModel):
    email: EmailStr


class OtpVerifyBody(BaseModel):
    email: EmailStr
    code: str
    # §4/§10.3: device identity is generated client-side on first login and
    # registered here. §13 Phase 2 -- Phase 1 didn't need this since it had
    # no revocation to enforce yet.
    deviceId: str = Field(min_length=1, max_length=256)
    platform: Literal["android", "web"]


class RefreshBody(BaseModel):
    refreshToken: str


@router.post("/otp/request", status_code=202)
def otp_request(body: OtpRequestBody):
    try:
        code = request_otp(body.email)
        send_otp_email(body.email, code)
        return {"status": "sent"}
    except NotAllowlistedError:
        # Deliberately vague response — don't confirm/deny which emails are
        # on the allowlist to an unauthenticated caller.
        return {"status": "sent"}
    except RateLimitedError:
        raise HTTPException(status_code=429, detail="too many requests, try again later")


@router.post("/otp/verify")
def otp_verify(body: OtpVerifyBody):
    if len(body.code) != 6:
        raise HTTPException(status_code=400, detail="invalid request")
    try:
        verify_otp(body.email, body.code)
    except (InvalidOtpError, OtpExpiredError, TooManyAttemptsError) as e:
        raise HTTPException(status_code=401, detail=str(e))

    normalized_email = body.email.lower()
    try:
        register_or_touch_device(normalized_email, body.deviceId, body.platform)
    except DeviceRevokedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except DeviceLimitReachedError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except DeviceNotFoundError:
        # device id collided with another email's device row -- see
        # app/devices.py's register_or_touch_device docstring.
        raise HTTPException(status_code=409, detail="device id already in use")

    return {
        "accessToken": sign_access_token(normalized_email, body.deviceId),
        "refreshToken": sign_refresh_token(normalized_email, body.deviceId),
    }


@router.post("/token/refresh")
def token_refresh(body: RefreshBody):
    try:
        payload = verify_token(body.refreshToken)
    except Exception:
        raise HTTPException(status_code=401, detail="invalid or expired refresh token")

    if payload["type"] != "refresh":
        raise HTTPException(status_code=401, detail="not a refresh token")

    email, device_id = payload["sub"], payload["did"]

    # §4: revoked/expired devices can't ride out a still-valid refresh
    # token to mint fresh ones.
    if not device_id or not is_device_active(device_id, email):
        raise HTTPException(status_code=401, detail="device revoked or expired; log in again")

    # §4 web-identity heartbeat: "piggybacked on the existing 15-minute
    # token refresh, no new traffic." Harmless no-op for Android devices,
    # which don't need it, but there's no reason to special-case them out.
    touch_heartbeat(device_id)

    # §4: refresh token rotated on every use.
    return {
        "accessToken": sign_access_token(email, device_id),
        "refreshToken": sign_refresh_token(email, device_id),
    }
