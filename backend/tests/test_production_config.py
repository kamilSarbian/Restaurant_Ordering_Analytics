"""Production configuration contract tests without external integrations."""

from collections.abc import Mapping

import pytest
from pydantic import ValidationError
from pydantic_settings import SettingsError

from app.core.config import Settings

PUBLIC_ORIGIN = "https://restaurant.example"
RELEASE_SHA = "a" * 40
DATABASE_PASSWORD_MARKER = "database-password-marker"
STRIPE_SECRET_MARKER = "sk_test_stripe-secret-marker"
WEBHOOK_SECRET_MARKER = "whsec_webhook-secret-marker"
JWT_SECRET_MARKER = "jwt-secret-marker-1234567890abcdef"


def _production_values() -> dict[str, object]:
    return {
        "_env_file": None,
        "app_environment": "production",
        "app_debug": False,
        "database_url": (
            "postgresql://runtime:"
            f"{DATABASE_PASSWORD_MARKER}@db.internal/restaurant"
            "?sslmode=require&application_name=roa"
        ),
        "stripe_secret_key": STRIPE_SECRET_MARKER,
        "stripe_webhook_secret": WEBHOOK_SECRET_MARKER,
        "stripe_success_url": (
            f"{PUBLIC_ORIGIN}/orders/{{public_order_number}}/payment-return"
        ),
        "stripe_cancel_url": (
            f"{PUBLIC_ORIGIN}/orders/{{public_order_number}}/checkout-cancelled"
        ),
        "auth_jwt_secret": JWT_SECRET_MARKER,
        "public_app_origin": PUBLIC_ORIGIN,
        "trusted_hosts": ("restaurant.example",),
        "trusted_proxy_mode": "direct",
        "stripe_expected_livemode": False,
        "expected_alembic_head": "0008_add_order_ownership",
        "release_sha": RELEASE_SHA,
        "log_level": "info",
    }


def production_settings(
    overrides: Mapping[str, object] | None = None,
) -> Settings:
    """Build one complete synthetic production Settings instance."""
    values = _production_values()
    if overrides is not None:
        values.update(overrides)
    return Settings(**values)


def test_complete_production_contract_is_accepted_and_normalized() -> None:
    """Accept the complete sandbox contract without exposing its secrets."""
    settings = production_settings()

    assert settings.app_environment == "production"
    assert settings.app_debug is False
    assert settings.trusted_hosts == ("restaurant.example",)
    assert settings.trusted_proxy_mode == "direct"
    assert settings.stripe_expected_livemode is False
    assert settings.log_level == "INFO"
    assert settings.database_url is not None
    rendered_database_url = str(settings.database_url)
    assert rendered_database_url.startswith("postgresql+psycopg://")
    assert rendered_database_url.endswith(
        "/restaurant?sslmode=require&application_name=roa"
    )
    for marker in (
        DATABASE_PASSWORD_MARKER,
        STRIPE_SECRET_MARKER,
        WEBHOOK_SECRET_MARKER,
        JWT_SECRET_MARKER,
    ):
        assert marker not in repr(settings)
        assert marker not in str(settings)


