from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr

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
        return {
            "accessToken": sign_access_token(body.email),
            "refreshToken": sign_refresh_token(body.email),
        }
    except (InvalidOtpError, OtpExpiredError, TooManyAttemptsError) as e:
        raise HTTPException(status_code=401, detail=str(e))


@router.post("/token/refresh")
def token_refresh(body: RefreshBody):
    try:
        payload = verify_token(body.refreshToken)
    except Exception:
        raise HTTPException(status_code=401, detail="invalid or expired refresh token")

    if payload["type"] != "refresh":
        raise HTTPException(status_code=401, detail="not a refresh token")

    # §4: refresh token rotated on every use.
    return {
        "accessToken": sign_access_token(payload["sub"]),
        "refreshToken": sign_refresh_token(payload["sub"]),
    }
