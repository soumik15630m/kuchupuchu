"""Message Encryption for Web Push -- RFC 8291, with the RFC 8188 framing.

Written out rather than pulled from a library because the whole path is
"encrypt, POST, and never find out whether it worked": a push service answers
201 to a body it cannot decrypt, and the only symptom of a wrong derivation is
that notifications silently never arrive. The steps below follow RFC 8291 §3.1
in order so they can be checked against it line by line, and the test suite
pins them against the worked example in RFC 8291 §5.

The payload this service actually sends is a fixed wake signal with no sender,
no chat and no content (see `routers/wake.py`). The encryption still matters:
it is what stops the push service -- Google, Mozilla, Apple -- from reading
even that, and RFC 8291 is not optional for aes128gcm subscriptions anyway.
"""
from __future__ import annotations

import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# RFC 8188 §2: the record size covers the plaintext, its delimiter octet and
# the 16-byte GCM tag. A wake signal is a few dozen bytes, so one record is
# always enough; this only has to be larger than that and is the value every
# other implementation uses.
RECORD_SIZE = 4096

_UNCOMPRESSED_POINT_LENGTH = 65
_AUTH_SECRET_LENGTH = 16


class InvalidSubscriptionKeys(ValueError):
    """The p256dh or auth value from the browser is not usable."""


def _hkdf(*, salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(plaintext: bytes, ua_public: bytes, auth_secret: bytes) -> bytes:
    """Seals `plaintext` for one subscription.

    `ua_public` is the subscription's p256dh key as an uncompressed P-256
    point; `auth_secret` is its 16-byte auth value. Both come from
    `PushSubscription.getKey()` in the browser.
    """
    if len(ua_public) != _UNCOMPRESSED_POINT_LENGTH or ua_public[0] != 0x04:
        raise InvalidSubscriptionKeys("p256dh must be a 65-byte uncompressed P-256 point")
    if len(auth_secret) != _AUTH_SECRET_LENGTH:
        raise InvalidSubscriptionKeys("auth secret must be 16 bytes")

    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    except ValueError as exc:
        raise InvalidSubscriptionKeys("p256dh is not a point on P-256") from exc

    return _seal(
        plaintext,
        ua_public,
        auth_secret,
        salt=os.urandom(16),
        as_private=ec.generate_private_key(ec.SECP256R1()),
    )


def _seal(
    plaintext: bytes,
    ua_public: bytes,
    auth_secret: bytes,
    *,
    salt: bytes,
    as_private: ec.EllipticCurvePrivateKey,
) -> bytes:
    """The derivation itself, with the two random inputs passed in.

    Split out so the suite can drive it with RFC 8291 §5's fixed salt and
    ephemeral key and compare against the body printed in the RFC. Testing
    only `encrypt` against `decrypt` would pass just as happily with two
    derivation steps swapped, which is the exact mistake worth catching.
    """
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    as_public = as_private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    ecdh_secret = as_private.exchange(ec.ECDH(), ua_key)

    # RFC 8291 §3.3. The subscription's auth secret is the *salt* here and the
    # ECDH output the IKM -- the reverse of the intuitive reading, and the
    # single easiest step to get backwards. The result is then the IKM for the
    # RFC 8188 derivation below, not a content key itself.
    key_info = b"WebPush: info\x00" + ua_public + as_public
    ikm = _hkdf(salt=auth_secret, ikm=ecdh_secret, info=key_info, length=32)

    # RFC 8188 §2.2: the info strings are NUL-terminated, and the trailing NUL
    # is part of the input. Omitting it derives a different, wrong key.
    cek = _hkdf(salt=salt, ikm=ikm, info=b"Content-Encoding: aes128gcm\x00", length=16)
    nonce = _hkdf(salt=salt, ikm=ikm, info=b"Content-Encoding: nonce\x00", length=12)

    # 0x02 marks the last record (0x01 would mean "more follow"). A receiver
    # that sees 0x01 on the final record rejects the whole payload.
    ciphertext = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)

    header = (
        salt
        + RECORD_SIZE.to_bytes(4, "big")
        + len(as_public).to_bytes(1, "big")
        + as_public
    )
    return header + ciphertext


def decrypt(body: bytes, ua_private: ec.EllipticCurvePrivateKey, auth_secret: bytes) -> bytes:
    """The receiving half. Not used in production -- the browser does this --
    but without it the encryption above can only be tested against itself,
    which would pass just as happily with two steps swapped."""
    salt, rest = body[:16], body[16:]
    id_length = rest[4]
    as_public = rest[5 : 5 + id_length]
    ciphertext = rest[5 + id_length :]

    ua_public = ua_private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    ecdh_secret = ua_private.exchange(
        ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public)
    )

    key_info = b"WebPush: info\x00" + ua_public + as_public
    ikm = _hkdf(salt=auth_secret, ikm=ecdh_secret, info=key_info, length=32)
    cek = _hkdf(salt=salt, ikm=ikm, info=b"Content-Encoding: aes128gcm\x00", length=16)
    nonce = _hkdf(salt=salt, ikm=ikm, info=b"Content-Encoding: nonce\x00", length=12)

    padded = AESGCM(cek).decrypt(nonce, ciphertext, None)
    return padded[:-1]
