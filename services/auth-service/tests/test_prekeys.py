"""§13 Phase 4: /prekeys/* endpoint tests.

Uses real Ed25519/X25519 keypairs throughout (via `cryptography`), not
placeholder byte strings -- the whole point of this endpoint is signature
verification and exact-length validation, neither of which a fake key
would exercise honestly.
"""
import base64

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from tests.conftest import access_token_for, register_device


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def _new_identity_key() -> tuple[Ed25519PrivateKey, str]:
    sk = Ed25519PrivateKey.generate()
    pub = sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return sk, _b64(pub)


def _new_identity_dh_key(identity_sk: Ed25519PrivateKey) -> dict:
    dh_sk = X25519PrivateKey.generate()
    dh_pub = dh_sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    signature = identity_sk.sign(dh_pub)
    return {"public_key": _b64(dh_pub), "signature": _b64(signature)}


def _new_signed_prekey(identity_sk: Ed25519PrivateKey, key_id: int = 1) -> dict:
    spk_sk = X25519PrivateKey.generate()
    spk_pub = spk_sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    signature = identity_sk.sign(spk_pub)
    return {"key_id": key_id, "public_key": _b64(spk_pub), "signature": _b64(signature)}


def _new_one_time_prekey(key_id: int) -> dict:
    otk_sk = X25519PrivateKey.generate()
    otk_pub = otk_sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return {"key_id": key_id, "public_key": _b64(otk_pub)}


def _publish_body(identity_sk, identity_pub_b64, num_one_time=0, key_id=1):
    return {
        "identity_key": identity_pub_b64,
        "identity_dh_key": _new_identity_dh_key(identity_sk),
        "signed_prekey": _new_signed_prekey(identity_sk, key_id=key_id),
        "one_time_prekeys": [_new_one_time_prekey(i) for i in range(num_one_time)],
    }


def test_publish_requires_auth(client):
    identity_sk, identity_pub = _new_identity_key()
    res = client.post("/prekeys/me", json=_publish_body(identity_sk, identity_pub))
    assert res.status_code == 401


def test_publish_and_fetch_bundle_round_trip(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    register_device(fresh_db, "b@example.com", "dev-b")
    token_a = access_token_for("a@example.com", "dev-a")
    token_b = access_token_for("b@example.com", "dev-b")

    identity_sk, identity_pub = _new_identity_key()
    body = _publish_body(identity_sk, identity_pub, num_one_time=3)
    res = client.post("/prekeys/me", json=body, headers={"Authorization": f"Bearer {token_a}"})
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "unused_one_time_prekeys": 3}

    res = client.get("/prekeys/a@example.com/dev-a", headers={"Authorization": f"Bearer {token_b}"})
    assert res.status_code == 200
    bundle = res.json()
    assert bundle["identity_key"] == identity_pub
    assert bundle["identity_dh_key"]["public_key"] == body["identity_dh_key"]["public_key"]
    assert bundle["signed_prekey"]["public_key"] == body["signed_prekey"]["public_key"]
    assert bundle["one_time_prekey"]["key_id"] in {0, 1, 2}


