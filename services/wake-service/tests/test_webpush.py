import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from app.vapid import b64url_decode, b64url_encode, load_private_key
from app.webpush import InvalidSubscriptionKeys, _seal, decrypt, encrypt

# RFC 8291 §5, verbatim. The point of pinning the RFC's own worked example is
# that a derivation with two steps transposed still round-trips against itself
# perfectly -- only an externally produced ciphertext catches it.
PLAINTEXT = b"When I grow up, I want to be a watermelon"
UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"
UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg"
AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
SALT = "DGv6ra1nlYgDCS1FRnbzlw"
EXPECTED_BODY = (
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
)


class TestAgainstTheRfcVector:
    def test_the_plaintext_is_the_one_the_rfc_encrypts(self):
        assert b64url_decode("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24") == PLAINTEXT

    def test_sealing_reproduces_the_body_printed_in_the_rfc(self):
        body = _seal(
            PLAINTEXT,
            b64url_decode(UA_PUBLIC),
            b64url_decode(AUTH_SECRET),
            salt=b64url_decode(SALT),
            as_private=load_private_key(AS_PRIVATE),
        )
        assert b64url_encode(body) == EXPECTED_BODY

    def test_the_header_carries_the_salt_record_size_and_ephemeral_key(self):
        body = b64url_decode(EXPECTED_BODY)
        assert body[:16] == b64url_decode(SALT)
        assert int.from_bytes(body[16:20], "big") == 4096
        assert body[20] == 65
        assert b64url_encode(body[21:86]) == AS_PUBLIC

    def test_the_browsers_half_recovers_the_plaintext(self):
        assert decrypt(
            b64url_decode(EXPECTED_BODY),
            load_private_key(UA_PRIVATE),
            b64url_decode(AUTH_SECRET),
        ) == PLAINTEXT


class TestEncrypt:
    def test_a_fresh_ephemeral_key_is_used_every_time(self):
        ua_public, auth_secret = b64url_decode(UA_PUBLIC), b64url_decode(AUTH_SECRET)
        first = encrypt(b"wake", ua_public, auth_secret)
        second = encrypt(b"wake", ua_public, auth_secret)
        # Same plaintext, same subscription: identical bodies would mean a
        # reused salt or ephemeral key, which is a key-reuse bug in GCM.
        assert first != second
        assert first[21:86] != second[21:86]

    def test_what_encrypt_produces_the_browser_can_read(self):
        body = encrypt(PLAINTEXT, b64url_decode(UA_PUBLIC), b64url_decode(AUTH_SECRET))
        recovered = decrypt(body, load_private_key(UA_PRIVATE), b64url_decode(AUTH_SECRET))
        assert recovered == PLAINTEXT

    def test_a_truncated_p256dh_is_refused(self):
        with pytest.raises(InvalidSubscriptionKeys):
            encrypt(b"wake", b64url_decode(UA_PUBLIC)[:40], b64url_decode(AUTH_SECRET))

    def test_a_compressed_point_is_refused(self):
        compressed = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), b64url_decode(UA_PUBLIC)
        )
        from cryptography.hazmat.primitives import serialization

        raw = compressed.public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.CompressedPoint
        )
        with pytest.raises(InvalidSubscriptionKeys):
            encrypt(b"wake", raw, b64url_decode(AUTH_SECRET))

    def test_a_wrong_length_auth_secret_is_refused(self):
        with pytest.raises(InvalidSubscriptionKeys):
            encrypt(b"wake", b64url_decode(UA_PUBLIC), b"too-short")

    def test_a_point_that_is_not_on_the_curve_is_refused(self):
        bogus = b"\x04" + b"\x01" * 64
        with pytest.raises(InvalidSubscriptionKeys):
            encrypt(b"wake", bogus, b64url_decode(AUTH_SECRET))
