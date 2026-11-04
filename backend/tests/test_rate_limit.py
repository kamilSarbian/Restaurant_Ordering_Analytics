"""Unit tests for the app-scoped fixed-window rate limiter."""

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from uuid import UUID

import pytest
from starlette.requests import Request

from app.auth.service import UserTokenService
from app.core.config import Settings
from app.core.rate_limit import (
    DEMO_SESSION_CLIENT_IP_MODE_DIRECT,
    DEMO_SESSION_CLIENT_IP_MODE_RENDER,
    UNKNOWN_CLIENT_BUCKET,
    DemoSessionClientIdentityError,
    FixedWindowRateLimiter,
    get_client_bucket_key,
    get_demo_session_bucket_key,
)
from app.main import _demo_session_client_ip_mode, create_app


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
    forwarding_headers: tuple[tuple[str, str], ...] = (),
    demo_session_client_ip_mode: str = DEMO_SESSION_CLIENT_IP_MODE_DIRECT,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if forwarded_for is not None:
        headers.append((b"x-forwarded-for", forwarded_for.encode("ascii")))
    headers.extend(
        (name.encode("ascii"), value.encode("ascii"))
        for name, value in forwarding_headers
    )
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
            "app": SimpleNamespace(
                state=SimpleNamespace(
                    demo_session_client_ip_mode=demo_session_client_ip_mode,
                )
            ),
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


@pytest.mark.parametrize(
    "forwarding_headers",
    [
        (("x-forwarded-for", "203.0.113.10, 198.51.100.4"),),
        (
            ("x-forwarded-for", "203.0.113.10"),
            ("x-forwarded-for", "198.51.100.4"),
        ),
        (("forwarded", "for=203.0.113.10;proto=https"),),
        (("x-forwarded-for", "for=unknown, [broken"),),
        (("x-real-ip", "203.0.113.10"),),
        (("cf-connecting-ip", "203.0.113.10"),),
    ],
)
def test_all_untrusted_forwarding_forms_use_the_direct_peer(
    forwarding_headers: tuple[tuple[str, str], ...],
) -> None:
    """Ignore spoofed single-hop, multi-hop, repeated, and vendor headers."""
    request = _request(
        ("127.0.0.1", 1234),
        forwarding_headers=forwarding_headers,
    )
    assert get_client_bucket_key(request) == "127.0.0.1"


def test_forwarded_headers_without_a_direct_peer_use_the_shared_fallback() -> None:
    """Never promote attacker-controlled forwarding data into a bucket key."""
    request = _request(
        None,
        forwarding_headers=(
            ("x-forwarded-for", "203.0.113.10, 198.51.100.4"),
            ("x-real-ip", "192.0.2.20"),
        ),
    )
    assert get_client_bucket_key(request) == UNKNOWN_CLIENT_BUCKET


def test_rotating_spoofed_addresses_cannot_create_new_limiter_buckets() -> None:
    """Charge every spoofed identity to the same direct-peer rate-limit window."""
    limiter = FixedWindowRateLimiter(limit=2)
    requests = [
        _request(("127.0.0.1", 1234), forwarded_for=forwarded)
        for forwarded in ("203.0.113.10", "198.51.100.4", "192.0.2.20")
    ]
    results = [limiter.check(get_client_bucket_key(request)) for request in requests]
    assert [result.allowed for result in results] == [True, True, False]


def test_local_demo_session_bucket_uses_direct_peer_and_ignores_headers() -> None:
    """Keep local demo-session tests on the direct peer identity boundary."""
    request = _request(
        ("local-peer", 1234),
        forwarding_headers=(
            ("cf-connecting-ip", "203.0.113.10"),
            ("x-forwarded-for", "198.51.100.20"),
        ),
    )
    assert get_demo_session_bucket_key(request) == "local-peer"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("203.0.113.10", "render-client:203.0.113.10"),
        ("2001:0db8:0000:0000:0000:0000:0000:0001", "render-client:2001:db8::1"),
    ],
)
def test_render_demo_session_bucket_accepts_one_canonical_ip(
    value: str,
    expected: str,
) -> None:
    """Canonicalize exactly one Render edge client address."""
    request = _request(
        ("render-proxy", 1234),
        forwarding_headers=(
            ("cf-connecting-ip", value),
            ("x-forwarded-for", "192.0.2.5"),
        ),
        demo_session_client_ip_mode=DEMO_SESSION_CLIENT_IP_MODE_RENDER,
    )
    assert get_demo_session_bucket_key(request) == expected


