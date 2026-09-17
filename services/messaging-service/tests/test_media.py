from tests.conftest import add_member, auth


def _upload(client, env, *, audience="b@example.com", data=b"encrypted-bytes"):
    add_member(env, "a@example.com", "dev-a")
    add_member(env, "b@example.com", "dev-b")
    add_member(env, "c@example.com", "dev-c")
    return client.post(
        "/media",
        files={"file": ("blob.bin", data, "application/octet-stream")},
        data={"audience": audience},
        headers=auth("a@example.com", "dev-a"),
    )


def test_upload_requires_auth(client):
    res = client.post("/media", files={"file": ("b.bin", b"x")}, data={"audience": "b@example.com"})
    assert res.status_code == 401


def test_a_recipient_can_download_what_was_uploaded(client, env):
    media_id = _upload(client, env).json()["id"]
    res = client.get(f"/media/{media_id}", headers=auth("b@example.com", "dev-b"))
    assert res.status_code == 200
    assert res.content == b"encrypted-bytes"


def test_someone_outside_the_audience_gets_404(client, env):
    media_id = _upload(client, env).json()["id"]
    assert client.get(f"/media/{media_id}", headers=auth("c@example.com", "dev-c")).status_code == 404


def test_the_uploader_can_still_fetch_their_own_blob(client, env):
    media_id = _upload(client, env).json()["id"]
    assert client.get(f"/media/{media_id}", headers=auth("a@example.com", "dev-a")).status_code == 200


def test_the_blob_is_deleted_once_every_member_of_the_audience_has_fetched_it(client, env):
    media_id = _upload(client, env).json()["id"]

    assert client.get(f"/media/{media_id}", headers=auth("b@example.com", "dev-b")).status_code == 200
    # Uploader is implicitly in the audience, so the blob survives until it
    # has fetched too.
    assert client.get(f"/media/{media_id}", headers=auth("a@example.com", "dev-a")).status_code == 200
    assert client.get(f"/media/{media_id}", headers=auth("b@example.com", "dev-b")).status_code == 404


def test_an_unknown_member_in_the_audience_is_refused(client, env):
    res = _upload(client, env, audience="stranger@example.com")
    assert res.status_code == 400


def test_an_oversized_blob_is_refused(client, env):
    res = _upload(client, env, data=b"x" * (25 * 1024 * 1024 + 1))
    assert res.status_code == 413
