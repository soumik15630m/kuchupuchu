"""Username policy, reservation and the directory/lookup surface."""
import pytest

from app.usernames import (
    UsernameError,
    UsernameTakenError,
    normalize,
    set_username,
    validate,
)
from tests.conftest import access_token_for, register_device


@pytest.mark.parametrize(
    "raw",
    ["ab", "a" * 31, "has space", "has-dash", "has!bang", ".leading", "trailing.",
     "_leading", "trailing_", "double..dot", "mixed._sep", "admin", "SYSTEM", "12345", "1.2_3"],
)
def test_rejected_usernames(raw):
    with pytest.raises(UsernameError):
        validate(raw)


@pytest.mark.parametrize("raw", ["alice", "bob.smith", "a_b_c", "user123", "x" * 30])
def test_accepted_usernames(raw):
    display, normalized = validate(raw)
    assert normalized == raw.casefold()


def test_display_casing_is_kept_but_uniqueness_is_casefolded():
    display, normalized = validate("AliceSmith")
    assert display == "AliceSmith"
    assert normalized == "alicesmith"


def test_compatibility_forms_normalize_onto_the_plain_one():
    """Full-width characters must not create a lookalike second account."""
    assert normalize("ａlice") == normalize("alice")


def test_unicode_lookalikes_are_refused_outright():
    """Cyrillic 'а' renders identically to Latin 'a'; allowing it would make
    impersonation trivial in a group built on trusting names."""
    with pytest.raises(UsernameError):
        validate("аlice")


def test_claiming_a_username_then_reading_it_back(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    token = access_token_for("a@example.com", "dev-1")

    res = client.put("/users/me/username", json={"username": "Alice"},
                     headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert res.json()["username"] == "Alice"

    me = client.get("/users/me", headers={"Authorization": f"Bearer {token}"})
    assert me.json()["username"] == "Alice"


def test_a_second_member_cannot_take_the_same_username(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "b@example.com", "dev-2")

    client.put("/users/me/username", json={"username": "alice"},
               headers={"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-1')}"})
    res = client.put("/users/me/username", json={"username": "ALICE"},
                     headers={"Authorization": f"Bearer {access_token_for('b@example.com', 'dev-2')}"})
    assert res.status_code == 409


def test_reclaiming_your_own_username_is_allowed(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    headers = {"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-1')}"}

    client.put("/users/me/username", json={"username": "alice"}, headers=headers)
    client.put("/users/me/username", json={"username": "alice2"}, headers=headers)
    res = client.put("/users/me/username", json={"username": "alice"}, headers=headers)
    assert res.status_code == 200


def test_a_released_username_is_parked_against_other_members(fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "b@example.com", "dev-2")

    set_username("a@example.com", "alice")
    set_username("a@example.com", "alice2")

    # Someone else grabbing the freed handle could impersonate them to anyone
    # still addressing the old one.
    with pytest.raises(UsernameTakenError):
        set_username("b@example.com", "alice")


def test_lookup_resolves_a_username_to_its_account(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "b@example.com", "dev-2")
    client.put("/users/me/username", json={"username": "alice"},
               headers={"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-1')}"})

    res = client.get("/users/lookup/ALICE",
                     headers={"Authorization": f"Bearer {access_token_for('b@example.com', 'dev-2')}"})
    assert res.status_code == 200
    assert res.json()["email"] == "a@example.com"


def test_lookup_of_an_unknown_username_is_404(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    res = client.get("/users/lookup/nobody",
                     headers={"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-1')}"})
    assert res.status_code == 404


def test_directory_lists_every_member(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "b@example.com", "dev-2")

    res = client.get("/users/directory",
                     headers={"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-1')}"})
    assert res.status_code == 200
    assert {m["email"] for m in res.json()["members"]} == {"a@example.com", "b@example.com"}


def test_profile_fields_round_trip(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    headers = {"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-1')}"}

    res = client.put("/users/me/profile", json={"displayName": "Alice", "about": "Hello"},
                     headers=headers)
    assert res.status_code == 200
    assert res.json()["displayName"] == "Alice"
    assert res.json()["about"] == "Hello"


def test_profile_update_leaves_unset_fields_alone(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    headers = {"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-1')}"}

    client.put("/users/me/profile", json={"displayName": "Alice", "about": "Hello"}, headers=headers)
    res = client.put("/users/me/profile", json={"about": "Changed"}, headers=headers)
    assert res.json()["displayName"] == "Alice"
    assert res.json()["about"] == "Changed"


def test_these_routes_require_an_active_device(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    fresh_db.execute("UPDATE devices SET status = 'revoked' WHERE id = 'dev-1'")
    fresh_db.commit()
    headers = {"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-1')}"}

    assert client.get("/users/me", headers=headers).status_code == 401
    assert client.get("/users/directory", headers=headers).status_code == 401
