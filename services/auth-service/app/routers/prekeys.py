"""§6/§13 Phase 4 endpoints: publish a device's X3DH prekey material and
fetch another device's bundle to start a session against.

Auth: `require_active_device` on every endpoint -- same posture as
room.py/quality.py. There's no cross-device trust distinction to make
past that at this scale (§1's <=10-member allowlist): any active device
belonging to any allowlisted member can fetch any other active device's
bundle, because that's exactly what's needed to start a call with them.

The *target* device's status is checked too, not just the caller's. §4
treats revocation as the mechanism that cuts a device off; continuing to
hand out a revoked device's prekey bundle would let anyone still
establish a fresh E2EE session with it, which is precisely the
relationship revocation is meant to end.
"""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.auth_deps import require_active_device
from app.devices import is_device_active
from app.prekeys import (
    DuplicateOneTimePrekeyIdError,
    IdentityKeyMismatchError,
    InvalidPrekeySignatureError,
    NoIdentityKeyError,
    get_bundle,
    get_identity_email,
    get_identity_material,
    publish_bundle_atomically,
    unused_one_time_prekey_count,
    validate_identity_key,
    validate_signature,
    validate_x25519_public_key,
)
from app.rate_limit import SlidingWindowLimiter, register

router = APIRouter()

# Every successful bundle fetch permanently consumes one of the target's
# one-time prekeys (X3DH's whole point -- they're single-use). With no
# limit, any active device can drain a peer's entire pool of
# MAX_UNUSED_ONE_TIME_PREKEYS with a short loop of perfectly ordinary
# requests, after which every session with that peer silently falls back
# to the three-DH variant and loses the forward secrecy the one-time
# prekey was there to provide. Nothing about that degradation is visible
# to either user.
#
# Keyed on (caller device, target device): starting a call needs one
# fetch, and the client retries a transient miss three times
# (group-e2ee.js's bundleFetchRetryDelaysMs), so this is generous for
# real use while making pool exhaustion take hours instead of seconds.
_bundle_fetch_limiter = register(
    SlidingWindowLimiter(max_events=10, window_seconds=60, name="prekey_bundle_fetch")
)


def _b64_field(*, description: str) -> Field:
    # Loose length bound on the wire format itself -- the real length
    # check (exact decoded byte count) happens in app/prekeys.py's
    # validators, called below. This just keeps pydantic from accepting
    # something absurdly oversized before it gets that far.
    return Field(min_length=1, max_length=256, description=description)


class IdentityDhKeyIn(BaseModel):
    public_key: str = _b64_field(description="base64 X25519 identity-agreement public key")
    signature: str = _b64_field(description="base64 Ed25519 signature over public_key, by identity_key")

    @field_validator("public_key")
    @classmethod
    def _check_public_key(cls, v: str) -> str:
        validate_x25519_public_key(v)
        return v

    @field_validator("signature")
    @classmethod
    def _check_signature(cls, v: str) -> str:
        validate_signature(v)
        return v


class SignedPrekeyIn(BaseModel):
    key_id: int = Field(ge=0)
    public_key: str = _b64_field(description="base64 X25519 public key")
    signature: str = _b64_field(description="base64 Ed25519 signature over public_key")

    @field_validator("public_key")
    @classmethod
    def _check_public_key(cls, v: str) -> str:
        validate_x25519_public_key(v)
        return v

    @field_validator("signature")
    @classmethod
    def _check_signature(cls, v: str) -> str:
        validate_signature(v)
        return v


class OneTimePrekeyIn(BaseModel):
    key_id: int = Field(ge=0)
    public_key: str = _b64_field(description="base64 X25519 public key")

    @field_validator("public_key")
    @classmethod
    def _check_public_key(cls, v: str) -> str:
        validate_x25519_public_key(v)
        return v


