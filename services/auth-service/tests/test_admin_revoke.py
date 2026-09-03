"""§4 cross-person admin revoke: admin-gated endpoints separate from the
self-service ones already covered in test_devices_router.py."""
from tests.conftest import access_token_for, register_device


def _make_admin(db, email: str) -> None:
    db.execute("INSERT OR IGNORE INTO allowlist (email) VALUES (?)", (email,))
    db.execute("UPDATE allowlist SET is_admin = 1 WHERE email = ?", (email,))
    db.commit()


def test_admin_revoke_requires_auth(client):
    res = client.post("/devices/admin/dev-1/revoke")
    assert res.status_code == 401


def test_non_admin_cannot_use_admin_revoke(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "b@example.com", "dev-2")
    token = access_token_for("a@example.com", "dev-1")

    res = client.post("/devices/admin/dev-2/revoke", headers={"Authorization": f"Bearer {token}"})
    # 404, not 403 -- must not confirm the endpoint's purpose to a non-admin.
    assert res.status_code == 404
    row = fresh_db.execute("SELECT status FROM devices WHERE id = 'dev-2'").fetchone()
    assert row["status"] == "active"


def test_admin_can_revoke_someone_elses_device(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-admin")
    _make_admin(fresh_db, "a@example.com")
    register_device(fresh_db, "b@example.com", "dev-2")
    admin_token = access_token_for("a@example.com", "dev-admin")

    res = client.post(
        "/devices/admin/dev-2/revoke", headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["deviceId"] == "dev-2"
    assert body["email"] == "b@example.com"

    row = fresh_db.execute("SELECT status FROM devices WHERE id = 'dev-2'").fetchone()
    assert row["status"] == "revoked"


def test_admin_revoke_unknown_device_returns_404(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-admin")
    _make_admin(fresh_db, "a@example.com")
    admin_token = access_token_for("a@example.com", "dev-admin")

    res = client.post(
        "/devices/admin/no-such-device/revoke", headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert res.status_code == 404


def test_admin_revoke_all_for_email_requires_admin(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-1")
    register_device(fresh_db, "b@example.com", "dev-2")
    token = access_token_for("a@example.com", "dev-1")

    res = client.post(
        "/devices/admin/b@example.com/revoke-all", headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 404
    row = fresh_db.execute("SELECT status FROM devices WHERE id = 'dev-2'").fetchone()
    assert row["status"] == "active"


def test_admin_revoke_all_for_email_revokes_only_that_person(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-admin")
    _make_admin(fresh_db, "a@example.com")
    register_device(fresh_db, "b@example.com", "dev-2")
    register_device(fresh_db, "b@example.com", "dev-3")
    register_device(fresh_db, "c@example.com", "dev-4")
    admin_token = access_token_for("a@example.com", "dev-admin")

    res = client.post(
        "/devices/admin/b@example.com/revoke-all",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert res.status_code == 200
    assert sorted(res.json()["deviceIds"]) == ["dev-2", "dev-3"]

    statuses = {
        row["id"]: row["status"]
        for row in fresh_db.execute("SELECT id, status FROM devices").fetchall()
    }
    assert statuses["dev-2"] == "revoked"
    assert statuses["dev-3"] == "revoked"
    assert statuses["dev-4"] == "active"


def test_admin_revoke_all_for_unknown_email_is_a_harmless_noop(client, fresh_db):
    register_device(fresh_db, "a@example.com", "dev-admin")
    _make_admin(fresh_db, "a@example.com")
    admin_token = access_token_for("a@example.com", "dev-admin")

    res = client.post(
        "/devices/admin/nobody@example.com/revoke-all",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert res.status_code == 200
    assert res.json()["deviceIds"] == []


def test_migrate_seed_admins_requires_allowlist_membership_first(fresh_db):
    from app.migrate import seed_admins

    import pytest

    with pytest.raises(RuntimeError):
        import os

        os.environ["ADMIN_EMAILS"] = "not-on-allowlist@example.com"
        try:
            seed_admins(fresh_db)
        finally:
            del os.environ["ADMIN_EMAILS"]


def test_migrate_seed_admins_grants_the_flag(fresh_db):
    import os

    from app.migrate import seed_admins

    fresh_db.execute("INSERT OR IGNORE INTO allowlist (email) VALUES ('a@example.com')")
    fresh_db.commit()

    os.environ["ADMIN_EMAILS"] = "A@Example.com"
    try:
        seed_admins(fresh_db)
    finally:
        del os.environ["ADMIN_EMAILS"]

    row = fresh_db.execute("SELECT is_admin FROM allowlist WHERE email = 'a@example.com'").fetchone()
    assert row["is_admin"] == 1
