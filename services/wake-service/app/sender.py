"""Posting a sealed wake signal to a browser vendor's push service.

The endpoint URL is supplied by a client, and this service then fetches it --
the textbook SSRF shape, the same one `unfurl.py` in messaging-service is
written around. The guard here is different and stronger: a push endpoint is
never an arbitrary URL, it is always a URL at one of a handful of known push
services, so the host is checked against an allowlist rather than the IP being
checked against the private ranges. A member cannot move `fcm.googleapis.com`,
which makes DNS rebinding moot; an IP-range check would have to be re-run at
connect time to say the same.
"""
from __future__ import annotations

import logging
import os
from urllib.parse import urlsplit

import httpx

from app import subscriptions
from app.vapid import authorization_header, b64url_decode
from app.webpush import InvalidSubscriptionKeys, encrypt

logger = logging.getLogger(__name__)

# The push services the four browser engines actually use. Overridable so a
# new one (or a self-hosted autopush) does not need a code change, but never
# empty -- an empty allowlist here would turn this into an open proxy.
_DEFAULT_ENDPOINT_HOSTS = (
    "fcm.googleapis.com",
    "android.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
    ".notify.windows.com",
)

# A wake signal is worth delivering for as long as the member might still care
# that they were messaged; past a day it is noise. Calls get their own, much
# shorter TTL -- a ring that arrives ten minutes late is worse than none.
TTL_MESSAGE_SECONDS = 24 * 60 * 60
TTL_CALL_SECONDS = 45

REQUEST_TIMEOUT_SECONDS = 10


class EndpointNotAllowed(ValueError):
    pass


def allowed_hosts() -> tuple[str, ...]:
    raw = os.environ.get("WAKE_PUSH_ENDPOINT_HOSTS", "").strip()
    if not raw:
        return _DEFAULT_ENDPOINT_HOSTS
    return tuple(h.strip().lower() for h in raw.split(",") if h.strip())


def check_endpoint(endpoint: str) -> None:
    parts = urlsplit(endpoint)
    if parts.scheme != "https":
        raise EndpointNotAllowed("push endpoint must be https")
    if parts.username or parts.password:
        raise EndpointNotAllowed("push endpoint must not carry credentials")
    if parts.port not in (None, 443):
        raise EndpointNotAllowed("push endpoint must use the default https port")

    host = (parts.hostname or "").lower()
    if not host:
        raise EndpointNotAllowed("push endpoint has no host")
    for allowed in allowed_hosts():
        # A leading dot means "any subdomain of", which is how the Windows
        # push service addresses its regions. Without the dot this would also
        # match `evilnotify.windows.com`.
        if host == allowed or (allowed.startswith(".") and host.endswith(allowed)):
            return
    raise EndpointNotAllowed(f"push endpoint host is not a known push service: {host}")


def _headers(endpoint: str, ttl_seconds: int, urgent: bool) -> dict[str, str]:
    return {
        "Authorization": authorization_header(
            endpoint,
            os.environ["WAKE_VAPID_PRIVATE_KEY"],
            os.environ["WAKE_VAPID_PUBLIC_KEY"],
            os.environ["WAKE_VAPID_SUBJECT"],
        ),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(ttl_seconds),
        # RFC 8030 §5.3. `high` asks the push service not to hold this for a
        # device in a battery-saving state, which is the whole point for a ring.
        "Urgency": "high" if urgent else "normal",
        # Collapses queued wakes for the same device into one: a member who
        # missed thirty messages needs to be woken once, not thirty times.
        "Topic": "kuchupuchu-call" if urgent else "kuchupuchu-message",
    }


async def send_one(client: httpx.AsyncClient, subscription: dict, payload: bytes, *, urgent: bool) -> bool:
    """Returns whether the push was accepted. A subscription the push service
    has retired is deleted here rather than left to fail forever."""
    endpoint = subscription["endpoint"]
    try:
        check_endpoint(endpoint)
        body = encrypt(
            payload,
            b64url_decode(subscription["p256dh"]),
            b64url_decode(subscription["auth"]),
        )
    except (EndpointNotAllowed, InvalidSubscriptionKeys) as exc:
        # Unusable and will stay unusable; keeping the row would mean retrying
        # a guaranteed failure on every message.
        logger.warning("dropping unusable push subscription: %s", exc)
        subscriptions.remove(subscription["device_id"])
        return False

    ttl = TTL_CALL_SECONDS if urgent else TTL_MESSAGE_SECONDS
    try:
        response = await client.post(
            endpoint, content=body, headers=_headers(endpoint, ttl, urgent), timeout=REQUEST_TIMEOUT_SECONDS
        )
    except httpx.HTTPError as exc:
        # The push service being unreachable is not the member's problem to
        # fix and not a reason to forget where they are.
        logger.warning("push request failed: %s", exc)
        return False

    if response.status_code in (200, 201, 202):
        return True
    if response.status_code in (404, 410):
        # RFC 8030 §7.3: the subscription is gone. The browser will create a
        # new one the next time the app runs.
        logger.info("push subscription expired, removing it")
        subscriptions.remove(subscription["device_id"])
        return False

    # Everything else is logged without the body: a 400 from a push service
    # can echo request details back, and those go to a log that outlives it.
    logger.warning("push rejected with status %s", response.status_code)
    return False


async def send_many(rows: list[dict], payload: bytes, *, urgent: bool) -> int:
    if not rows:
        return 0
    pushed: list[str] = []
    async with httpx.AsyncClient(follow_redirects=False) as client:
        for row in rows:
            if await send_one(client, row, payload, urgent=urgent):
                pushed.append(row["device_id"])
    subscriptions.mark_pushed(pushed)
    return len(pushed)
