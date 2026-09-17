"""Room naming and room-token authorization (§4).

The property under test throughout: a caller can only ever obtain a join
grant for a room whose name is derived from a participant set they are
part of. Before this, `roomName` was a free-form string echoed straight
into the LiveKit grant, so any active device could join any call it could
guess the name of -- and an uninvited participant LiveKit accepts is a
legitimate room member as far as §6.1's key rotation is concerned.
"""
from tests.conftest import access_token_for, register_device

from app.rooms import canonical_room_name


def _members(db, *emails: str) -> None:
    for i, email in enumerate(emails):
        register_device(db, email, f"dev-{i}")


def test_canonical_room_name_is_order_and_case_independent():
    a = canonical_room_name(["a@example.com", "b@example.com"])
    b = canonical_room_name(["B@Example.com", "  a@example.com  "])
    assert a == b


def test_canonical_room_name_differs_by_participant_set():
    pair = canonical_room_name(["a@example.com", "b@example.com"])
    trio = canonical_room_name(["a@example.com", "b@example.com", "c@example.com"])
    other = canonical_room_name(["a@example.com", "c@example.com"])
    assert len({pair, trio, other}) == 3


def test_canonical_room_name_does_not_leak_member_addresses():
    """Room names reach LiveKit's logs and our own metrics labels."""
    name = canonical_room_name(["alice@example.com", "bob@example.com"])
    assert "alice" not in name and "bob" not in name and "@" not in name


def test_both_participants_derive_the_same_room(client, fresh_db):
    _members(fresh_db, "a@example.com", "b@example.com")

    from_a = client.post(
        "/room/token",
        json={"participants": ["b@example.com"]},
        headers={"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-0')}"},
    ).json()
    from_b = client.post(
        "/room/token",
        json={"participants": ["a@example.com"]},
        headers={"Authorization": f"Bearer {access_token_for('b@example.com', 'dev-1')}"},
    ).json()

    assert from_a["roomName"] == from_b["roomName"]


def test_outsider_cannot_obtain_a_token_for_someone_elses_room(client, fresh_db):
    """The core regression. An allowlisted member who is NOT on the call
    must not be able to get a grant for the call's room -- and since they
    no longer choose the name, there's no request they can make that
    produces one."""
    _members(fresh_db, "a@example.com", "b@example.com", "eve@example.com")

    private_room = client.post(
        "/room/token",
        json={"participants": ["b@example.com"]},
        headers={"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-0')}"},
    ).json()["roomName"]

    eve_token = access_token_for("eve@example.com", "dev-2")
    for attempt in (
        {"participants": ["a@example.com"]},
        {"participants": ["a@example.com", "b@example.com"]},
        {"participants": ["b@example.com"]},
    ):
        res = client.post("/room/token", json=attempt, headers={"Authorization": f"Bearer {eve_token}"})
        assert res.status_code == 200
        assert res.json()["roomName"] != private_room, (
            "eve derived a room she is not part of -- her own address must always "
            "be folded into the participant set"
        )


def test_naming_a_non_member_is_rejected(client, fresh_db):
    _members(fresh_db, "a@example.com")
    res = client.post(
        "/room/token",
        json={"participants": ["stranger@example.com"]},
        headers={"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-0')}"},
    )
    assert res.status_code == 400
    assert "stranger@example.com" in res.json()["detail"]


def test_room_token_grant_is_scoped_to_the_derived_room(client, fresh_db):
    import base64
    import json

    _members(fresh_db, "a@example.com", "b@example.com")
    body = client.post(
        "/room/token",
        json={"participants": ["b@example.com"]},
        headers={"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-0')}"},
    ).json()

    payload = body["roomToken"].split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload))

    assert claims["video"]["room"] == body["roomName"]
    assert claims["video"]["roomJoin"] is True
    # Never an admin grant -- a join token must not be able to list or
    # manipulate rooms it isn't in.
    assert not claims["video"].get("roomAdmin")
    assert not claims["video"].get("roomList")


def test_participant_cap_is_enforced(client, fresh_db):
    _members(fresh_db, "a@example.com", "b@example.com", "c@example.com",
             "d@example.com", "e@example.com", "f@example.com")
    res = client.post(
        "/room/token",
        json={"participants": [
            "b@example.com", "c@example.com", "d@example.com", "e@example.com", "f@example.com",
        ]},
        headers={"Authorization": f"Bearer {access_token_for('a@example.com', 'dev-0')}"},
    )
    assert res.status_code == 400
