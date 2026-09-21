from tests.conftest import add_member, auth, token_for


def _send(client, env, *, body=None):
    add_member(env, "a@example.com", "dev-a")
    add_member(env, "b@example.com", "dev-b")
    payload = body or {
        "client_msg_id": "m1",
        "kind": "text",
        "recipients": [{"email": "b@example.com", "device_id": "dev-b", "envelope": "ciphertext"}],
    }
    return client.post("/send", json=payload, headers=auth("a@example.com", "dev-a"))


def test_send_requires_auth(client):
    res = client.post("/send", json={"client_msg_id": "m1", "recipients": []})
    assert res.status_code == 401


def test_a_sent_message_is_pending_for_the_recipient(client, env):
    assert _send(client, env).status_code == 200

    res = client.get("/pending", headers=auth("b@example.com", "dev-b"))
    assert res.status_code == 200
    messages = res.json()["messages"]
    assert len(messages) == 1
    assert messages[0]["envelope"] == "ciphertext"
    assert messages[0]["from_email"] == "a@example.com"


def test_the_sender_does_not_receive_their_own_message(client, env):
    _send(client, env)
    res = client.get("/pending", headers=auth("a@example.com", "dev-a"))
    assert res.json()["messages"] == []


def test_a_message_is_stored_once_per_recipient_device(client, env):
    add_member(env, "a@example.com", "dev-a")
    add_member(env, "b@example.com", "dev-b1", "dev-b2")

    res = client.post(
        "/send",
        json={
            "client_msg_id": "m1",
            "recipients": [
                {"email": "b@example.com", "device_id": "dev-b1", "envelope": "for-b1"},
                {"email": "b@example.com", "device_id": "dev-b2", "envelope": "for-b2"},
            ],
        },
        headers=auth("a@example.com", "dev-a"),
    )
    assert len(res.json()["ids"]) == 2

    assert client.get("/pending", headers=auth("b@example.com", "dev-b1")).json()["messages"][0][
        "envelope"
    ] == "for-b1"
    assert client.get("/pending", headers=auth("b@example.com", "dev-b2")).json()["messages"][0][
        "envelope"
    ] == "for-b2"


def test_sending_to_a_non_member_is_refused(client, env):
    add_member(env, "a@example.com", "dev-a")
    res = client.post(
        "/send",
        json={
            "client_msg_id": "m1",
            "recipients": [
                {"email": "stranger@example.com", "device_id": "dev-x", "envelope": "c"}
            ],
        },
        headers=auth("a@example.com", "dev-a"),
    )
    assert res.status_code == 400


def test_a_revoked_device_cannot_send(client, env):
    add_member(env, "a@example.com", "dev-a", status="revoked")
    add_member(env, "b@example.com", "dev-b")
    res = client.post(
        "/send",
        json={
            "client_msg_id": "m1",
            "recipients": [{"email": "b@example.com", "device_id": "dev-b", "envelope": "c"}],
        },
        headers=auth("a@example.com", "dev-a"),
    )
    assert res.status_code == 401


def test_a_revoked_device_cannot_read_its_pending_messages(client, env):
    _send(client, env)
    add_member(env, "b@example.com", "dev-b", status="revoked")
    assert client.get("/pending", headers=auth("b@example.com", "dev-b")).status_code == 401


def test_an_oversized_envelope_is_refused(client, env):
    add_member(env, "a@example.com", "dev-a")
    add_member(env, "b@example.com", "dev-b")
    res = client.post(
        "/send",
        json={
            "client_msg_id": "m1",
            "recipients": [
                {"email": "b@example.com", "device_id": "dev-b", "envelope": "x" * (128 * 1024 + 1)}
            ],
        },
        headers=auth("a@example.com", "dev-a"),
    )
    assert res.status_code == 413


def test_delivered_receipt_clears_the_message_from_pending(client, env):
    _send(client, env)
    message_id = client.get("/pending", headers=auth("b@example.com", "dev-b")).json()["messages"][0]["id"]

    res = client.post(
        "/receipts/delivered",
        json={"message_ids": [message_id]},
        headers=auth("b@example.com", "dev-b"),
    )
    assert res.json()["count"] == 1
    assert client.get("/pending", headers=auth("b@example.com", "dev-b")).json()["messages"] == []