def test_complete_production_contract_loads_from_environment_strings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercise the exact string boundary used by the deployment provider."""
    environment = {
        "APP_ENVIRONMENT": "production",
        "APP_DEBUG": "false",
        "DATABASE_URL": (
            "postgresql://runtime:synthetic@db.internal/restaurant?sslmode=require"
        ),
        "STRIPE_SECRET_KEY": "sk_test_synthetic",
        "STRIPE_WEBHOOK_SECRET": "whsec_synthetic",
        "STRIPE_SUCCESS_URL": (
            f"{PUBLIC_ORIGIN}/orders/{{public_order_number}}/payment-return"
        ),
        "STRIPE_CANCEL_URL": (
            f"{PUBLIC_ORIGIN}/orders/{{public_order_number}}/checkout-cancelled"
        ),
        "AUTH_JWT_SECRET": "a" * 32,
        "PUBLIC_APP_ORIGIN": PUBLIC_ORIGIN,
        "TRUSTED_HOSTS": '["restaurant.example"]',
        "TRUSTED_PROXY_MODE": "direct",
        "STRIPE_EXPECTED_LIVEMODE": "false",
        "EXPECTED_ALEMBIC_HEAD": "0008_add_order_ownership",
        "RELEASE_SHA": RELEASE_SHA,
        "LOG_LEVEL": "warning",
    }
    for name, value in environment.items():
        monkeypatch.setenv(name, value)

    settings = Settings(_env_file=None)

    assert settings.app_environment == "production"
    assert settings.trusted_hosts == ("restaurant.example",)
    assert settings.trusted_proxy_mode == "direct"
    assert settings.stripe_expected_livemode is False
    assert settings.log_level == "WARNING"
    assert settings.database_url is not None
    assert str(settings.database_url).startswith("postgresql+psycopg://")


def test_malformed_trusted_hosts_environment_value_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail before startup when the provider allowlist is not valid JSON."""
    monkeypatch.setenv("TRUSTED_HOSTS", "restaurant.example")
    with pytest.raises(SettingsError):
        Settings(_env_file=None)


@pytest.mark.parametrize(
    ("field_name", "missing_value"),
    [
        ("database_url", None),
        ("stripe_secret_key", None),
        ("stripe_webhook_secret", None),
        ("stripe_success_url", None),
        ("stripe_cancel_url", ""),
        ("auth_jwt_secret", None),
        ("public_app_origin", None),
        ("trusted_hosts", ()),
        ("trusted_proxy_mode", None),
        ("stripe_expected_livemode", None),
        ("expected_alembic_head", None),
        ("release_sha", None),
    ],
)
def test_production_rejects_each_missing_required_setting(
    field_name: str,
    missing_value: object,
) -> None:
    """Reject every incomplete production contract before app construction."""
    with pytest.raises(ValidationError):
        production_settings({field_name: missing_value})


def test_production_rejects_debug_mode() -> None:
    """Keep debug responses disabled in production."""
    with pytest.raises(ValidationError, match="APP_DEBUG=false"):
        production_settings({"app_debug": True})


@pytest.mark.parametrize("environment", ["prod", "Production", "staging"])
def test_unknown_environment_names_cannot_bypass_production_validation(
    environment: str,
) -> None:
    """Reject aliases that could accidentally skip the production contract."""
    with pytest.raises(ValidationError):
        Settings(_env_file=None, app_environment=environment)


@pytest.mark.parametrize(
    "origin",
    [
        "http://restaurant.example",
        "https://*.restaurant.example",
        "https://restaurant.example/",
        "https://restaurant.example/path",
        "https://restaurant.example?",
        "https://restaurant.example?query=value",
        "https://restaurant.example#",
        "https://restaurant.example#fragment",
        "https://user:password@restaurant.example",
        "https://restaurant.example:invalid",
        "https://restaurant.example:",
        "https://restaurant.example:0",
        " https://restaurant.example",
        "https://restaurant.example\n",
        "https:///missing-host",
    ],
)
def test_public_origin_rejects_noncanonical_or_unsafe_values(origin: str) -> None:
    """Accept only one exact credential-free HTTPS origin."""
    with pytest.raises(ValidationError):
        production_settings({"public_app_origin": origin})


@pytest.mark.parametrize(
    "trusted_host",
    [
        "",
        "*",
        "*.restaurant.example",
        "https://restaurant.example",
        "restaurant.example/path",
        "user@restaurant.example",
        "restaurant.example:443",
        " restaurant.example",
        ".restaurant.example",
        "restaurant..example",
        "restaurant.example.",
        "[2001:db8::1]",
    ],
)
def test_trusted_hosts_reject_wildcards_urls_ports_and_malformed_values(
    trusted_host: str,
) -> None:
    """Reject every host syntax that would add ambiguous trust semantics."""
    with pytest.raises(ValidationError):
        production_settings({"trusted_hosts": (trusted_host,)})


