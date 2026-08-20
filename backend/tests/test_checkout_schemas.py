"""Unit tests for checkout schemas, settings, and idempotency helpers."""

from datetime import UTC, datetime
from uuid import UUID, uuid1, uuid3, uuid4, uuid5

import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import Settings
from app.payments.schemas import CheckoutSessionResponse
from app.payments.statuses import PaymentStatus
from app.payments.stripe_checkout import (
    InvalidCheckoutIdempotencyKeyError,
    build_stripe_idempotency_key,
    parse_checkout_idempotency_key,
)

PUBLIC_ORDER_NUMBER = "ROA-23456789ABCD"


def _response_values() -> dict[str, object]:
    return {
        "public_order_number": PUBLIC_ORDER_NUMBER,
        "payment_status": PaymentStatus.PENDING,
        "checkout_url": "https://checkout.stripe.example/session",
        "expires_at": datetime(2026, 8, 7, 12, tzinfo=UTC),
    }


def test_checkout_response_accepts_the_exact_public_contract() -> None:
    """Accept all four strict public response fields."""
    response = CheckoutSessionResponse(**_response_values())
    assert response.public_order_number == PUBLIC_ORDER_NUMBER
    assert response.payment_status is PaymentStatus.PENDING
    assert response.checkout_url == "https://checkout.stripe.example/session"
    assert response.expires_at.tzinfo is UTC
    assert set(CheckoutSessionResponse.model_fields) == {
        "public_order_number",
        "payment_status",
        "checkout_url",
        "expires_at",
    }


@pytest.mark.parametrize(
    "field_name",
    [
        "order_id",
        "payment_id",
        "stripe_checkout_session_id",
        "request_idempotency_key",
        "stripe_idempotency_key",
    ],
)
def test_checkout_response_rejects_internal_identifiers(field_name: str) -> None:
    """Forbid representative internal identifiers as extra response fields."""
    values = _response_values()
    values[field_name] = str(uuid4())
    with pytest.raises(ValidationError):
        CheckoutSessionResponse(**values)


@pytest.mark.parametrize(
    "public_order_number",
    ["invalid", "ROA-0123456789AB", "roa-23456789abcd", "ROA-23456789ABCDE"],
)
def test_checkout_response_rejects_invalid_public_order_numbers(
    public_order_number: str,
) -> None:
    """Apply the established public order number pattern."""
    values = _response_values()
    values["public_order_number"] = public_order_number
    with pytest.raises(ValidationError):
        CheckoutSessionResponse(**values)


def test_checkout_response_rejects_empty_checkout_url() -> None:
    """Require a nonempty hosted checkout URL."""
    values = _response_values()
    values["checkout_url"] = ""
    with pytest.raises(ValidationError):
        CheckoutSessionResponse(**values)


def test_checkout_response_rejects_naive_expiration() -> None:
    """Require timezone-aware session expiration values."""
    values = _response_values()
    values["expires_at"] = datetime(2026, 8, 7, 12)
    with pytest.raises(ValidationError):
        CheckoutSessionResponse(**values)


@pytest.mark.parametrize(
    ("field_name", "value"),
    [("payment_status", "pending"), ("checkout_url", 123)],
)
def test_checkout_response_rejects_non_strict_field_values(
    field_name: str,
    value: object,
) -> None:
    """Reject coercion for strict public response fields."""
    values = _response_values()
    values[field_name] = value
    with pytest.raises(ValidationError):
        CheckoutSessionResponse(**values)


def test_stripe_settings_are_optional_without_environment_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep application construction safe before Stripe is configured."""
    for variable_name in (
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_SUCCESS_URL",
        "STRIPE_CANCEL_URL",
    ):
        monkeypatch.delenv(variable_name, raising=False)
    settings = Settings(_env_file=None)
    assert settings.stripe_secret_key is None
    assert settings.stripe_webhook_secret is None
    assert settings.stripe_success_url is None
    assert settings.stripe_cancel_url is None


def test_stripe_settings_load_from_the_approved_environment_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Load exactly the approved Stripe configuration values from the environment."""
    monkeypatch.setenv("STRIPE_SECRET_KEY", "not-a-real-secret")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "not-a-real-webhook-secret")
    monkeypatch.setenv(
        "STRIPE_SUCCESS_URL",
        "https://restaurant.example/orders/{public_order_number}/success",
    )
    monkeypatch.setenv(
        "STRIPE_CANCEL_URL",
        "https://restaurant.example/orders/{public_order_number}/cancel",
    )
    settings = Settings(_env_file=None)
    assert isinstance(settings.stripe_secret_key, SecretStr)
    assert settings.stripe_secret_key.get_secret_value() == "not-a-real-secret"
    assert isinstance(settings.stripe_webhook_secret, SecretStr)
    assert (
        settings.stripe_webhook_secret.get_secret_value() == "not-a-real-webhook-secret"
    )
    assert settings.stripe_success_url.endswith("/success")
    assert settings.stripe_cancel_url.endswith("/cancel")