@pytest.mark.parametrize(
    "forwarding_headers",
    [
        (),
        (("cf-connecting-ip", ""),),
        (("cf-connecting-ip", "203.0.113.10, 198.51.100.20"),),
        (("cf-connecting-ip", " 203.0.113.10"),),
        (("cf-connecting-ip", "203.0.113.10:443"),),
        (("cf-connecting-ip", "fe80::1%eth0"),),
        (("cf-connecting-ip", "not-an-ip"),),
        (
            ("cf-connecting-ip", "203.0.113.10"),
            ("cf-connecting-ip", "198.51.100.20"),
        ),
    ],
)
def test_render_demo_session_bucket_rejects_untrusted_or_ambiguous_values(
    forwarding_headers: tuple[tuple[str, str], ...],
) -> None:
    """Fail closed without falling back to the shared Render proxy peer."""
    request = _request(
        ("render-proxy", 1234),
        forwarding_headers=forwarding_headers,
        demo_session_client_ip_mode=DEMO_SESSION_CLIENT_IP_MODE_RENDER,
    )
    with pytest.raises(DemoSessionClientIdentityError):
        get_demo_session_bucket_key(request)


def test_unknown_demo_session_identity_mode_fails_closed() -> None:
    """Reject missing trusted runtime classification instead of using a peer."""
    request = _request(
        ("render-proxy", 1234),
        demo_session_client_ip_mode="unavailable",
    )
    with pytest.raises(DemoSessionClientIdentityError):
        get_demo_session_bucket_key(request)


def test_demo_session_client_mode_requires_exact_public_render_configuration() -> None:
    """Select the edge header only for the exact trusted public Render runtime."""
    exact = Settings.model_construct(
        app_environment="production",
        portfolio_demo_mode=True,
        payment_provider="demo",
        render_runtime="true",
        render_service_type="web",
        render_external_hostname="roa-backend.onrender.com",
        public_api_origin="https://roa-backend.onrender.com",
        trusted_hosts=("roa-backend.onrender.com",),
        trusted_proxy_mode="direct",
    )
    assert _demo_session_client_ip_mode(exact) == DEMO_SESSION_CLIENT_IP_MODE_RENDER

    for field, value in (
        ("portfolio_demo_mode", False),
        ("payment_provider", "stripe_test"),
        ("render_runtime", None),
        ("render_service_type", None),
        ("render_service_type", "pserv"),
        ("render_external_hostname", None),
        ("render_external_hostname", "api.example.com"),
        ("public_api_origin", "https://other.onrender.com"),
        ("trusted_hosts", ("other.onrender.com",)),
        ("trusted_proxy_mode", None),
    ):
        candidate = exact.model_copy(update={field: value})
        assert _demo_session_client_ip_mode(candidate) is None


def test_demo_session_client_mode_keeps_nonproduction_on_direct_peer() -> None:
    """Keep local and test runtimes independent from Render-only headers."""
    settings = Settings.model_construct(app_environment="test")
    assert _demo_session_client_ip_mode(settings) == DEMO_SESSION_CLIENT_IP_MODE_DIRECT


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


def test_create_app_builds_an_independent_default_checkout_limiter_per_app() -> None:
    """Create checkout limiters independently from apps and order limiters."""
    first_app = create_app(settings=Settings(database_url=None))
    second_app = create_app(settings=Settings(database_url=None))
    first_checkout_limiter = first_app.state.checkout_rate_limiter
    second_checkout_limiter = second_app.state.checkout_rate_limiter
    assert first_checkout_limiter is not second_checkout_limiter
    assert first_checkout_limiter is not first_app.state.order_creation_rate_limiter
    assert first_checkout_limiter.limit == second_checkout_limiter.limit == 10
    assert (
        first_checkout_limiter.window_seconds
        == second_checkout_limiter.window_seconds
        == 60
    )
    for _ in range(10):
        assert first_app.state.order_creation_rate_limiter.check("client").allowed
    assert not first_app.state.order_creation_rate_limiter.check("client").allowed
    assert first_checkout_limiter.check("client").allowed
    assert second_checkout_limiter.check("client").allowed


def test_create_app_preserves_an_injected_checkout_limiter() -> None:
    """Store the exact injected checkout limiter on application state."""
    limiter = FixedWindowRateLimiter(limit=4, window_seconds=20)
    application = create_app(
        settings=Settings(database_url=None),
        checkout_rate_limiter=limiter,
    )
    assert application.state.checkout_rate_limiter is limiter


