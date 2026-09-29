import json

import httpx
import pytest

from app import sender
from app.sender import EndpointNotAllowed, check_endpoint
from app.vapid import audience_for, b64url_decode, load_private_key
from app.webpush import decrypt
from tests.conftest import add_member, auth, fake_subscription, internal, keyed_subscription


class TestEndpointGuard:
    @pytest.mark.parametrize(
        "endpoint",
        [
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://web.push.apple.com/abc",
            "https://par02p.notify.windows.com/w/?token=abc",
        ],
    )
    def test_the_real_push_services_are_allowed(self, endpoint):
        check_endpoint(endpoint)

    @pytest.mark.parametrize(
        "endpoint",
        [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://169.254.169.254/latest/meta-data/",
            "https://localhost/push",
            "https://fcm.googleapis.com:8443/fcm/send/abc",
            "https://user:pass@fcm.googleapis.com/fcm/send/abc",
            "https://evilnotify.windows.com/w/?token=abc",
            "https://fcm.googleapis.com.attacker.example/fcm/send/abc",
        ],
    )
    def test_everything_else_is_refused(self, endpoint):
        # An endpoint arrives from a client and is then fetched by this
        # service, so this list is the SSRF boundary.
        with pytest.raises(EndpointNotAllowed):
            check_endpoint(endpoint)

    def test_the_allowlist_can_be_extended_without_a_code_change(self, monkeypatch):
        monkeypatch.setenv("WAKE_PUSH_ENDPOINT_HOSTS", "push.example.test")
        check_endpoint("https://push.example.test/abc")
        with pytest.raises(EndpointNotAllowed):
            check_endpoint("https://fcm.googleapis.com/fcm/send/abc")


class TestVapidHeader:
    def test_the_audience_is_the_origin_not_the_full_url(self):
        assert audience_for("https://fcm.googleapis.com/fcm/send/abc?x=1") == "https://fcm.googleapis.com"

    def test_the_header_is_the_single_header_form(self, monkeypatch):
        from app.vapid import authorization_header, generate_keypair

        private, public = generate_keypair()
        header = authorization_header(
            "https://fcm.googleapis.com/fcm/send/abc", private, public, "mailto:ops@example.com"
        )
        assert header.startswith("vapid t=")
        assert f",k={public}" in header

    def test_the_token_is_a_verifiable_es256_jwt(self):
        import jwt as pyjwt
        from app.vapid import authorization_header, generate_keypair, load_private_key

        private, public = generate_keypair()
        header = authorization_header(
            "https://fcm.googleapis.com/fcm/send/abc", private, public, "mailto:ops@example.com"
        )
        token = header[len("vapid t=") :].split(",")[0]
        claims = pyjwt.decode(
            token,
            load_private_key(private).public_key(),
            algorithms=["ES256"],
            audience="https://fcm.googleapis.com",
        )
        assert claims["sub"] == "mailto:ops@example.com"
        assert claims["aud"] == "https://fcm.googleapis.com"


class FakePushService:
    """Stands in for Google's or Mozilla's endpoint. Records what was posted so
    the payload can be decrypted with the subscription's own private key --
    proving the browser would be able to read it."""

    def __init__(self, status: int = 201) -> None:
        self.status = status
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status)


