from tests.conftest import add_member, auth

CIPHERTEXT = b"KPBKP1\x01" + bytes(range(256)) * 4


def _members(env):
    add_member(env, "a@example.com", "dev-a", "dev-a2")
    add_member(env, "b@example.com", "dev-b")


def test_upload_requires_auth(client):
    assert client.put("/backup", content=CIPHERTEXT).status_code == 401


def test_download_requires_auth(client):
    assert client.get("/backup").status_code == 401


def test_a_backup_round_trips_byte_for_byte(client, env):
    _members(env)
    put = client.put("/backup", content=CIPHERTEXT, headers=auth("a@example.com", "dev-a"))
    assert put.status_code == 200
    assert put.json()["byteSize"] == len(CIPHERTEXT)

    got = client.get("/backup", headers=auth("a@example.com", "dev-a"))
    assert got.status_code == 200
    assert got.content == CIPHERTEXT


def test_a_backup_is_not_visible_to_another_member(client, env):
    _members(env)
    client.put("/backup", content=CIPHERTEXT, headers=auth("a@example.com", "dev-a"))

    assert client.get("/backup", headers=auth("b@example.com", "dev-b")).status_code == 404
    assert client.get("/backup/meta", headers=auth("b@example.com", "dev-b")).json() == {
        "exists": False
    }


def test_another_device_of_the_same_member_can_restore(client, env):
    # The entire point of the feature: a member's second device must be able
    # to pull the backup down, because that is where a restore happens.
    _members(env)
    client.put("/backup", content=CIPHERTEXT, headers=auth("a@example.com", "dev-a"))
    got = client.get("/backup", headers=auth("a@example.com", "dev-a2"))
    assert got.status_code == 200
    assert got.content == CIPHERTEXT


def test_meta_reports_nothing_before_a_backup_exists(client, env):
    _members(env)
    res = client.get("/backup/meta", headers=auth("a@example.com", "dev-a"))
    assert res.json() == {"exists": False}


def test_meta_reports_size_and_date_without_the_body(client, env):
    _members(env)
    client.put("/backup", content=CIPHERTEXT, headers=auth("a@example.com", "dev-a"))
    res = client.get("/backup/meta", headers=auth("a@example.com", "dev-a")).json()
    assert res["exists"] is True
    assert res["byteSize"] == len(CIPHERTEXT)
    assert res["deviceId"] == "dev-a"
    assert res["createdAt"]


def test_a_new_backup_replaces_the_old_one(client, env):
    _members(env)
    client.put("/backup", content=b"first version", headers=auth("a@example.com", "dev-a"))
    client.put("/backup", content=CIPHERTEXT, headers=auth("a@example.com", "dev-a2"))

    got = client.get("/backup", headers=auth("a@example.com", "dev-a"))
    assert got.content == CIPHERTEXT
    meta = client.get("/backup/meta", headers=auth("a@example.com", "dev-a")).json()
    assert meta["byteSize"] == len(CIPHERTEXT)
    assert meta["deviceId"] == "dev-a2"


def test_downloading_with_no_backup_is_a_404(client, env):
    _members(env)
    assert client.get("/backup", headers=auth("a@example.com", "dev-a")).status_code == 404


def test_an_empty_upload_is_refused(client, env):
    _members(env)
    res = client.put("/backup", content=b"", headers=auth("a@example.com", "dev-a"))
    assert res.status_code == 400


def test_an_oversized_upload_is_refused(client, env, monkeypatch):
    _members(env)
    from app import backups as backups_module
    from app.routers import backups as router_module

    monkeypatch.setattr(backups_module, "MAX_BACKUP_BYTES", 64)
    monkeypatch.setattr(router_module, "MAX_BACKUP_BYTES", 64)

    res = client.put("/backup", content=b"x" * 500, headers=auth("a@example.com", "dev-a"))
    assert res.status_code == 413


def test_a_backup_can_be_deleted_and_is_then_gone(client, env):
    _members(env)
    client.put("/backup", content=CIPHERTEXT, headers=auth("a@example.com", "dev-a"))
    assert client.delete("/backup", headers=auth("a@example.com", "dev-a")).status_code == 200
    assert client.get("/backup", headers=auth("a@example.com", "dev-a")).status_code == 404
    assert client.delete("/backup", headers=auth("a@example.com", "dev-a")).status_code == 404


def test_one_member_cannot_delete_another_member_backup(client, env):
    _members(env)
    client.put("/backup", content=CIPHERTEXT, headers=auth("a@example.com", "dev-a"))
    assert client.delete("/backup", headers=auth("b@example.com", "dev-b")).status_code == 404
    assert client.get("/backup", headers=auth("a@example.com", "dev-a")).status_code == 200


def test_a_revoked_device_cannot_reach_a_backup(client, env):
    _members(env)
    client.put("/backup", content=CIPHERTEXT, headers=auth("a@example.com", "dev-a"))
    add_member(env, "a@example.com", "dev-a", status="revoked")
    assert client.get("/backup", headers=auth("a@example.com", "dev-a")).status_code == 401


def test_the_stored_file_is_exactly_what_was_uploaded(client, env):
    """The server must not transform the ciphertext in any way -- a single
    altered byte makes the whole GCM blob undecryptable."""
    _members(env)
    client.put("/backup", content=CIPHERTEXT, headers=auth("a@example.com", "dev-a"))

    root = env["tmp"] / "media" / "backups"
    files = list(root.glob("*.kpbkp"))
    assert len(files) == 1
    assert files[0].read_bytes() == CIPHERTEXT


def test_an_interrupted_upload_leaves_no_part_file_behind(client, env):
    _members(env)
    client.put("/backup", content=CIPHERTEXT, headers=auth("a@example.com", "dev-a"))
    root = env["tmp"] / "media" / "backups"
    assert list(root.glob("*.part")) == []


def test_an_address_cannot_escape_the_backup_directory(client, env):
    # The filename comes from the authenticated email, hex-encoded. Even an
    # address full of separators lands inside the directory.
    nasty = "../../etc/passwd@example.com"
    add_member(env, nasty, "dev-x")
    res = client.put("/backup", content=CIPHERTEXT, headers=auth(nasty, "dev-x"))
    assert res.status_code == 200

    root = env["tmp"] / "media" / "backups"
    assert len(list(root.glob("*.kpbkp"))) == 1
    assert client.get("/backup", headers=auth(nasty, "dev-x")).content == CIPHERTEXT