def test_trusted_hosts_reject_duplicates_after_case_normalization() -> None:
    """Reject duplicate effective hosts rather than silently broadening input."""
    with pytest.raises(ValidationError, match="duplicate"):
        production_settings(
            {"trusted_hosts": ("restaurant.example", "RESTAURANT.EXAMPLE")}
        )


def test_public_origin_host_must_be_explicitly_trusted() -> None:
    """Prevent a syntactically valid but unreachable production application."""
    with pytest.raises(ValidationError, match="PUBLIC_APP_ORIGIN"):
        production_settings({"trusted_hosts": ("other.example",)})


@pytest.mark.parametrize(
    ("field_name", "redirect_url"),
    [
        (
            "stripe_success_url",
            "http://restaurant.example/orders/{public_order_number}/payment-return",
        ),
        (
            "stripe_cancel_url",
            "https://attacker.example/orders/{public_order_number}/cancelled",
        ),
        (
            "stripe_success_url",
            "https://user:password@restaurant.example/orders/payment-return",
        ),
        (
            "stripe_cancel_url",
            "https://restaurant.example:444/orders/checkout-cancelled",
        ),
        (
            "stripe_success_url",
            "https://restaurant.example/orders/{unsupported}/payment-return",
        ),
        (
            "stripe_cancel_url",
            "https://restaurant.example/orders/{public_order_number}#cancelled",
        ),
    ],
)
def test_production_stripe_redirects_require_the_exact_public_https_origin(
    field_name: str,
    redirect_url: str,
) -> None:
    """Prevent Checkout redirects from escaping the canonical public origin."""
    with pytest.raises(ValidationError):
        production_settings({field_name: redirect_url})


@pytest.mark.parametrize("mode", ["", "render", "xff", "forwarded", "proxy"])
def test_production_rejects_every_unproven_proxy_mode(mode: str) -> None:
    """Keep proxy-aware identity unavailable until the runtime boundary is proven."""
    with pytest.raises(ValidationError):
        production_settings({"trusted_proxy_mode": mode})


@pytest.mark.parametrize("scheme", ["postgres", "postgresql"])
def test_provider_postgresql_urls_normalize_to_psycopg3(scheme: str) -> None:
    """Preserve provider host, database, and TLS query while selecting Psycopg 3."""
    settings = Settings(
        _env_file=None,
        database_url=(
            f"{scheme}://runtime:{DATABASE_PASSWORD_MARKER}@db.internal/restaurant"
            "?sslmode=require"
        ),
    )
    assert settings.database_url is not None
    rendered = str(settings.database_url)
    assert rendered.startswith("postgresql+psycopg://")
    assert rendered.endswith("@db.internal/restaurant?sslmode=require")
    assert DATABASE_PASSWORD_MARKER not in repr(settings)


@pytest.mark.parametrize(
    "database_url",
    [
        "mysql://runtime:secret@db.internal/restaurant",
        "sqlite:///restaurant.db",
        "postgresql+asyncpg://runtime:secret@db.internal/restaurant",
        "postgresql+psycopg2://runtime:secret@db.internal/restaurant",
    ],
)
def test_database_url_rejects_non_postgres_or_non_psycopg3_drivers(
    database_url: str,
) -> None:
    """Reject unsupported drivers with a stable secret-free validation error."""
    with pytest.raises(ValidationError) as caught:
        Settings(_env_file=None, database_url=database_url)
    assert "secret" not in str(caught.value)
    assert "secret" not in repr(caught.value)