def test_a_device_cannot_acknowledge_another_devices_messages(client, env):
    _send(client, env)
    add_member(env, "c@example.com", "dev-c")
    message_id = client.get("/pending", headers=auth("b@example.com", "dev-b")).json()["messages"][0]["id"]

    res = client.post(
        "/receipts/delivered",
        json={"message_ids": [message_id]},
        headers=auth("c@example.com", "dev-c"),
    )
    assert res.json()["count"] == 0
    assert len(client.get("/pending", headers=auth("b@example.com", "dev-b")).json()["messages"]) == 1


def test_websocket_rejects_a_bad_token(client, env):
    import pytest
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws?token=nonsense") as ws:
            ws.receive_json()


def test_websocket_opens_with_the_backlog(client, env):
    _send(client, env)
    token = token_for("b@example.com", "dev-b")
    with client.websocket_connect(f"/ws?token={token}") as ws:
        first = ws.receive_json()
    assert first["type"] == "backlog"
    assert len(first["messages"]) == 1


def test_a_live_socket_receives_a_message_without_polling(client, env):
    add_member(env, "a@example.com", "dev-a")
    add_member(env, "b@example.com", "dev-b")
    token = token_for("b@example.com", "dev-b")

    with client.websocket_connect(f"/ws?token={token}") as ws:
        assert ws.receive_json()["type"] == "backlog"
        client.post(
            "/send",
            json={
                "client_msg_id": "m1",
                "recipients": [{"email": "b@example.com", "device_id": "dev-b", "envelope": "live"}],
            },
            headers=auth("a@example.com", "dev-a"),
        )
        pushed = ws.receive_json()

    assert pushed["type"] == "message"
    assert pushed["message"]["envelope"] == "live"


def test_typing_relays_the_conversation_id(client, env):
    """A group's typing indicator belongs to the group. Without chat_id the
    recipient can only attribute it to the sender's 1:1 thread, so group
    typing never shows at all."""
    add_member(env, "a@example.com", "dev-a")
    add_member(env, "b@example.com", "dev-b")

    with client.websocket_connect(f"/ws?token={token_for('b@example.com', 'dev-b')}") as bob:
        assert bob.receive_json()["type"] == "backlog"
        with client.websocket_connect(f"/ws?token={token_for('a@example.com', 'dev-a')}") as alice:
            assert alice.receive_json()["type"] == "backlog"
            alice.send_json({"type": "typing", "to_device": "dev-b", "chat_id": "group-xyz"})
            frame = bob.receive_json()

    assert frame["type"] == "typing"
    assert frame["from_email"] == "a@example.com"
    assert frame["chat_id"] == "group-xyz"


def test_typing_for_a_one_to_one_carries_no_conversation_id(client, env):
    add_member(env, "a@example.com", "dev-a")
    add_member(env, "b@example.com", "dev-b")

    with client.websocket_connect(f"/ws?token={token_for('b@example.com', 'dev-b')}") as bob:
        assert bob.receive_json()["type"] == "backlog"
        with client.websocket_connect(f"/ws?token={token_for('a@example.com', 'dev-a')}") as alice:
            assert alice.receive_json()["type"] == "backlog"
            alice.send_json({"type": "typing", "to_device": "dev-b"})
            frame = bob.receive_json()

    assert frame["chat_id"] is None


def test_a_delivery_receipt_names_who_acknowledged(client, env):
    """Group ticks are aggregated per recipient, so the sender has to know
    which member each receipt came from."""
    add_member(env, "a@example.com", "dev-a")
    add_member(env, "b@example.com", "dev-b")

    with client.websocket_connect(f"/ws?token={token_for('a@example.com', 'dev-a')}") as alice:
        assert alice.receive_json()["type"] == "backlog"
        client.post(
            "/send",
            json={
                "client_msg_id": "m1",
                "recipients": [{"email": "b@example.com", "device_id": "dev-b", "envelope": "c"}],
            },
            headers=auth("a@example.com", "dev-a"),
        )
        message_id = client.get("/pending", headers=auth("b@example.com", "dev-b")).json()["messages"][0]["id"]
        client.post(
            "/receipts/delivered",
            json={"message_ids": [message_id]},
            headers=auth("b@example.com", "dev-b"),
        )
        frame = alice.receive_json()

    assert frame["type"] == "delivered"
    assert frame["by"] == "b@example.com"
