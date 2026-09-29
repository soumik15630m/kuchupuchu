from tests.conftest import add_member, auth, fake_subscription, revoke


class TestVapidKey:
    def test_a_member_can_read_the_public_key(self, client, env):
        add_member(env, "a@example.com", "dev-a")
        response = client.get("/push/key", headers=auth("a@example.com", "dev-a"))
        assert response.status_code == 200
        assert response.json()["publicKey"]

    def test_an_unauthenticated_caller_cannot(self, client, env):
        assert client.get("/push/key").status_code == 401


class TestSubscribing:
    def test_a_device_registers_where_to_reach_it(self, client, env):
        add_member(env, "a@example.com", "dev-a")
        subscription = fake_subscription()
        headers = auth("a@example.com", "dev-a")
        assert client.put("/push/subscription", json=subscription, headers=headers).status_code == 200

        status = client.get("/push/subscription", headers=headers).json()
        assert status["subscribed"] is True
        assert status["createdAt"] is not None
        assert status["lastPushAt"] is None

        from app import subscriptions

        assert subscriptions.get("dev-a")["endpoint"] == subscription["endpoint"]

    def test_re_subscribing_replaces_rather_than_accumulates(self, client, env):
        from app import subscriptions

        add_member(env, "a@example.com", "dev-a")
        headers = auth("a@example.com", "dev-a")
        client.put("/push/subscription", json=fake_subscription(), headers=headers)
        second = fake_subscription("https://fcm.googleapis.com/fcm/send/second")
        client.put("/push/subscription", json=second, headers=headers)

        assert subscriptions.count_for_email("a@example.com") == 1
        assert subscriptions.get("dev-a")["endpoint"] == second["endpoint"]

    def test_two_devices_of_one_member_are_separate_rows(self, client, env):
        from app import subscriptions

        add_member(env, "a@example.com", "dev-a", "dev-b")
        client.put("/push/subscription", json=fake_subscription(), headers=auth("a@example.com", "dev-a"))
        client.put("/push/subscription", json=fake_subscription(), headers=auth("a@example.com", "dev-b"))
        # A wake goes to the device that missed the message, so a laptop and a
        # phone cannot share one subscription.
        assert subscriptions.count_for_email("a@example.com") == 2

    def test_a_revoked_device_cannot_subscribe(self, client, env):
        add_member(env, "a@example.com", "dev-a")
        revoke(env, "dev-a")
        response = client.put(
            "/push/subscription", json=fake_subscription(), headers=auth("a@example.com", "dev-a")
        )
        assert response.status_code == 401

    def test_an_endpoint_at_an_unknown_host_is_refused(self, client, env):
        add_member(env, "a@example.com", "dev-a")
        response = client.put(
            "/push/subscription",
            json=fake_subscription("https://attacker.example.com/push/1"),
            headers=auth("a@example.com", "dev-a"),
        )
        assert response.status_code == 400
        assert "known push service" in response.json()["detail"]

    def test_a_malformed_key_is_refused_at_registration_time(self, client, env):
        add_member(env, "a@example.com", "dev-a")
        body = fake_subscription() | {"p256dh": "dG9vLXNob3J0"}
        response = client.put(
            "/push/subscription", json=body, headers=auth("a@example.com", "dev-a")
        )
        # Rejected here rather than at push time: stored, it would fail every
        # future push indistinguishably from a member who opted out.
        assert response.status_code == 400


class TestUnsubscribing:
    def test_a_device_can_drop_its_subscription(self, client, env):
        from app import subscriptions

        add_member(env, "a@example.com", "dev-a")
        headers = auth("a@example.com", "dev-a")
        client.put("/push/subscription", json=fake_subscription(), headers=headers)

        response = client.delete("/push/subscription", headers=headers)
        assert response.json() == {"status": "unsubscribed", "removed": True}
        assert subscriptions.get("dev-a") is None

    def test_unsubscribing_twice_is_not_an_error(self, client, env):
        add_member(env, "a@example.com", "dev-a")
        headers = auth("a@example.com", "dev-a")
        client.delete("/push/subscription", headers=headers)
        assert client.delete("/push/subscription", headers=headers).json()["removed"] is False

    def test_status_reports_nothing_for_a_device_that_never_subscribed(self, client, env):
        add_member(env, "a@example.com", "dev-a")
        assert client.get("/push/subscription", headers=auth("a@example.com", "dev-a")).json() == {
            "subscribed": False,
            "createdAt": None,
            "lastPushAt": None,
        }
