import asyncio
from collections import defaultdict

from fastapi import WebSocket


class Hub:
    """Live WebSocket connections, keyed by device id.

    A device may briefly hold two sockets during a reconnect, so this maps to
    a set rather than a single socket -- dropping the old one on connect would
    race with the client's own retry and close the socket it just opened.
    """

    def __init__(self) -> None:
        self._sockets: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def add(self, device_id: str, socket: WebSocket) -> None:
        async with self._lock:
            self._sockets[device_id].add(socket)

    async def remove(self, device_id: str, socket: WebSocket) -> None:
        async with self._lock:
            self._sockets[device_id].discard(socket)
            if not self._sockets[device_id]:
                self._sockets.pop(device_id, None)

    def is_online(self, device_id: str) -> bool:
        return bool(self._sockets.get(device_id))

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
