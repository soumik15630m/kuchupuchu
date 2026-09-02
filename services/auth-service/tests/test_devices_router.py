"""§4/§13 Phase 2 /devices/* endpoint tests. Covers the module's own
documented exception (self-service revoke, no device-status gate on the
auth check itself) plus the ownership/not-found boundaries."""
from tests.conftest import access_token_for, register_device


def test_list_my_devices_requires_auth(client):
    res = client.get("/devices/me")
    assert res.status_code == 401


def test_list_my_devices_returns_only_the_caller_s_devices(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "b@example.com", "dev-2")
    token = access_token_for("a@example.com", "dev-1")

    res = client.get("/devices/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    ids = [d["id"] for d in res.json()["devices"]]
    assert ids == ["dev-1"]


def test_a_revoked_devices_own_token_can_still_list_and_revoke(client, fresh_db):
    """The documented exception in routers/devices.py: unlike room.py/
    quality.py, this router does NOT require the caller's own device to
    still be active -- otherwise a person revoked elsewhere couldn't reach
    the one screen that explains why."""
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "a@example.com", "dev-2")
    fresh_db.execute("UPDATE devices SET status = 'revoked' WHERE id = 'dev-1'")
    fresh_db.commit()
    token = access_token_for("a@example.com", "dev-1")

    res = client.get("/devices/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200

    res = client.post("/devices/dev-2/revoke", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200


def test_revoke_device_requires_auth(client):
    res = client.post("/devices/dev-1/revoke")
    assert res.status_code == 401


def test_revoke_own_device_succeeds(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    token = access_token_for("a@example.com", "dev-1")

    res = client.post("/devices/dev-1/revoke", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "revoked"
    assert body["deviceId"] == "dev-1"

    row = fresh_db.execute("SELECT status FROM devices WHERE id = 'dev-1'").fetchone()
    assert row["status"] == "revoked"


def test_cannot_revoke_someone_elses_device(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "b@example.com", "dev-2")
    token_for_a = access_token_for("a@example.com", "dev-1")

    res = client.post("/devices/dev-2/revoke", headers={"Authorization": f"Bearer {token_for_a}"})
    # 404, not 403 -- must not confirm dev-2 exists and belongs to someone else.
    assert res.status_code == 404

    row = fresh_db.execute("SELECT status FROM devices WHERE id = 'dev-2'").fetchone()
    assert row["status"] == "active"


def test_revoke_unknown_device_returns_404(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    token = access_token_for("a@example.com", "dev-1")

    res = client.post("/devices/no-such-device/revoke", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 404


def test_revoke_all_revokes_every_device_for_the_caller_only(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "a@example.com", "dev-2")
    register_device(fresh_db, "b@example.com", "dev-3")
    token = access_token_for("a@example.com", "dev-1")

    res = client.post("/devices/revoke-all", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert sorted(res.json()["deviceIds"]) == ["dev-1", "dev-2"]

    statuses = {
        row["id"]: row["status"]
        for row in fresh_db.execute("SELECT id, status FROM devices").fetchall()
    }
    assert statuses["dev-1"] == "revoked"
    assert statuses["dev-2"] == "revoked"
    assert statuses["dev-3"] == "active"


def test_versions_requires_auth(client):
    res = client.get("/devices/versions")
    assert res.status_code == 401


def test_versions_reflects_revocation(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    token = access_token_for("a@example.com", "dev-1")

    before = client.get("/devices/versions", headers={"Authorization": f"Bearer {token}"})
    before_version = before.json()["versions"]["a@example.com"]

    client.post("/devices/dev-1/revoke", headers={"Authorization": f"Bearer {token}"})

    after = client.get("/devices/versions", headers={"Authorization": f"Bearer {token}"})
    assert after.json()["versions"]["a@example.com"] == before_version + 1


def test_versions_includes_allowlisted_members_with_no_devices_yet(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    fresh_db.execute("INSERT OR IGNORE INTO allowlist (email) VALUES ('b@example.com')")
    fresh_db.commit()
    token = access_token_for("a@example.com", "dev-1")

    res = client.get("/devices/versions", headers={"Authorization": f"Bearer {token}"})
    assert res.json()["versions"]["b@example.com"] == 0