def test_settings_representation_does_not_reveal_stripe_secrets() -> None:
    """Exclude both raw Stripe secrets from settings representations."""
    raw_api_secret = "not-a-real-api-secret"
    raw_webhook_secret = "not-a-real-webhook-secret"
    settings = Settings(
        _env_file=None,
        stripe_secret_key=raw_api_secret,
        stripe_webhook_secret=raw_webhook_secret,
    )
    for raw_secret in (raw_api_secret, raw_webhook_secret):
        assert raw_secret not in repr(settings)
        assert raw_secret not in str(settings)


AUTH_ENVIRONMENT_NAMES = (
    "AUTH_JWT_SECRET",
    "AUTH_ACCESS_TOKEN_EXPIRE_MINUTES",
    "ADMIN_JWT_SECRET",
    "ADMIN_ACCESS_TOKEN_EXPIRE_MINUTES",
)


def _clear_auth_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for variable_name in AUTH_ENVIRONMENT_NAMES:
        monkeypatch.delenv(variable_name, raising=False)


def test_auth_settings_are_optional_with_the_approved_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Allow startup without a JWT secret and default access tokens to 30 minutes."""
    _clear_auth_environment(monkeypatch)
    settings = Settings(_env_file=None)
    assert settings.auth_jwt_secret is None
    assert settings.auth_access_token_expire_minutes == 30


def test_auth_settings_load_from_canonical_environment_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expose canonical effective values from canonical AUTH inputs."""
    _clear_auth_environment(monkeypatch)
    raw_secret = "c" * 32
    monkeypatch.setenv("AUTH_JWT_SECRET", raw_secret)
    monkeypatch.setenv("AUTH_ACCESS_TOKEN_EXPIRE_MINUTES", "45")
    settings = Settings(_env_file=None)
    assert isinstance(settings.auth_jwt_secret, SecretStr)
    assert settings.auth_jwt_secret.get_secret_value() == raw_secret
    assert settings.auth_access_token_expire_minutes == 45


def test_legacy_auth_environment_names_do_not_configure_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ignore removed ADMIN inputs instead of enabling authentication."""
    _clear_auth_environment(monkeypatch)
    raw_secret = "l" * 32
    monkeypatch.setenv("ADMIN_JWT_SECRET", raw_secret)
    monkeypatch.setenv("ADMIN_ACCESS_TOKEN_EXPIRE_MINUTES", "44")
    settings = Settings(_env_file=None)
    assert settings.auth_jwt_secret is None
    assert settings.auth_access_token_expire_minutes == 30


def test_canonical_auth_inputs_ignore_removed_legacy_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Use canonical values even when obsolete environment names are present."""
    _clear_auth_environment(monkeypatch)
    raw_secret = "e" * 32
    monkeypatch.setenv("AUTH_JWT_SECRET", raw_secret)
    monkeypatch.setenv("ADMIN_JWT_SECRET", "l" * 32)
    monkeypatch.setenv("AUTH_ACCESS_TOKEN_EXPIRE_MINUTES", "43")
    monkeypatch.setenv("ADMIN_ACCESS_TOKEN_EXPIRE_MINUTES", "44")
    settings = Settings(_env_file=None)
    assert settings.auth_jwt_secret is not None
    assert settings.auth_jwt_secret.get_secret_value() == raw_secret
    assert settings.auth_access_token_expire_minutes == 43


def test_removed_legacy_secret_cannot_create_a_conflict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Treat a removed legacy secret as unrelated ignored configuration."""
    _clear_auth_environment(monkeypatch)
    canonical_secret = "c" * 32
    legacy_secret = "l" * 32
    monkeypatch.setenv("AUTH_JWT_SECRET", canonical_secret)
    monkeypatch.setenv("ADMIN_JWT_SECRET", legacy_secret)
    settings = Settings(_env_file=None)
    assert settings.auth_jwt_secret is not None
    assert settings.auth_jwt_secret.get_secret_value() == canonical_secret
    assert legacy_secret not in repr(settings)


def test_removed_legacy_expiry_does_not_change_the_canonical_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ignore the removed TTL name when no canonical TTL is configured."""
    _clear_auth_environment(monkeypatch)
    monkeypatch.setenv("ADMIN_ACCESS_TOKEN_EXPIRE_MINUTES", "31")
    settings = Settings(_env_file=None)
    assert settings.auth_access_token_expire_minutes == 30


