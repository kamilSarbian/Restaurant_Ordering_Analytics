"""Unit tests for the app-scoped fixed-window rate limiter."""

from concurrent.futures import ThreadPoolExecutor

import pytest
from starlette.requests import Request

from app.core.config import Settings
from app.core.rate_limit import (
    UNKNOWN_CLIENT_BUCKET,
    FixedWindowRateLimiter,
    get_client_bucket_key,
)
from app.main import create_app


class FakeClock:
    """Provide deterministic monotonic seconds without sleeping."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        """Advance deterministic test time.

        Args:
            seconds: Number of monotonic seconds to add.
        """
        self.now += seconds


def _request(
    client: tuple[str, int] | None,
    *,
    forwarded_for: str | None = None,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if forwarded_for is not None:
        headers.append((b"x-forwarded-for", forwarded_for.encode("ascii")))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "http",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": headers,
            "client": client,
            "server": ("testserver", 80),
        }
    )


def test_first_ten_attempts_are_allowed_and_eleventh_is_denied() -> None:
    """Apply the approved 10-attempt limit within one window."""
    limiter = FixedWindowRateLimiter()
    results = [limiter.check("client") for _ in range(11)]
    assert all(result.allowed for result in results[:10])
    assert all(result.retry_after_seconds is None for result in results[:10])
    assert results[10].allowed is False
    assert results[10].retry_after_seconds == 60


def test_retry_after_is_positive_and_decreases_with_time() -> None:
    """Return ceil-rounded seconds remaining in the active window."""
    clock = FakeClock()
    limiter = FixedWindowRateLimiter(limit=1, window_seconds=60, clock=clock)
    assert limiter.check("client").allowed is True
    first_denial = limiter.check("client")
    clock.advance(10.2)
    second_denial = limiter.check("client")
    assert first_denial.retry_after_seconds == 60
    assert second_denial.retry_after_seconds == 50


def test_window_resets_after_sixty_seconds() -> None:
    """Allow a new first attempt once the fixed window expires."""
    clock = FakeClock()
    limiter = FixedWindowRateLimiter(limit=1, window_seconds=60, clock=clock)
    assert limiter.check("client").allowed is True
    assert limiter.check("client").allowed is False
    clock.advance(60)
    assert limiter.check("client").allowed is True


def test_bucket_keys_are_independent() -> None:
    """Keep attempt counts isolated by direct client key."""
    limiter = FixedWindowRateLimiter(limit=1)
    assert limiter.check("first").allowed is True
    assert limiter.check("first").allowed is False
    assert limiter.check("second").allowed is True


def test_missing_client_uses_one_deterministic_fallback_bucket() -> None:
    """Group requests without peer information into one shared bucket."""
    assert get_client_bucket_key(_request(None)) == UNKNOWN_CLIENT_BUCKET
    assert get_client_bucket_key(_request(None)) == UNKNOWN_CLIENT_BUCKET


def test_forwarded_headers_are_ignored() -> None:
    """Use the direct peer host rather than untrusted forwarding headers."""
    request = _request(("127.0.0.1", 1234), forwarded_for="203.0.113.10")
    assert get_client_bucket_key(request) == "127.0.0.1"


def test_parallel_attempts_are_thread_safe() -> None:
    """Allow exactly the configured number under concurrent calls."""
    limiter = FixedWindowRateLimiter(limit=10)
    with ThreadPoolExecutor(max_workers=20) as executor:
        results = list(executor.map(lambda _index: limiter.check("client"), range(25)))
    assert sum(result.allowed for result in results) == 10
    assert sum(not result.allowed for result in results) == 15


def test_limiter_instances_do_not_share_state() -> None:
    """Keep mutable bucket state local to each limiter instance."""
    first = FixedWindowRateLimiter(limit=1)
    second = FixedWindowRateLimiter(limit=1)
    assert first.check("client").allowed is True
    assert first.check("client").allowed is False
    assert second.check("client").allowed is True


def test_create_app_builds_a_distinct_default_limiter_per_app() -> None:
    """Avoid process-global mutable limiter state."""
    first_app = create_app(settings=Settings(database_url=None))
    second_app = create_app(settings=Settings(database_url=None))
    first_limiter = first_app.state.order_creation_rate_limiter
    second_limiter = second_app.state.order_creation_rate_limiter
    assert first_limiter is not second_limiter
    assert first_limiter.limit == second_limiter.limit == 10
    assert first_limiter.window_seconds == second_limiter.window_seconds == 60


def test_create_app_preserves_an_injected_limiter() -> None:
    """Store the exact injected limiter on application state."""
    limiter = FixedWindowRateLimiter(limit=3, window_seconds=15)
    application = create_app(
        settings=Settings(database_url=None),
        order_creation_rate_limiter=limiter,
    )
    assert application.state.order_creation_rate_limiter is limiter


@pytest.mark.parametrize(
    ("limit", "window_seconds"),
    [(0, 60), (-1, 60), (10, 0), (10, -1)],
)
def test_limiter_rejects_nonpositive_configuration(
    limit: int,
    window_seconds: float,
) -> None:
    """Reject invalid limiter construction before mutable state exists."""
    with pytest.raises(ValueError):
        FixedWindowRateLimiter(limit=limit, window_seconds=window_seconds)