class PublishBundleIn(BaseModel):
    identity_key: str = _b64_field(description="base64 Ed25519 public key")
    identity_dh_key: IdentityDhKeyIn
    signed_prekey: SignedPrekeyIn
    # Optional -- a device topping up its pool after most of its earlier
    # batch got consumed doesn't need to re-send identity_key/signed_prekey.
    one_time_prekeys: list[OneTimePrekeyIn] = Field(default_factory=list, max_length=200)

    @field_validator("identity_key")
    @classmethod
    def _check_identity_key(cls, v: str) -> str:
        validate_identity_key(v)
        return v


@router.post("/me")
def publish_bundle(body: PublishBundleIn, authorization: str | None = Header(default=None)):
    email, device_id = require_active_device(authorization)

    # All four uploads in one transaction -- see
    # publish_bundle_atomically's docstring for why a partial publish was
    # a state a client couldn't retry its way out of.
    try:
        publish_bundle_atomically(
            device_id=device_id,
            email=email,
            identity_key_b64=body.identity_key,
            identity_dh_key=(body.identity_dh_key.public_key, body.identity_dh_key.signature),
            signed_prekey=(
                body.signed_prekey.key_id,
                body.signed_prekey.public_key,
                body.signed_prekey.signature,
            ),
            one_time_prekeys=[(k.key_id, k.public_key) for k in body.one_time_prekeys],
        )
    except IdentityKeyMismatchError:
        raise HTTPException(
            status_code=409,
            detail="identity key already on file and does not match; rotate by re-provisioning the device instead",
        )
    except InvalidPrekeySignatureError:
        raise HTTPException(status_code=400, detail="a prekey signature does not verify against identity_key")
    except NoIdentityKeyError:
        raise HTTPException(status_code=500, detail="identity key upload did not persist")
    except DuplicateOneTimePrekeyIdError:
        raise HTTPException(status_code=409, detail="one or more key_ids already published by this device")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {"status": "ok", "unused_one_time_prekeys": unused_one_time_prekey_count(device_id)}


def _resolve_target(email: str, device_id: str) -> None:
    """Shared checks for the two read endpoints: the URL's email really
    owns this device, and the device is still active.

    404 on every failure, never 403 -- a caller probing with the wrong
    email, or for a device that was revoked, learns the same thing either
    way: nothing usable here. Distinguishing them would confirm that a
    given device id exists under *some* other email, or that it existed
    and was revoked.
    """
    actual_email = get_identity_email(device_id)
    if actual_email is None or actual_email != email:
        raise HTTPException(status_code=404, detail="no prekey bundle published for this device")
    if not is_device_active(device_id, actual_email):
        raise HTTPException(status_code=404, detail="no prekey bundle published for this device")


@router.get("/{email}/{device_id}")
def fetch_bundle(email: str, device_id: str, authorization: str | None = Header(default=None)):
    _, caller_device_id = require_active_device(authorization)
    _resolve_target(email, device_id)

    if not _bundle_fetch_limiter.check(f"{caller_device_id}->{device_id}"):
        raise HTTPException(
            status_code=429,
            detail="too many prekey bundle fetches for this device, slow down",
        )

    bundle = get_bundle(device_id)
    if bundle is None:
        raise HTTPException(status_code=404, detail="no prekey bundle published for this device")
    return bundle


@router.get("/{email}/{device_id}/identity")
def fetch_identity(email: str, device_id: str, authorization: str | None = Header(default=None)):
    """A device's identity key plus its signed identity-DH key, without
    consuming a one-time prekey.

    Clients use this to check that an inbound X3DH initial message
    carries the identity material the sender actually published, rather
    than trusting what the message claims about itself (see
    group-e2ee.js's _verifyClaimedIdentity -- `identity_key` is public,
    so an attacker can copy a victim's verbatim while substituting their
    own DH key, and the safety number shown to the user still matches).

    Deliberately a separate endpoint from the bundle fetch, and
    deliberately not rate-limited alongside it: it consumes nothing, and
    routing this check through the bundle endpoint would make verifying
    an inbound session request cost a one-time prekey -- turning a
    defence into a way to drain the pool it protects.
    """
    require_active_device(authorization)
    _resolve_target(email, device_id)

    identity = get_identity_material(device_id)
    if identity is None:
        raise HTTPException(status_code=404, detail="no identity published for this device")
    return identity