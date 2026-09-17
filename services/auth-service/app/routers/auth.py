import os
from typing import Literal

import jwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field

from app.devices import (
    DeviceLimitReachedError,
    DeviceNotFoundError,
    DeviceRevokedError,
    get_device,
    is_device_active,
    register_or_touch_device,
    revoke_all_devices,
    set_refresh_jti,
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
from app.rate_limit import SlidingWindowLimiter, register
from app.session_tokens import sign_access_token, sign_refresh_token, verify_token

router = APIRouter()

# 20/hour per source IP. Generous for a household of <=10 people behind
# one NAT retrying a few logins, restrictive enough that walking a list of
# candidate addresses, or burning one member's per-email quota, stops
# being free. See otp_request for why the per-email limit doesn't cover
# either case.
_otp_request_ip_limiter = register(
    SlidingWindowLimiter(max_events=20, window_seconds=3600, name="otp_request_ip")
)


# Trustworthy only behind this repo's nginx, which overwrites whatever
# the client sent. Reached directly it is attacker-supplied, and an
# IP-keyed limit that trusts it is bypassed by varying one header.
_TRUST_PROXY_HEADERS = os.environ.get("TRUST_PROXY_HEADERS", "true").strip().lower() in ("1", "true", "yes")


def _client_ip(request: Request) -> str:
    """The caller's IP: nginx's X-Real-IP when proxy headers are trusted,
    otherwise the socket peer address."""
    if _TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-real-ip")
        if forwarded:
            return forwarded.strip()
    return request.client.host if request.client else "unknown"


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
def otp_request(request: Request, body: OtpRequestBody):
    # Per-IP limit, on top of otp.py's per-email one. The per-email limit
    # can't see an attacker walking a list of addresses, and it's also
    # the thing an attacker abuses: burning a known member's 5-per-hour
    # quota from anywhere on the internet locks that person out of
    # logging in. nginx's limit_req bounds raw request rate (10r/s), which
    # is far too coarse to notice either.
    if not _otp_request_ip_limiter.check(_client_ip(request)):
        raise HTTPException(status_code=429, detail="too many requests, try again later")

    try:
        code = request_otp(body.email)
        send_otp_email(body.email, code)
    except NotAllowlistedError:
        # Deliberately vague response — don't confirm/deny which emails are
        # on the allowlist to an unauthenticated caller.
        pass
    except RateLimitedError:
        # Also 202. Only allowlisted addresses reach the per-email
        # limiter at all, so a 429 confirmed membership -- the exact
        # answer the vague 202 above exists to withhold.
        pass
    return {"status": "sent"}


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

    refresh_token, jti = sign_refresh_token(normalized_email, body.deviceId)
    set_refresh_jti(body.deviceId, jti)
    return {
        "accessToken": sign_access_token(normalized_email, body.deviceId),
        "refreshToken": refresh_token,
    }


@router.post("/token/refresh")
def token_refresh(body: RefreshBody):
    try:
        payload = verify_token(body.refreshToken)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="invalid or expired refresh token")

    if payload["type"] != "refresh":
        raise HTTPException(status_code=401, detail="not a refresh token")

    email, device_id = payload["sub"], payload["did"]

    # §4: revoked/expired devices can't ride out a still-valid refresh
    # token to mint fresh ones.
    if not device_id or not is_device_active(device_id, email):
        raise HTTPException(status_code=401, detail="device revoked or expired; log in again")

    # §4 refresh-token rotation: a device only ever has one valid refresh
    # token at a time. A token whose jti doesn't match the one on record was
    # already rotated away from on a prior refresh -- presenting it again
    # means it leaked, so the whole family gets killed rather than honored.
    # `refresh_jti` is unset for sessions issued before this check existed;
    # those get one free pass through, same backward-compat posture as the
    # "did" field before it.
    device = get_device(device_id)
    stored_jti = device["refresh_jti"] if device else None
    if stored_jti and payload["jti"] != stored_jti:
        revoke_all_devices(email, trigger="refresh_reuse")
        raise HTTPException(
            status_code=401,
            detail="refresh token reuse detected; all devices revoked, log in again",
        )

    # §4 web-identity heartbeat: "piggybacked on the existing 15-minute
    # token refresh, no new traffic." Harmless no-op for Android devices,
    # which don't need it, but there's no reason to special-case them out.
    touch_heartbeat(device_id)

    new_refresh_token, new_jti = sign_refresh_token(email, device_id)
    set_refresh_jti(device_id, new_jti)
    return {
        "accessToken": sign_access_token(email, device_id),
        "refreshToken": new_refresh_token,
    }
