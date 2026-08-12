"""Small app-scoped fixed-window rate limiting primitives."""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from threading import Lock

from starlette.requests import Request

UNKNOWN_CLIENT_BUCKET = "unknown-client"


@dataclass(frozen=True)
class RateLimitResult:
    """Describe whether one attempt is allowed and when it may be retried."""

    allowed: bool
    retry_after_seconds: int | None


@dataclass
class _Window:
    started_at: float
    attempts: int


class FixedWindowRateLimiter:
    """Limit attempts per key within independent fixed time windows."""

    def __init__(
        self,
        *,
        limit: int = 10,
        window_seconds: float = 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Initialize one isolated, thread-safe limiter.

        Args:
            limit: Maximum allowed attempts in one window.
            window_seconds: Positive duration of each window in seconds.
            clock: Injectable monotonic clock returning floating-point seconds.

        Raises:
            ValueError: If the limit or window duration is not positive.
        """
        if limit <= 0:
            raise ValueError("limit must be positive")
        if window_seconds <= 0:
            raise ValueError("window_seconds must be positive")

        self.limit = limit
        self.window_seconds = float(window_seconds)
        self._clock = clock
        self._windows: dict[str, _Window] = {}
        self._lock = Lock()

    def check(self, bucket_key: str) -> RateLimitResult:
        """Register one attempt and return its rate-limit decision.

        Args:
            bucket_key: Stable client identity used only within this limiter.

        Returns:
            An allowed result or a denied result with positive Retry-After seconds.
        """
        now = self._clock()
        with self._lock:
            window = self._windows.get(bucket_key)
            if window is None or now - window.started_at >= self.window_seconds:
                self._windows[bucket_key] = _Window(started_at=now, attempts=1)
                return RateLimitResult(allowed=True, retry_after_seconds=None)

            if window.attempts < self.limit:
                window.attempts += 1
                return RateLimitResult(allowed=True, retry_after_seconds=None)

            remaining = window.started_at + self.window_seconds - now
            return RateLimitResult(
                allowed=False,
                retry_after_seconds=max(1, math.ceil(remaining)),
            )


def get_client_bucket_key(request: Request) -> str:
    """Return the direct peer host without trusting proxy forwarding headers.

    Args:
        request: Current Starlette request.

    Returns:
        The direct client host or one deterministic shared fallback bucket.
    """
    if request.client is None:
        return UNKNOWN_CLIENT_BUCKET
    return request.client.host


def get_auth_login_rate_limiter(request: Request) -> FixedWindowRateLimiter:
    """Return the one app-scoped limiter shared by both login route aliases.

    Args:
        request: Current request containing application authentication state.

    Returns:
        The canonical login limiter used by unified and legacy login routes.

    Raises:
        RuntimeError: If the application has no configured login limiter.
    """
    limiter = getattr(request.app.state, "user_login_rate_limiter", None)
    if not isinstance(limiter, FixedWindowRateLimiter):
        raise RuntimeError("Authentication login rate limiter is not configured")
    return limiter
