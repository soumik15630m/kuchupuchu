import asyncio

import pytest

from app.hub import Hub


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


async def connect(hub: Hub, email: str, device: str, *, shares: bool = True) -> FakeSocket:
    socket = FakeSocket()
    await hub.add(device, socket, email)
    hub.set_sharing(email, shares)
    return socket


@pytest.fixture
def hub():
    return Hub()


def run(coro):
    # asyncio.run rather than get_event_loop: the latter is deprecated and
    # warns once per call, which is 35 lines of noise for nothing.
    return asyncio.run(coro)


class TestOnlineTracking:
    def test_a_connected_member_is_online(self, hub):
        run(connect(hub, "a@example.com", "dev-a"))
        assert hub.is_email_online("a@example.com") is True
        assert hub.is_email_online("b@example.com") is False

    def test_a_member_stays_online_while_any_device_is_connected(self, hub):
        s1 = run(connect(hub, "a@example.com", "dev-1"))
        run(connect(hub, "a@example.com", "dev-2"))
        run(hub.remove("dev-1", s1))
        # A phone dropping off while the laptop is still connected is not
        # "went offline".
        assert hub.is_email_online("a@example.com") is True

    def test_removing_the_last_device_takes_the_member_offline(self, hub):
        s = run(connect(hub, "a@example.com", "dev-1"))
        run(hub.remove("dev-1", s))
        assert hub.is_email_online("a@example.com") is False


class TestReciprocity:
    def test_someone_who_shares_sees_others_who_share(self, hub):
        run(connect(hub, "a@example.com", "dev-a"))
        run(connect(hub, "b@example.com", "dev-b"))
        emails = [m["email"] for m in hub.snapshot_for("a@example.com")]
        assert emails == ["b@example.com"]

    def test_someone_who_does_not_share_sees_nobody(self, hub):
        run(connect(hub, "a@example.com", "dev-a", shares=False))
        run(connect(hub, "b@example.com", "dev-b"))
        # The whole point of the toggle: it is not a one-way mirror.
        assert hub.snapshot_for("a@example.com") == []

    def test_a_member_who_does_not_share_is_invisible_to_others(self, hub):
        run(connect(hub, "a@example.com", "dev-a"))
        run(connect(hub, "b@example.com", "dev-b", shares=False))
        assert hub.snapshot_for("a@example.com") == []

    def test_you_never_appear_in_your_own_snapshot(self, hub):
        run(connect(hub, "a@example.com", "dev-a"))
        assert hub.snapshot_for("a@example.com") == []

    def test_sharing_defaults_to_off_until_the_client_says_otherwise(self, hub):
        socket = FakeSocket()
        run(hub.add("dev-a", socket, "a@example.com"))
        assert hub.shares("a@example.com") is False


class TestBroadcast:
    def test_going_online_reaches_others_who_share(self, hub):
        watcher = run(connect(hub, "b@example.com", "dev-b"))
        run(connect(hub, "a@example.com", "dev-a"))
        run(hub.broadcast_presence("a@example.com", True, None))
        assert watcher.sent == [
            {"type": "presence", "email": "a@example.com", "online": True, "lastSeenAt": None}
        ]

    def test_a_non_sharing_watcher_is_not_told(self, hub):
        watcher = run(connect(hub, "b@example.com", "dev-b", shares=False))
        run(connect(hub, "a@example.com", "dev-a"))
        run(hub.broadcast_presence("a@example.com", True, None))
        assert watcher.sent == []

    def test_a_non_sharing_subject_is_not_broadcast(self, hub):
        watcher = run(connect(hub, "b@example.com", "dev-b"))
        run(connect(hub, "a@example.com", "dev-a", shares=False))
        run(hub.broadcast_presence("a@example.com", True, None))
        assert watcher.sent == []

    def test_you_are_not_told_about_yourself(self, hub):
        own = run(connect(hub, "a@example.com", "dev-a"))
        run(hub.broadcast_presence("a@example.com", True, None))
        assert own.sent == []

    def test_going_offline_carries_a_last_seen(self, hub):
        watcher = run(connect(hub, "b@example.com", "dev-b"))
        run(connect(hub, "a@example.com", "dev-a"))
        stamp = hub.mark_seen("a@example.com")
        run(hub.broadcast_presence("a@example.com", False, stamp))
        assert watcher.sent[-1]["online"] is False
        assert watcher.sent[-1]["lastSeenAt"] == stamp


class TestLastSeen:
    def test_last_seen_is_unknown_until_someone_goes_offline(self, hub):
        assert hub.last_seen("a@example.com") is None

    def test_an_offline_member_appears_in_the_snapshot_with_a_timestamp(self, hub):
        s = run(connect(hub, "a@example.com", "dev-a"))
        run(connect(hub, "b@example.com", "dev-b"))
        run(hub.remove("dev-a", s))
        stamp = hub.mark_seen("a@example.com")

        snapshot = hub.snapshot_for("b@example.com")
        assert snapshot == [{"email": "a@example.com", "online": False, "lastSeenAt": stamp}]

    def test_last_seen_is_not_persisted_anywhere(self, hub):
        """A fresh Hub knows nothing -- the state lives in memory by design,
        so a restart cannot leak a history of when anyone was awake."""
        run(connect(hub, "a@example.com", "dev-a"))
        hub.mark_seen("a@example.com")
        assert Hub().last_seen("a@example.com") is None

    def test_an_offline_member_who_stopped_sharing_is_dropped_from_snapshots(self, hub):
        s = run(connect(hub, "a@example.com", "dev-a"))
        run(connect(hub, "b@example.com", "dev-b"))
        run(hub.remove("dev-a", s))
        hub.mark_seen("a@example.com")
        hub.set_sharing("a@example.com", False)
        assert hub.snapshot_for("b@example.com") == []