def test_create_app_builds_default_user_login_limiter() -> None:
    """Configure the independent canonical login limit at five per minute."""
    application = create_app(settings=Settings(database_url=None))
    limiter = application.state.user_login_rate_limiter
    assert limiter.limit == 5
    assert limiter.window_seconds == 60
    assert limiter is not application.state.order_creation_rate_limiter
    assert limiter is not application.state.checkout_rate_limiter
    assert not hasattr(application.state, "admin_login_rate_limiter")


def test_create_app_builds_distinct_user_login_limiters_per_app() -> None:
    """Keep canonical login attempts isolated between app instances."""
    first_app = create_app(settings=Settings(database_url=None))
    second_app = create_app(settings=Settings(database_url=None))
    first_limiter = first_app.state.user_login_rate_limiter
    second_limiter = second_app.state.user_login_rate_limiter
    assert first_limiter is not second_limiter
    for _ in range(5):
        assert first_limiter.check("client").allowed
    assert first_limiter.check("client").allowed is False
    assert second_limiter.check("client").allowed


def test_create_app_preserves_an_injected_user_login_limiter() -> None:
    """Store the exact injected canonical login limiter on application state."""
    limiter = FixedWindowRateLimiter(limit=2, window_seconds=30)
    application = create_app(
        settings=Settings(database_url=None),
        user_login_rate_limiter=limiter,
    )
    assert application.state.user_login_rate_limiter is limiter


def test_create_app_builds_a_distinct_default_demo_session_limiter() -> None:
    """Limit demo-session issuance independently at five attempts per minute."""
    first_app = create_app(settings=Settings(database_url=None))
    second_app = create_app(settings=Settings(database_url=None))
    assert (
        first_app.state.demo_session_client_ip_mode
        == DEMO_SESSION_CLIENT_IP_MODE_DIRECT
    )
    assert (
        second_app.state.demo_session_client_ip_mode
        == DEMO_SESSION_CLIENT_IP_MODE_DIRECT
    )
    first_limiter = first_app.state.demo_session_rate_limiter
    second_limiter = second_app.state.demo_session_rate_limiter
    assert first_limiter.limit == second_limiter.limit == 5
    assert first_limiter.window_seconds == second_limiter.window_seconds == 60
    assert first_limiter is not second_limiter
    assert first_limiter is not first_app.state.user_register_rate_limiter
    assert first_limiter is not first_app.state.user_login_rate_limiter


def test_create_app_preserves_an_injected_demo_session_limiter() -> None:
    """Store the exact injected demo-session limiter on application state."""
    limiter = FixedWindowRateLimiter(limit=2, window_seconds=30)
    application = create_app(
        settings=Settings(database_url=None),
        demo_session_rate_limiter=limiter,
    )
    assert application.state.demo_session_rate_limiter is limiter


def test_user_login_limiter_uses_existing_direct_peer_key_policy() -> None:
    """Ignore forwarded addresses for canonical login bucket selection."""
    application = create_app(settings=Settings(database_url=None))
    limiter = application.state.user_login_rate_limiter
    direct_peer = get_client_bucket_key(
        _request(("127.0.0.1", 1234), forwarded_for="203.0.113.10")
    )
    assert direct_peer == "127.0.0.1"
    for _ in range(5):
        assert limiter.check(direct_peer).allowed
    assert limiter.check(direct_peer).allowed is False


def test_create_app_preserves_an_injected_user_token_service() -> None:
    """Store the exact injected canonical service without generating a token."""
    token_service = UserTokenService("s" * 32)
    application = create_app(
        settings=Settings(_env_file=None, database_url=None),
        user_token_service=token_service,
    )
    assert application.state.user_token_service is token_service
    assert not hasattr(application.state, "admin_token_service")


def test_create_app_constructs_token_service_only_for_a_configured_secret() -> None:
    """Keep auth optional while constructing one canonical service."""
    unavailable_app = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
        )
    )
    configured_app = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret="s" * 32,
            auth_access_token_expire_minutes=7,
        )
    )
    assert unavailable_app.state.user_token_service is None
    token_service = configured_app.state.user_token_service
    assert isinstance(token_service, UserTokenService)
    token = token_service.create_access_token(
        UUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")
    )
    claims = token_service.decode_access_token(token)
    assert (claims.expires_at - claims.issued_at).total_seconds() == 420


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
