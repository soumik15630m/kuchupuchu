"""In-process sliding-window rate limiting.

Per-process and in-memory, which is sufficient at this scale but would
need a shared store the moment this runs multi-process. Not a
substitute for nginx's limit_req: that bounds request volume, these
bound the semantic cost of individually legitimate requests.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


# Deliberately generous: legitimate key counts here are bounded by
# device count, so crossing this at all means something is
# generating keys.
_SWEEP_THRESHOLD = 1024


class SlidingWindowLimiter:
    """Allows at most `max_events` per `window_seconds` for each key.

    Uses time.monotonic, so it can't be skewed by a system clock
    adjustment the way a wall-clock implementation could.
    """

    def __init__(self, max_events: int, window_seconds: float, name: str = ""):
        self.max_events = max_events
        self.window_seconds = window_seconds
        self.name = name
        self._events: dict[str, deque] = defaultdict(deque)
        # Endpoints run on FastAPI's threadpool, so two requests really
        # can land here at once for the same key. Without this lock the
        # check-then-append below is the same TOCTOU the limiter exists
        # to prevent.
        self._lock = threading.Lock()

    def _sweep_locked(self, now: float) -> None:
        """Drops keys whose window has fully expired.

        Harmless to skip for device-keyed limiters, but the OTP limiter is
        keyed by source IP: without eviction an attacker walking
        addresses turns it into unbounded allocation."""
        expired = [k for k, events in self._events.items() if not events or now - events[-1] > self.window_seconds]
        for key in expired:
            del self._events[key]

    def check(self, key: str) -> bool:
        """True if this event is allowed (and records it), False if the
        key is over its limit."""
        now = time.monotonic()
        with self._lock:
            if len(self._events) > _SWEEP_THRESHOLD:
                self._sweep_locked(now)
            events = self._events[key]
            while events and now - events[0] > self.window_seconds:
                events.popleft()
            if len(events) >= self.max_events:
                return False
            events.append(now)
            return True

    def reset(self) -> None:
        """Test-only hook -- this is process-global state that otherwise
        leaks between test cases."""
        with self._lock:
            self._events.clear()


_registry: list[SlidingWindowLimiter] = []


def register(limiter: SlidingWindowLimiter) -> SlidingWindowLimiter:
    """Records a limiter so `reset_all()` can find it. Module-level
    limiters should be created through this, so a new one added later
    doesn't silently start leaking state across tests."""
    _registry.append(limiter)
    return limiter


def reset_all() -> None:
    """Test-only hook, called from tests/conftest.py's fresh_db fixture."""
    for limiter in _registry:
        limiter.reset()