@pytest.fixture
def push_service(monkeypatch):
    service = FakePushService()
    original = httpx.AsyncClient

    def patched(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(service.handler)
        return original(*args, **kwargs)

    monkeypatch.setattr(sender.httpx, "AsyncClient", patched)
    return service


def _subscribe(client, env, email: str, device_id: str) -> dict:
    add_member(env, email, device_id)
    subscription = fake_subscription()
    client.put("/push/subscription", json=subscription, headers=auth(email, device_id))
    return subscription


class TestWake:
    def test_an_internal_caller_wakes_a_subscribed_device(self, client, env, push_service):
        _subscribe(client, env, "a@example.com", "dev-a")
        response = client.post("/wake", json={"device_ids": ["dev-a"]}, headers=internal())
        assert response.json() == {"status": "ok", "pushed": 1, "targets": 1}
        assert len(push_service.requests) == 1

    def test_the_wake_endpoint_is_not_reachable_without_the_shared_secret(self, client, env):
        _subscribe(client, env, "a@example.com", "dev-a")
        assert client.post("/wake", json={"device_ids": ["dev-a"]}).status_code == 401
        assert client.post(
            "/wake", json={"device_ids": ["dev-a"]}, headers={"X-Wake-Secret": "wrong"}
        ).status_code == 401

    def test_a_device_access_token_does_not_open_the_wake_endpoint(self, client, env):
        _subscribe(client, env, "a@example.com", "dev-a")
        # /wake is service-to-service. A member's own token must not reach it,
        # or any member could make any other member's phone buzz.
        response = client.post(
            "/wake", json={"device_ids": ["dev-a"]}, headers=auth("a@example.com", "dev-a")
        )
        assert response.status_code == 401

    def test_an_unsubscribed_device_is_simply_not_woken(self, client, env, push_service):
        add_member(env, "a@example.com", "dev-a")
        response = client.post("/wake", json={"device_ids": ["dev-a"]}, headers=internal())
        # The normal case for someone who never granted permission -- not an
        # error, and not something a message send should fail over.
        assert response.json() == {"status": "ok", "pushed": 0, "targets": 0}
        assert push_service.requests == []

    def test_the_payload_carries_no_sender_chat_or_content(self, client, env, push_service):
        add_member(env, "a@example.com", "dev-a")
        subscription, browser_key = keyed_subscription()
        client.put("/push/subscription", json=subscription, headers=auth("a@example.com", "dev-a"))
        client.post("/wake", json={"device_ids": ["dev-a"], "reason": "message"}, headers=internal())

        # Decrypted the way the browser would: with the subscription's own
        # private key. If this ever carries a sender or a preview, the push
        # service's logs become a record of who talks to whom.
        plaintext = decrypt(
            push_service.requests[0].content,
            browser_key,
            b64url_decode(subscription["auth"]),
        )
        assert json.loads(plaintext) == {"v": 1, "r": "message"}

    def test_a_call_is_urgent_and_short_lived(self, client, env, push_service):
        _subscribe(client, env, "a@example.com", "dev-a")
        client.post("/wake", json={"device_ids": ["dev-a"], "reason": "call"}, headers=internal())
        request = push_service.requests[0]
        assert request.headers["urgency"] == "high"
        # A ring that arrives ten minutes late is worse than one that never does.
        assert int(request.headers["ttl"]) == sender.TTL_CALL_SECONDS

    def test_a_message_is_normal_urgency_and_survives_a_day(self, client, env, push_service):
        _subscribe(client, env, "a@example.com", "dev-a")
        client.post("/wake", json={"device_ids": ["dev-a"]}, headers=internal())
        request = push_service.requests[0]
        assert request.headers["urgency"] == "normal"
        assert int(request.headers["ttl"]) == sender.TTL_MESSAGE_SECONDS

    def test_repeat_wakes_collapse_into_one_notification(self, client, env, push_service):
        _subscribe(client, env, "a@example.com", "dev-a")
        client.post("/wake", json={"device_ids": ["dev-a"]}, headers=internal())
        # Thirty missed messages should wake a device once, not thirty times.
        assert push_service.requests[0].headers["topic"] == "kuchupuchu-message"

    def test_the_request_carries_the_aes128gcm_content_encoding(self, client, env, push_service):
        _subscribe(client, env, "a@example.com", "dev-a")
        client.post("/wake", json={"device_ids": ["dev-a"]}, headers=internal())
        assert push_service.requests[0].headers["content-encoding"] == "aes128gcm"

    def test_several_devices_are_woken_in_one_call(self, client, env, push_service):
        _subscribe(client, env, "a@example.com", "dev-a")
        _subscribe(client, env, "b@example.com", "dev-b")
        response = client.post(
            "/wake", json={"device_ids": ["dev-a", "dev-b"]}, headers=internal()
        )
        assert response.json()["pushed"] == 2

    def test_a_successful_push_records_that_it_happened(self, client, env, push_service):
        from app import subscriptions

        _subscribe(client, env, "a@example.com", "dev-a")
        client.post("/wake", json={"device_ids": ["dev-a"]}, headers=internal())
        assert subscriptions.get("dev-a")["last_push_at"] is not None

    def test_an_unknown_reason_is_rejected(self, client, env):
        assert client.post(
            "/wake", json={"device_ids": ["dev-a"], "reason": "whatever"}, headers=internal()
        ).status_code == 422


class TestRetiredSubscriptions:
    @pytest.mark.parametrize("status", [404, 410])
    def test_a_gone_subscription_is_dropped(self, client, env, monkeypatch, status):
        from app import subscriptions

        _subscribe(client, env, "a@example.com", "dev-a")

        service = FakePushService(status=status)
        original = httpx.AsyncClient
        monkeypatch.setattr(
            sender.httpx,
            "AsyncClient",
            lambda *a, **k: original(*a, **(k | {"transport": httpx.MockTransport(service.handler)})),
        )

        response = client.post("/wake", json={"device_ids": ["dev-a"]}, headers=internal())
        assert response.json()["pushed"] == 0
        # RFC 8030 §7.3: gone means gone. Keeping it would retry a guaranteed
        # failure on every future message.
        assert subscriptions.get("dev-a") is None

    def test_a_transient_failure_keeps_the_subscription(self, client, env, monkeypatch):
        from app import subscriptions

        _subscribe(client, env, "a@example.com", "dev-a")

        service = FakePushService(status=503)
        original = httpx.AsyncClient
        monkeypatch.setattr(
            sender.httpx,
            "AsyncClient",
            lambda *a, **k: original(*a, **(k | {"transport": httpx.MockTransport(service.handler)})),
        )

        client.post("/wake", json={"device_ids": ["dev-a"]}, headers=internal())
        # The push service being down is not a reason to forget where the
        # member is.
        assert subscriptions.get("dev-a") is not None

