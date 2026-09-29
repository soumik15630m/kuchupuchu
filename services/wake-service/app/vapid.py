"""Voluntary Application Server Identification -- RFC 8292.

A push service will not accept a POST to a subscription endpoint without
this: it is how Google and Mozilla know which application server is sending,
and how they contact its operator about a misbehaving one. The signing key is
generated once (`python -m app.vapid keygen`) and lives in the environment;
the public half also goes to the browser, which pins it into the subscription
at `pushManager.subscribe()` time.

Rotating the key therefore invalidates every existing subscription -- the
browser refuses a push signed by a key it did not subscribe with -- so the
keypair is long-lived state, not a rotating secret.
"""
from __future__ import annotations

import base64
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

# RFC 8292 §2 caps `exp` at 24 hours out. 12 gives room for a clock that
# disagrees with the push service's in either direction without ever being
# rejected as already expired.
TOKEN_TTL = timedelta(hours=12)

_PRIVATE_SCALAR_LENGTH = 32


def b64url_decode(value: str) -> bytes:
    """Push keys arrive base64url without padding, which the stdlib rejects."""
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def generate_keypair() -> tuple[str, str]:
    """Returns (private, public), both base64url. The private half is the raw
    32-byte scalar and the public half the uncompressed point -- the encoding
    the whole web-push ecosystem uses, so these values are interchangeable
    with keys produced by any other tool."""
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_numbers().private_value.to_bytes(_PRIVATE_SCALAR_LENGTH, "big")
    public = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return b64url_encode(private), b64url_encode(public)


def load_private_key(private_b64: str) -> ec.EllipticCurvePrivateKey:
    raw = b64url_decode(private_b64)
    if len(raw) != _PRIVATE_SCALAR_LENGTH:
        raise ValueError("VAPID private key must be a 32-byte base64url scalar")
    return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())


def audience_for(endpoint: str) -> str:
    """RFC 8292 §2: the `aud` claim is the push service's origin, scheme and
    host only. Including the path makes the push service reject the token."""
    parts = urlsplit(endpoint)
    if parts.scheme != "https" or not parts.netloc:
        raise ValueError(f"push endpoint must be an https URL: {endpoint!r}")
    return f"{parts.scheme}://{parts.netloc}"


def authorization_header(
    endpoint: str,
    private_b64: str,
    public_b64: str,
    subject: str,
    *,
    now: datetime | None = None,
) -> str:
    """The single `Authorization` header value, in RFC 8292 §3's one-header
    form. The older two-header (`Crypto-Key`) form is still accepted by some
    services and refused by others; this one is accepted by all of them."""
    issued = now or datetime.now(timezone.utc)
    token = jwt.encode(
        {
            "aud": audience_for(endpoint),
            "exp": int((issued + TOKEN_TTL).timestamp()),
            "sub": subject,
        },
        load_private_key(private_b64),
        algorithm="ES256",
    )
    return f"vapid t={token},k={public_b64}"


def _main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] != "keygen":
        print("usage: python -m app.vapid keygen", file=sys.stderr)
        return 2
    private, public = generate_keypair()
    print(f"WAKE_VAPID_PRIVATE_KEY={private}")
    print(f"WAKE_VAPID_PUBLIC_KEY={public}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