def test_bundle_incomplete_without_identity_dh_key_is_404(client, fresh_db):
    """A device that's only ever run the pre-005 flow (identity_key +
    signed_prekey, no identity_dh_key) isn't X3DH-usable yet -- the
    bundle endpoint should say "not ready", not hand back a partial
    bundle a peer can't actually agree a session from."""
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")

    identity_sk, identity_pub = _new_identity_key()
    from app.prekeys import upload_identity_key, upload_signed_prekey

    upload_identity_key("dev-a", "a@example.com", identity_pub)
    spk = _new_signed_prekey(identity_sk)
    upload_signed_prekey("dev-a", spk["key_id"], spk["public_key"], spk["signature"])

    res = client.get("/prekeys/a@example.com/dev-a", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 404


def test_identity_dh_key_with_wrong_signature_is_rejected(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")

    real_identity_sk, identity_pub = _new_identity_key()
    other_identity_sk, _ = _new_identity_key()
    body = _publish_body(real_identity_sk, identity_pub)
    forged = _new_identity_dh_key(other_identity_sk)
    body["identity_dh_key"]["signature"] = forged["signature"]

    res = client.post("/prekeys/me", json=body, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 400


def test_changing_identity_dh_key_is_rejected(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")
    headers = {"Authorization": f"Bearer {token}"}

    identity_sk, identity_pub = _new_identity_key()
    body1 = _publish_body(identity_sk, identity_pub, key_id=1)
    client.post("/prekeys/me", json=body1, headers=headers)

    body2 = _publish_body(identity_sk, identity_pub, key_id=2)  # fresh random identity_dh_key
    res = client.post("/prekeys/me", json=body2, headers=headers)
    assert res.status_code == 409


def test_bundle_fetch_for_unpublished_device_is_404(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")
    res = client.get("/prekeys/a@example.com/dev-a", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 404


def test_one_time_prekeys_are_each_consumed_exactly_once(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    register_device(fresh_db, "b@example.com", "dev-b")
    token_a = access_token_for("a@example.com", "dev-a")
    token_b = access_token_for("b@example.com", "dev-b")

    identity_sk, identity_pub = _new_identity_key()
    body = _publish_body(identity_sk, identity_pub, num_one_time=2)
    client.post("/prekeys/me", json=body, headers={"Authorization": f"Bearer {token_a}"})

    seen_key_ids = set()
    for _ in range(2):
        res = client.get("/prekeys/a@example.com/dev-a", headers={"Authorization": f"Bearer {token_b}"})
        one_time = res.json()["one_time_prekey"]
        assert one_time is not None
        seen_key_ids.add(one_time["key_id"])

    assert seen_key_ids == {0, 1}

    # Pool exhausted -- X3DH degrades gracefully, bundle is still servable.
    res = client.get("/prekeys/a@example.com/dev-a", headers={"Authorization": f"Bearer {token_b}"})
    assert res.status_code == 200
    assert res.json()["one_time_prekey"] is None


def test_signed_prekey_with_wrong_signature_is_rejected(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")

    real_identity_sk, identity_pub = _new_identity_key()
    other_identity_sk, _ = _new_identity_key()
    body = _publish_body(real_identity_sk, identity_pub)
    # Swap in a signature produced by a *different* identity key -- the
    # public key claimed in identity_key won't verify it.
    forged = _new_signed_prekey(other_identity_sk, key_id=1)
    body["signed_prekey"]["signature"] = forged["signature"]

    res = client.post("/prekeys/me", json=body, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 400


def test_republishing_same_identity_key_is_idempotent(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")

    identity_sk, identity_pub = _new_identity_key()
    identity_dh_key = _new_identity_dh_key(identity_sk)
    body1 = _publish_body(identity_sk, identity_pub, key_id=1)
    body1["identity_dh_key"] = identity_dh_key
    res = client.post("/prekeys/me", json=body1, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200

    # Same identity key and identity_dh_key, rotated (different) signed
    # prekey -- this is the normal "top up/rotate" flow and must succeed.
    body2 = _publish_body(identity_sk, identity_pub, key_id=2)
    body2["identity_dh_key"] = identity_dh_key
    res = client.post("/prekeys/me", json=body2, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200


def test_changing_identity_key_is_rejected(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")

    identity_sk_1, identity_pub_1 = _new_identity_key()
    body1 = _publish_body(identity_sk_1, identity_pub_1)
    client.post("/prekeys/me", json=body1, headers={"Authorization": f"Bearer {token}"})

    identity_sk_2, identity_pub_2 = _new_identity_key()
    body2 = _publish_body(identity_sk_2, identity_pub_2)
    res = client.post("/prekeys/me", json=body2, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 409


def test_duplicate_one_time_key_id_is_rejected(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")
    headers = {"Authorization": f"Bearer {token}"}

    identity_sk, identity_pub = _new_identity_key()
    body = _publish_body(identity_sk, identity_pub, num_one_time=1)
    client.post("/prekeys/me", json=body, headers=headers)

    top_up = {
        "identity_key": identity_pub,
        "identity_dh_key": body["identity_dh_key"],
        "signed_prekey": _new_signed_prekey(identity_sk, key_id=2),
        "one_time_prekeys": [_new_one_time_prekey(0)],  # key_id 0 already published
    }
    res = client.post("/prekeys/me", json=top_up, headers=headers)
    assert res.status_code == 409


def test_malformed_base64_public_key_is_rejected(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")

    body = {
        "identity_key": "not-valid-base64!!",
        "signed_prekey": {"key_id": 1, "public_key": "also-not-valid!!", "signature": "nope!!"},
        "one_time_prekeys": [],
    }
    res = client.post("/prekeys/me", json=body, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 422


def test_wrong_length_public_key_is_rejected(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")

    identity_sk, identity_pub = _new_identity_key()
    body = _publish_body(identity_sk, identity_pub)
    # Truncate a well-formed base64 key down to the wrong byte length.
    body["signed_prekey"]["public_key"] = _b64(b"\x00" * 16)
    res = client.post("/prekeys/me", json=body, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 422


def test_revoked_device_cannot_publish_or_fetch(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-a")
    token = access_token_for("a@example.com", "dev-a")
    fresh_db.execute("UPDATE devices SET status = 'revoked' WHERE id = 'dev-a'")
    fresh_db.commit()

    identity_sk, identity_pub = _new_identity_key()
    res = client.post(
        "/prekeys/me",
        json=_publish_body(identity_sk, identity_pub),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 401

    res = client.get("/prekeys/a@example.com/dev-a", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401
