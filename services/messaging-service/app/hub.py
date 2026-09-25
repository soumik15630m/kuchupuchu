import asyncio
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import WebSocket


class Hub:
    """Live WebSocket connections, keyed by device id.

    A device may briefly hold two sockets during a reconnect, so this maps to
    a set rather than a single socket -- dropping the old one on connect would
    race with the client's own retry and close the socket it just opened.

    Presence rides on the same structure, because the connection set *is* the
    presence state: the server already knows who is connected in order to
    deliver to them, so relaying it tells the server nothing new. Two
    deliberate limits keep it from becoming more than that:

      * last-seen is held in memory only. Persisting it would turn a delivery
        service into a log of when each member is awake, which is exactly the
        behavioural history this app avoids storing. A restart means "last
        seen unknown", which is the honest answer.
      * a member who does not share presence is not told anyone else's. That
        is enforced here rather than in the client, because a rule the server
        does not apply is not a rule.
    """

    def __init__(self) -> None:
        self._sockets: dict[str, set[WebSocket]] = defaultdict(set)
        self._device_email: dict[str, str] = {}
        self._shares: dict[str, bool] = {}
        self._last_seen: dict[str, str] = {}
        self._lock = asyncio.Lock()

    async def add(self, device_id: str, socket: WebSocket, email: str | None = None) -> None:
        async with self._lock:
            self._sockets[device_id].add(socket)
            if email:
                self._device_email[device_id] = email.lower()

    async def remove(self, device_id: str, socket: WebSocket) -> None:
        async with self._lock:
            self._sockets[device_id].discard(socket)
            if not self._sockets[device_id]:
                self._sockets.pop(device_id, None)
                self._device_email.pop(device_id, None)

    def is_online(self, device_id: str) -> bool:
        return bool(self._sockets.get(device_id))

    # --- presence -------------------------------------------------------

    def set_sharing(self, email: str, shares: bool) -> None:
        self._shares[email.lower()] = bool(shares)

    def shares(self, email: str) -> bool:
        # Default false: a client that never said so is not opted in.
        return self._shares.get(email.lower(), False)

    def online_emails(self) -> set[str]:
        return {
            email
            for device_id, email in self._device_email.items()
            if self._sockets.get(device_id)
        }

    def is_email_online(self, email: str) -> bool:
        return email.lower() in self.online_emails()

    def mark_seen(self, email: str) -> str:
        stamp = datetime.now(timezone.utc).isoformat()
        self._last_seen[email.lower()] = stamp
        return stamp

    def last_seen(self, email: str) -> str | None:
        return self._last_seen.get(email.lower())

    def snapshot_for(self, viewer: str) -> list[dict]:
        """Who the viewer is allowed to see, and their state.

        Empty when the viewer does not share their own -- the same reciprocity
        the read-receipt setting uses, so the toggle is not a one-way mirror.
        """
        if not self.shares(viewer):
            return []
        me = viewer.lower()
        seen: dict[str, dict] = {}
        for email in self.online_emails():
            if email == me or not self.shares(email):
                continue
            seen[email] = {"email": email, "online": True, "lastSeenAt": None}
        for email, stamp in self._last_seen.items():
            if email == me or email in seen or not self.shares(email):
                continue
            seen[email] = {"email": email, "online": False, "lastSeenAt": stamp}
        return list(seen.values())

    async def broadcast_presence(self, email: str, online: bool, last_seen_at: str | None) -> None:
        """Tells everyone entitled to know that `email` came or went."""
        if not self.shares(email):
            return
        subject = email.lower()
        async with self._lock:
            targets = [
                device_id
                for device_id, owner in self._device_email.items()
                if owner != subject and self.shares(owner) and self._sockets.get(device_id)
            ]
        payload = {
            "type": "presence",
            "email": subject,
            "online": online,
            "lastSeenAt": last_seen_at,
        }
        for device_id in targets:
            await self.send(device_id, payload)

    async def send(self, device_id: str, payload: dict) -> bool:
        """Best-effort delivery. Returns whether at least one socket took it;
        a False here is not an error -- it means store-and-forward applies."""
        async with self._lock:
            sockets = list(self._sockets.get(device_id, ()))
        delivered = False
        for socket in sockets:
            try:
                await socket.send_json(payload)
                delivered = True
            except Exception:
                # A socket that is already gone must not abort delivery to the
                # device's other socket; the disconnect handler cleans it up.
                await self.remove(device_id, socket)
        return delivered


hub = Hub()