def test_production_validation_does_not_echo_secret_values() -> None:
    """Keep every configured credential out of production validation errors."""
    with pytest.raises(ValidationError) as caught:
        production_settings(
            {
                "app_debug": True,
                "stripe_secret_key": "sk_live_do-not-print-this-key",
            }
        )
    rendered_error = str(caught.value)
    for marker in (
        DATABASE_PASSWORD_MARKER,
        "sk_live_do-not-print-this-key",
        WEBHOOK_SECRET_MARKER,
        JWT_SECRET_MARKER,
    ):
        assert marker not in rendered_error


def test_live_key_rejection_does_not_echo_the_key() -> None:
    """Exercise the Stripe-key failure branch without exposing its input."""
    live_key_marker = "sk_live_unique-secret-marker"
    with pytest.raises(ValidationError, match="Stripe test key") as caught:
        production_settings({"stripe_secret_key": live_key_marker})
    assert live_key_marker not in str(caught.value)
    assert live_key_marker not in repr(caught.value)


@pytest.mark.parametrize(
    "stripe_secret_key",
    [
        "sk_live_synthetic",
        "rk_live_synthetic",
        "not-a-stripe-key",
        "sk_test_",
        "rk_test_   ",
    ],
)
def test_production_rejects_non_test_stripe_key_forms(
    stripe_secret_key: str,
) -> None:
    """Reject live or unknown API-key modes before any provider call exists."""
    with pytest.raises(ValidationError, match="Stripe test key"):
        production_settings({"stripe_secret_key": stripe_secret_key})


def test_production_rejects_expected_live_mode() -> None:
    """Keep this deployment contract explicitly sandbox-only."""
    with pytest.raises(ValidationError, match="Stripe test mode"):
        production_settings({"stripe_expected_livemode": True})


@pytest.mark.parametrize(
    "expected_head",
    ["", "0008-add-order-ownership", "HEAD", "../0008", "a" * 129],
)
def test_expected_alembic_head_rejects_unsafe_identifiers(
    expected_head: str,
) -> None:
    """Require one bounded lowercase revision identifier."""
    with pytest.raises(ValidationError):
        production_settings({"expected_alembic_head": expected_head})


@pytest.mark.parametrize(
    "release_sha",
    ["", "a" * 39, "a" * 41, "A" * 40, "g" * 40],
)
def test_release_sha_rejects_noncanonical_values(release_sha: str) -> None:
    """Require the complete lowercase hexadecimal deployment commit."""
    with pytest.raises(ValidationError):
        production_settings({"release_sha": release_sha})


def test_nonproduction_defaults_remain_backward_compatible() -> None:
    """Keep local, test, and E2E settings independent of production-only fields."""
    for environment in ("development", "test", "e2e"):
        settings = Settings(_env_file=None, app_environment=environment)
        assert settings.public_app_origin is None
        assert settings.trusted_hosts == ()
        assert settings.trusted_proxy_mode is None
        assert settings.stripe_expected_livemode is None


def test_create_app_wires_expected_livemode_to_both_stripe_adapters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Propagate the production sandbox policy without making provider calls."""
    from app import main as app_main

    captured: dict[str, bool | None] = {}
    checkout_adapter = object()
    webhook_adapter = object()

    def checkout_factory(
        secret_key: object,
        *,
        expected_livemode: bool | None,
    ) -> object:
        captured["checkout"] = expected_livemode
        return checkout_adapter

    def webhook_factory(
        webhook_secret: object,
        *,
        expected_livemode: bool | None,
    ) -> object:
        captured["webhook"] = expected_livemode
        return webhook_adapter

    monkeypatch.setattr(app_main, "StripeCheckoutClient", checkout_factory)
    monkeypatch.setattr(app_main, "StripeWebhookVerifier", webhook_factory)

    application = app_main.create_app(settings=production_settings())

    assert captured == {"checkout": False, "webhook": False}
    assert application.state.stripe_checkout_client is checkout_adapter
    assert application.state.stripe_webhook_verifier is webhook_adapter
