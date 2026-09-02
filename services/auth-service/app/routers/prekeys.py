"""§6/§13 Phase 4 endpoints: publish a device's X3DH prekey material and
fetch another device's bundle to start a session against.

Auth: `require_active_device` on both endpoints -- same posture as
room.py/quality.py. There's no cross-device trust distinction to make
past that at this scale (§1's <=10-member allowlist): any active device
belonging to any allowlisted member can fetch any other active device's
bundle, because that's exactly what's needed to start a call with them.
"""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.auth_deps import require_active_device
from app.prekeys import (
    DuplicateOneTimePrekeyIdError,
    IdentityKeyMismatchError,
    InvalidPrekeySignatureError,
    NoIdentityKeyError,
    add_one_time_prekeys,
    get_bundle,
    unused_one_time_prekey_count,
    upload_identity_dh_key,
    upload_identity_key,
    upload_signed_prekey,
    validate_identity_key,
    validate_signature,
    validate_x25519_public_key,
)

router = APIRouter()


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

    try:
        upload_identity_key(device_id, email, body.identity_key)
    except IdentityKeyMismatchError:
        raise HTTPException(
            status_code=409,
            detail="identity key already on file and does not match; rotate by re-provisioning the device instead",
        )

    try:
        upload_identity_dh_key(device_id, body.identity_dh_key.public_key, body.identity_dh_key.signature)
    except NoIdentityKeyError:
        raise HTTPException(status_code=500, detail="identity key upload did not persist")
    except InvalidPrekeySignatureError:
        raise HTTPException(status_code=400, detail="identity_dh_key signature does not verify against identity_key")
    except IdentityKeyMismatchError:
        raise HTTPException(
            status_code=409,
            detail="identity_dh_key already on file and does not match; rotate by re-provisioning the device instead",
        )

    try:
        upload_signed_prekey(
            device_id, body.signed_prekey.key_id, body.signed_prekey.public_key, body.signed_prekey.signature
        )
    except NoIdentityKeyError:
        # Shouldn't happen given the upload above just succeeded, but
        # kept as a real error rather than assumed-impossible.
        raise HTTPException(status_code=500, detail="identity key upload did not persist")
    except InvalidPrekeySignatureError:
        raise HTTPException(status_code=400, detail="signed prekey signature does not verify against identity key")

    if body.one_time_prekeys:
        try:
            add_one_time_prekeys(
                device_id, [(k.key_id, k.public_key) for k in body.one_time_prekeys]
            )
        except DuplicateOneTimePrekeyIdError:
            raise HTTPException(status_code=409, detail="one or more key_ids already published by this device")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    return {"status": "ok", "unused_one_time_prekeys": unused_one_time_prekey_count(device_id)}


@router.get("/{email}/{device_id}")
def fetch_bundle(email: str, device_id: str, authorization: str | None = Header(default=None)):
    require_active_device(authorization)

    bundle = get_bundle(device_id)
    if bundle is None:
        raise HTTPException(status_code=404, detail="no prekey bundle published for this device")
    return bundle
