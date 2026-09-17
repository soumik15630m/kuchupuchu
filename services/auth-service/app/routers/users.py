"""Usernames, profiles and the member directory.

Every route requires an active device: these are the addressing and identity
surface for messaging, not the lockout-explanation screen that devices.py's
weaker check exists for.
"""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.auth_deps import require_active_device
from app.rate_limit import SlidingWindowLimiter, register
from app.usernames import (
    UsernameError,
    UsernameTakenError,
    directory,
    profile_for,
    resolve,
    set_profile,
    set_username,
    validate,
)

router = APIRouter()

# Claiming handles is the one write here worth bounding: without a limit a
# member could cycle usernames to park every good handle via the release
# cooldown.
_username_limiter = register(
    SlidingWindowLimiter(max_events=5, window_seconds=3600, name="username_change")
)


class UsernameBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)


class ProfileBody(BaseModel):
    displayName: str | None = Field(default=None, max_length=64)
    about: str | None = Field(default=None, max_length=200)


def _public(profile: dict) -> dict:
    """What another member may see. Email is included deliberately: it is this
    system's account identifier, every member is already on the same <=10
    person allowlist, and the messaging protocol addresses by it."""
    return {
        "email": profile["email"],
        "username": profile.get("username"),
        "displayName": profile.get("display_name"),
        "about": profile.get("about"),
        "profileUpdatedAt": profile.get("profile_updated_at"),
    }


@router.get("/me")
def get_me(authorization: str | None = Header(default=None)):
    email, _ = require_active_device(authorization)
    profile = profile_for(email)
    if profile is None:
        raise HTTPException(status_code=404, detail="not a known member")
    return _public(profile)


@router.put("/me/username")
def put_username(body: UsernameBody, authorization: str | None = Header(default=None)):
    email, _ = require_active_device(authorization)

    # Validate before touching the limiter. A rejected username claims nothing,
    # so counting typos against the quota would lock someone out of onboarding
    # for an hour over five misspellings -- with no way into the app, since
    # having a username is what the shell gates on.
    try:
        _, normalized = validate(body.username)
    except UsernameError as e:
        raise HTTPException(status_code=400, detail=str(e))

    current = profile_for(email)
    unchanged = current is not None and current.get("username_normalized") == normalized

    # Re-submitting the handle you already hold is idempotent, not a change.
    if not unchanged and not _username_limiter.check(email):
        raise HTTPException(status_code=429, detail="too many username changes, try again later")

    try:
        display, _ = set_username(email, body.username)
    except UsernameTakenError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except UsernameError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {"username": display}


@router.put("/me/profile")
def put_profile(body: ProfileBody, authorization: str | None = Header(default=None)):
    email, _ = require_active_device(authorization)
    set_profile(email, body.displayName, body.about)
    profile = profile_for(email)
    return _public(profile) if profile else {}


@router.get("/lookup/{username}")
def lookup(username: str, authorization: str | None = Header(default=None)):
    require_active_device(authorization)
    profile = resolve(username)
    if profile is None:
        raise HTTPException(status_code=404, detail="no member with that username")
    return _public(profile)


@router.get("/directory")
def get_directory(authorization: str | None = Header(default=None)):
    """The whole member list. See usernames.directory for why publishing this
    to authenticated members is the right call for a fixed allowlist."""
    require_active_device(authorization)
    return {"members": [_public(p) for p in directory()]}