def test_auth_jwt_secret_is_absent_from_settings_representations() -> None:
    """Keep raw generic signing key material out of Settings text."""
    raw_secret = "representation-safe-synthetic-key"
    settings = Settings(_env_file=None, auth_jwt_secret=raw_secret)
    assert raw_secret not in repr(settings)
    assert raw_secret not in str(settings)


@pytest.mark.parametrize("raw_secret", ["", " " * 32, "s" * 31])
def test_auth_jwt_secret_rejects_blank_or_short_values(raw_secret: str) -> None:
    """Reject blank key material and values shorter than 32 UTF-8 bytes."""
    with pytest.raises(ValidationError):
        Settings(_env_file=None, auth_jwt_secret=raw_secret)


def test_auth_jwt_secret_accepts_exactly_thirty_two_bytes_unchanged() -> None:
    """Accept the exact byte boundary without trimming the configured value."""
    raw_secret = " " + "s" * 31
    settings = Settings(_env_file=None, auth_jwt_secret=raw_secret)
    assert settings.auth_jwt_secret is not None
    assert settings.auth_jwt_secret.get_secret_value() == raw_secret


def test_auth_jwt_secret_uses_utf8_byte_length() -> None:
    """Measure multi-byte key material by UTF-8 bytes instead of code points."""
    accepted_secret = "\N{LOCK}" * 8
    rejected_secret = "\N{LOCK}" * 7
    settings = Settings(_env_file=None, auth_jwt_secret=accepted_secret)
    assert settings.auth_jwt_secret is not None
    assert settings.auth_jwt_secret.get_secret_value() == accepted_secret
    with pytest.raises(ValidationError):
        Settings(_env_file=None, auth_jwt_secret=rejected_secret)


@pytest.mark.parametrize("minutes", [1, 60])
def test_auth_access_token_ttl_accepts_boundaries(minutes: int) -> None:
    """Accept both approved generic access-token lifetime boundaries."""
    settings = Settings(
        _env_file=None,
        auth_access_token_expire_minutes=minutes,
    )
    assert settings.auth_access_token_expire_minutes == minutes


@pytest.mark.parametrize("minutes", [0, 61])
def test_auth_access_token_ttl_rejects_out_of_range_values(minutes: int) -> None:
    """Reject generic access-token lifetimes outside 1 through 60 minutes."""
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            auth_access_token_expire_minutes=minutes,
        )


def test_app_construction_does_not_require_a_webhook_secret() -> None:
    """Keep the general application available before webhook configuration."""
    from app.main import create_app

    settings = Settings(_env_file=None)
    application = create_app(settings=settings)
    assert settings.stripe_webhook_secret is None
    assert settings.auth_jwt_secret is None
    assert application.title == settings.app_name


def test_parse_checkout_idempotency_key_accepts_canonical_uuid4() -> None:
    """Return a UUID for lowercase canonical UUIDv4 text."""
    raw_value = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
    parsed = parse_checkout_idempotency_key(raw_value)
    assert parsed == UUID(raw_value)
    assert parsed.version == 4


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "not-a-uuid",
        "F47AC10B-58CC-4372-A567-0E02B2C3D479",
        "f47ac10b58cc4372a5670e02b2c3d479",
        "{f47ac10b-58cc-4372-a567-0e02b2c3d479}",
        str(uuid1()),
        str(uuid3(UUID(int=0), "request")),
        str(uuid5(UUID(int=0), "request")),
    ],
)
def test_parse_checkout_idempotency_key_rejects_noncanonical_or_non_v4(
    value: str | None,
) -> None:
    """Reject malformed, alternate-format, and wrong-version UUID values."""
    with pytest.raises(InvalidCheckoutIdempotencyKeyError):
        parse_checkout_idempotency_key(value)


def test_build_stripe_idempotency_key_has_the_exact_stable_format() -> None:
    """Prefix the canonical UUID without exceeding the approved length."""
    payment_id = UUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")
    provider_key = build_stripe_idempotency_key(payment_id)
    assert provider_key == f"checkout-session:{payment_id}"
    assert len(provider_key) == 53
