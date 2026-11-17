from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.auth.demo_admin import (
    DEMO_ADMIN_DISABLED_PASSWORD_HASH,
    DEMO_ADMIN_EMAIL,
    DEMO_ADMIN_ID,
)
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.auth.roles import UserRole
from app.core.config import Settings
from app.exchange_rates.provider import (
    EcbExchangeRates,
    ExchangeRateProvider,
    ExchangeRateReader,
    ExchangeRateUnavailableError,
)
from app.main import create_app


class StubExchangeRateProvider:
    def __init__(self, *, unavailable: bool = False) -> None:
        self.calls = 0
        self.unavailable = unavailable

    def get_rates(self) -> EcbExchangeRates:
        self.calls += 1
        if self.unavailable:
            raise ExchangeRateUnavailableError("private upstream detail")
        return EcbExchangeRates(
            rate_date=date(2026, 11, 13),
            nok_per_eur=Decimal("11.7000"),
            pln_per_eur=Decimal("4.2500"),
        )


def _demo_admin(
    *,
    user_id: UUID = DEMO_ADMIN_ID,
    email: str = DEMO_ADMIN_EMAIL,
    role: UserRole = UserRole.ADMIN,
    is_active: bool = True,
) -> User:
    return User(
        id=user_id,
        email=email,
        password_hash=DEMO_ADMIN_DISABLED_PASSWORD_HASH,
        role=role,
        is_active=is_active,
    )


def _client(
    provider: ExchangeRateReader,
    *,
    portfolio_demo_mode: bool = True,
    payment_provider: str = "demo",
    user: User | None = None,
) -> TestClient:
    settings_portfolio_mode = portfolio_demo_mode
    settings_payment_provider = payment_provider
    if portfolio_demo_mode != (payment_provider == "demo"):
        # Settings rejects inconsistent pairs. Build the app from the trusted pair,
        # then exercise the route's own fail-closed check against drifted state.
        settings_portfolio_mode = True
        settings_payment_provider = "demo"
    app = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            portfolio_demo_mode=settings_portfolio_mode,
            payment_provider=settings_payment_provider,
        ),
        exchange_rate_provider=provider,
    )
    app.state.portfolio_demo_mode = portfolio_demo_mode
    app.state.payment_provider = payment_provider

    def current_user_override() -> User:
        return user or _demo_admin()

    app.dependency_overrides[get_current_user] = current_user_override
    return TestClient(app)


def test_exchange_rates_return_only_required_public_fields() -> None:
    provider = StubExchangeRateProvider()

    with _client(provider) as client:
        response = client.get("/api/v1/admin/exchange-rates/ecb")

    assert response.status_code == 200
    assert response.json() == {
        "source": "European Central Bank",
        "base": "EUR",
        "reference_date": "2026-11-13",
        "nok_per_eur": "11.7000",
        "pln_per_eur": "4.2500",
    }
    assert provider.calls == 1


@pytest.mark.parametrize(
    ("portfolio_demo_mode", "payment_provider"),
    [
        (False, "demo"),
        (False, "stripe_test"),
        (True, "stripe_test"),
    ],
)
def test_exchange_rates_fail_closed_before_provider_outside_exact_demo_runtime(
    portfolio_demo_mode: bool,
    payment_provider: str,
) -> None:
    provider = StubExchangeRateProvider()

    with _client(
        provider,
        portfolio_demo_mode=portfolio_demo_mode,
        payment_provider=payment_provider,
    ) as client:
        response = client.get("/api/v1/admin/exchange-rates/ecb")

    assert response.status_code == 404
    assert response.json() == {"detail": "Not found"}
    assert provider.calls == 0


@pytest.mark.parametrize(
    "runtime_state",
    [
        (False, "stripe_test"),
        (False, "demo"),
        (True, "stripe_test"),
        None,
    ],
)
def test_exchange_rates_reject_untrusted_runtime_before_authentication(
    runtime_state: tuple[bool, str] | None,
) -> None:
    provider = StubExchangeRateProvider()
    settings_portfolio_mode = runtime_state == (True, "stripe_test")
    app = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            portfolio_demo_mode=settings_portfolio_mode,
            payment_provider="demo" if settings_portfolio_mode else "stripe_test",
        ),
        exchange_rate_provider=provider,
    )
    if runtime_state is None:
        del app.state.portfolio_demo_mode
        del app.state.payment_provider
    else:
        app.state.portfolio_demo_mode, app.state.payment_provider = runtime_state

    def unexpected_authentication() -> User:
        raise AssertionError("Authentication must not run outside portfolio demo")

    app.dependency_overrides[get_current_user] = unexpected_authentication
    with TestClient(app) as client:
        response = client.get("/api/v1/admin/exchange-rates/ecb")

    assert response.status_code == 404
    assert response.json() == {"detail": "Not found"}
    assert provider.calls == 0


@pytest.mark.parametrize(
    "user",
    [
        _demo_admin(user_id=UUID("00000000-0000-4000-8000-000000000001")),
        _demo_admin(email="other-admin@example.test"),
        _demo_admin(is_active=False),
        _demo_admin(role=UserRole.CUSTOMER),
        _demo_admin(role=UserRole.SUPER_ADMIN),
    ],
)
def test_exchange_rates_fail_closed_for_non_demo_admin_identity(user: User) -> None:
    provider = StubExchangeRateProvider()

    with _client(provider, user=user) as client:
        response = client.get("/api/v1/admin/exchange-rates/ecb")

    assert response.status_code == 404
    assert response.json() == {"detail": "Not found"}
    assert provider.calls == 0


def test_exchange_rates_return_sanitized_unavailable_response() -> None:
    provider = StubExchangeRateProvider(unavailable=True)

    with _client(provider) as client:
        response = client.get("/api/v1/admin/exchange-rates/ecb")

    assert response.status_code == 503
    assert response.json() == {"detail": "ECB reference rates are unavailable"}
    assert "private" not in response.text
    assert provider.calls == 1


def test_exchange_rates_share_the_safe_failure_cache_between_requests() -> None:
    calls = 0

    def failing_fetcher(_url: str, _timeout: float, _max_bytes: int) -> bytes:
        nonlocal calls
        calls += 1
        raise TimeoutError("synthetic private upstream detail")

    provider = ExchangeRateProvider(
        fetcher=failing_fetcher,
        utc_now_provider=lambda: datetime(2026, 11, 14, 12, tzinfo=UTC),
        monotonic_provider=lambda: 100.0,
    )

    with _client(provider) as client:
        first = client.get("/api/v1/admin/exchange-rates/ecb")
        second = client.get("/api/v1/admin/exchange-rates/ecb")

    assert first.status_code == 503
    assert second.status_code == 503
    assert first.json() == {"detail": "ECB reference rates are unavailable"}
    assert second.json() == first.json()
    assert "private" not in first.text
    assert calls == 1
