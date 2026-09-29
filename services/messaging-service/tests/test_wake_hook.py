"""The decision of whom to wake, which is made here and acted on by
wake-service. The push itself is that service's suite; this one pins which
devices get handed to it."""
import pytest

from app import wake
from tests.conftest import add_member, auth


@pytest.fixture
def woken(monkeypatch):
    """Captures wake.notify instead of firing a background task, so a test
    asserts on the decision rather than racing an HTTP call."""
    calls: list[tuple[list[str], str]] = []
    monkeypatch.setattr(wake, "notify", lambda ids, reason="message": calls.append((ids, reason)))
    # The router imported the module, not the function, so patching the module
    # attribute is enough -- but only because of that. A `from app.wake import
    # notify` in the router would make this patch a no-op.
    return calls


def _send(client, sender_email, sender_device, *recipients, wake_kind="message"):
    return client.post(
        "/send",
        json={
            "client_msg_id": "m1",
            "wake": wake_kind,
            "recipients": [
                {"email": email, "device_id": device, "envelope": "sealed"}
                for email, device in recipients
            ],
        },
        headers=auth(sender_email, sender_device),
    )


class TestWhoGetsWoken:
    def test_an_offline_recipient_is_woken(self, client, env, woken):
        add_member(env, "a@example.com", "dev-a")
        add_member(env, "b@example.com", "dev-b")
        assert _send(client, "a@example.com", "dev-a", ("b@example.com", "dev-b")).status_code == 200
        assert woken == [(["dev-b"], "message")]

    def test_the_senders_own_other_device_is_not_woken(self, client, env, woken):
        add_member(env, "a@example.com", "dev-a", "dev-a2")
        add_member(env, "b@example.com", "dev-b")
        _send(
            client,
            "a@example.com",
            "dev-a",
            ("b@example.com", "dev-b"),
            ("a@example.com", "dev-a2"),
        )
        # dev-a2 still receives the message -- that is how a second device
        # stays in sync -- it just is not notified about something its owner
        # wrote.
        assert woken == [(["dev-b"], "message")]

    def test_a_call_asks_for_the_urgent_wake(self, client, env, woken):
        add_member(env, "a@example.com", "dev-a")
        add_member(env, "b@example.com", "dev-b")
        _send(client, "a@example.com", "dev-a", ("b@example.com", "dev-b"), wake_kind="call")
        assert woken == [(["dev-b"], "call")]

    def test_an_unknown_wake_kind_is_rejected(self, client, env, woken):
        add_member(env, "a@example.com", "dev-a")
        add_member(env, "b@example.com", "dev-b")
        response = client.post(
            "/send",
            json={
                "client_msg_id": "m1",
                "wake": "silent-alarm",
                "recipients": [
                    {"email": "b@example.com", "device_id": "dev-b", "envelope": "sealed"}
                ],
            },
            headers=auth("a@example.com", "dev-a"),
        )
        assert response.status_code == 422

    def test_the_default_is_an_ordinary_message_wake(self, client, env, woken):
        add_member(env, "a@example.com", "dev-a")
        add_member(env, "b@example.com", "dev-b")
        client.post(
            "/send",
            json={
                "client_msg_id": "m1",
                "recipients": [
                    {"email": "b@example.com", "device_id": "dev-b", "envelope": "sealed"}
                ],
            },
            headers=auth("a@example.com", "dev-a"),
        )
        assert woken == [(["dev-b"], "message")]


class TestConfiguration:
    def test_no_wake_is_sent_when_the_service_is_not_configured(self, monkeypatch):
        monkeypatch.delenv("WAKE_SERVICE_URL", raising=False)
        monkeypatch.delenv("WAKE_INTERNAL_SECRET", raising=False)
        assert wake.is_configured() is False
        # Must not raise: running without a wake path is a supported state,
        # and was the only state before wake-service existed.
        wake.notify(["dev-a"])

    def test_both_halves_are_required(self, monkeypatch):
        monkeypatch.setenv("WAKE_SERVICE_URL", "http://wake-service:8095")
        monkeypatch.delenv("WAKE_INTERNAL_SECRET", raising=False)
        assert wake.is_configured() is False

    def test_it_is_configured_when_both_are_set(self, monkeypatch):
        monkeypatch.setenv("WAKE_SERVICE_URL", "http://wake-service:8095")
        monkeypatch.setenv("WAKE_INTERNAL_SECRET", "x" * 32)
        assert wake.is_configured() is True


class TestPostShape:
    def test_the_request_carries_the_shared_secret_and_the_device_list(self, monkeypatch):
        monkeypatch.setenv("WAKE_SERVICE_URL", "http://wake-service:8095/")
        monkeypatch.setenv("WAKE_INTERNAL_SECRET", "s" * 32)

        captured = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b"{}"

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["body"] = request.data
            captured["secret"] = request.get_header("X-wake-secret")
            return FakeResponse()

        monkeypatch.setattr(wake.urllib.request, "urlopen", fake_urlopen)
        wake._post(["dev-b", "dev-c"], "call")

        # The trailing slash in WAKE_SERVICE_URL must not produce //wake.
        assert captured["url"] == "http://wake-service:8095/wake"
        assert captured["secret"] == "s" * 32
        assert b'"device_ids": ["dev-b", "dev-c"]' in captured["body"]
        assert b'"reason": "call"' in captured["body"]

    def test_an_unreachable_wake_service_does_not_raise(self, monkeypatch):
        import urllib.error

        monkeypatch.setenv("WAKE_SERVICE_URL", "http://wake-service:8095")
        monkeypatch.setenv("WAKE_INTERNAL_SECRET", "s" * 32)

        def boom(request, timeout=None):
            raise urllib.error.URLError("connection refused")

        monkeypatch.setattr(wake.urllib.request, "urlopen", boom)
        # A wake that did not land is a missed notification, not a lost
        # message -- and must not surface as a failed send.
        wake._run(["dev-b"], "message")
