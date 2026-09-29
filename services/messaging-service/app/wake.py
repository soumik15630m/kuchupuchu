"""Asking wake-service to reach devices that had no live socket.

Store-and-forward already works without this: an undelivered row waits for
/pending. What a wake adds is that the member finds out, rather than the
message sitting there until they next happen to open the app.

Deliberately fire-and-forget. A send must not fail, block, or slow down
because the push path is unhealthy -- the message is already stored by the
time this runs, and the worst case without a wake is exactly the behaviour
this service had before wake-service existed.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_SECONDS = 5

# asyncio holds only a weak reference to a bare create_task, so a task nobody
# keeps can be collected mid-flight. These are discarded on completion.
_in_flight: set[asyncio.Task] = set()


def is_configured() -> bool:
    """Absent configuration is a supported state, not a broken one: the
    service runs without a wake path and simply does not send one."""
    return bool(os.environ.get("WAKE_SERVICE_URL") and os.environ.get("WAKE_INTERNAL_SECRET"))


def _post(device_ids: list[str], reason: str) -> None:
    base = os.environ["WAKE_SERVICE_URL"].rstrip("/")
    # urllib rather than a new HTTP dependency: one POST to a known host inside
    # the compose network. The unfurler's socket-level care is for URLs a
    # member supplies, which this is not.
    request = urllib.request.Request(
        f"{base}/wake",
        data=json.dumps({"device_ids": device_ids, "reason": reason}).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Wake-Secret": os.environ["WAKE_INTERNAL_SECRET"],
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        response.read()


def _run(device_ids: list[str], reason: str) -> None:
    try:
        _post(device_ids, reason)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        # A wake that did not land is a missed notification, not a lost
        # message. Logged without the device ids: this service already routes
        # by them, but a log is a durable copy with a different lifetime.
        logger.warning("wake request failed: %s", exc)


def notify(device_ids: list[str], reason: str = "message") -> None:
    """Schedules the wake and returns immediately.

    Not awaited by the caller: /send's response must not wait on a third-party
    push service, and a five-second timeout on a slow one would otherwise
    become five seconds of latency on every message to an offline device.
    """
    if not device_ids or not is_configured():
        return
    targets = sorted(set(device_ids))
    task = asyncio.create_task(asyncio.to_thread(_run, targets, reason))
    _in_flight.add(task)
    task.add_done_callback(_in_flight.discard)
