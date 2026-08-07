"""Unit tests for the isolated Stripe Checkout adapter."""

from dataclasses import FrozenInstanceError
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID

import pytest
from pydantic import SecretStr

from app.payments import stripe_checkout
from app.payments.stripe_checkout import (
    CheckoutConfigurationError,
    CheckoutSessionResult,
    StripeCheckoutAmbiguousError,
    StripeCheckoutClient,
    StripeCheckoutDefinitiveError,
    StripeCheckoutRequest,
    build_stripe_idempotency_key,
    render_checkout_redirect_url,
)

PUBLIC_ORDER_NUMBER = "ROA-23456789ABCD"
ORDER_ID = UUID("32e93167-d250-4aeb-97b5-186839464176")
PAYMENT_ID = UUID("9c29c1ac-8633-46d0-9086-94de1be84bfa")
EXPIRES_AT = 1_786_104_000


def _request() -> StripeCheckoutRequest:
    return StripeCheckoutRequest(
        amount=53700,
        currency="NOK",
        public_order_number=PUBLIC_ORDER_NUMBER,
        order_id=ORDER_ID,
        payment_id=PAYMENT_ID,
        success_url="https://restaurant.example/orders/success",
        cancel_url="https://restaurant.example/orders/cancel",
        stripe_idempotency_key=(
            "checkout-session:f47ac10b-58cc-4372-a567-0e02b2c3d479"
        ),
    )


def _client(create_operation: object) -> StripeCheckoutClient:
    return StripeCheckoutClient(
        SecretStr("not-a-real-secret"),
        create_operation=create_operation,  # type: ignore[arg-type]
    )


def test_stripe_idempotency_key_is_deterministic_bounded_and_payment_scoped() -> None:
    """Build a stable provider key from only the internal Payment UUID."""
    other_payment_id = UUID("fdfe79d9-9302-4056-abf8-4d1517e10fef")
    first = build_stripe_idempotency_key(PAYMENT_ID)
    repeated = build_stripe_idempotency_key(PAYMENT_ID)
    different = build_stripe_idempotency_key(other_payment_id)
    assert first == repeated == f"checkout-session:{PAYMENT_ID}"
    assert first != different
    assert len(first) == 53
    assert len(first) <= 64
    assert "guest" not in first


def test_adapter_builds_the_exact_hosted_checkout_request() -> None:
    """Send one line item, mirrored metadata, and SDK idempotency options."""
    captured: dict[str, object] = {}

    def create_operation(*, params: object, options: object) -> object:
        captured["params"] = params
        captured["options"] = options
        return {
            "id": "cs_test_contract",
            "url": "https://checkout.stripe.example/session",
            "expires_at": EXPIRES_AT,
        }

    result = _client(create_operation).create_checkout_session(_request())

    metadata = {
        "order_id": str(ORDER_ID),
        "payment_id": str(PAYMENT_ID),
        "public_order_number": PUBLIC_ORDER_NUMBER,
    }
    assert captured["params"] == {
        "mode": "payment",
        "line_items": [
            {
                "quantity": 1,
                "price_data": {
                    "currency": "nok",
                    "unit_amount": 53700,
                    "product_data": {"name": f"Restaurant order {PUBLIC_ORDER_NUMBER}"},
                },
            }
        ],
        "success_url": "https://restaurant.example/orders/success",
        "cancel_url": "https://restaurant.example/orders/cancel",
        "metadata": metadata,
        "payment_intent_data": {"metadata": metadata},
    }
    assert captured["options"] == {
        "idempotency_key": ("checkout-session:f47ac10b-58cc-4372-a567-0e02b2c3d479")
    }
    assert result.session_id == "cs_test_contract"


def test_adapter_normalizes_provider_expiration_to_utc() -> None:
    """Convert the provider epoch timestamp to an aware UTC datetime."""

    def create_operation(*, params: object, options: object) -> object:
        return SimpleNamespace(
            id="cs_test_contract",
            url="https://checkout.stripe.example/session",
            expires_at=EXPIRES_AT,
        )

    result = _client(create_operation).create_checkout_session(_request())
    assert result.expires_at == datetime.fromtimestamp(EXPIRES_AT, tz=UTC)
    assert result.expires_at.tzinfo is UTC


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"id": "", "url": "https://checkout.stripe.example", "expires_at": 1},
        {"id": "cs_test", "url": "", "expires_at": 1},
        {
            "id": "cs_test",
            "url": "https://checkout.stripe.example",
            "expires_at": None,
        },
        {
            "id": "cs_test",
            "url": "https://checkout.stripe.example",
            "expires_at": "1786104000",
        },
        {
            "id": "cs_test",
            "url": "https://checkout.stripe.example",
            "expires_at": 10**30,
        },
    ],
)
def test_adapter_treats_missing_or_malformed_provider_responses_as_ambiguous(
    response: object,
) -> None:
    """Preserve ambiguity when Stripe response validation cannot prove success."""

    def create_operation(*, params: object, options: object) -> object:
        return response

    with pytest.raises(StripeCheckoutAmbiguousError):
        _client(create_operation).create_checkout_session(_request())


@pytest.mark.parametrize(
    "provider_error",
    [
        stripe_checkout.stripe.AuthenticationError("auth rejected"),
        stripe_checkout.stripe.InvalidRequestError("invalid request", "line_items"),
        stripe_checkout.stripe.PermissionError("permission rejected"),
        stripe_checkout.stripe.IdempotencyError("idempotency rejected"),
        stripe_checkout.stripe.CardError("card rejected", "card", "declined"),
    ],
)
def test_adapter_maps_clear_sdk_rejections_to_definitive_error(
    provider_error: Exception,
) -> None:
    """Map representative current SDK request and authentication failures."""

    def create_operation(*, params: object, options: object) -> object:
        raise provider_error

    with pytest.raises(StripeCheckoutDefinitiveError) as caught:
        _client(create_operation).create_checkout_session(_request())
    assert caught.value.__cause__ is provider_error


@pytest.mark.parametrize(
    "provider_error",
    [
        stripe_checkout.stripe.APIConnectionError("connection failed"),
        stripe_checkout.stripe.APIError("server failed", http_status=500),
        stripe_checkout.stripe.RateLimitError("rate limited"),
        RuntimeError("unknown SDK failure"),
    ],
)
def test_adapter_maps_transport_server_and_unknown_failures_to_ambiguous_error(
    provider_error: Exception,
) -> None:
    """Conservatively preserve unknown remote creation outcomes."""

    def create_operation(*, params: object, options: object) -> object:
        raise provider_error

    with pytest.raises(StripeCheckoutAmbiguousError) as caught:
        _client(create_operation).create_checkout_session(_request())
    assert caught.value.__cause__ is provider_error


@pytest.mark.parametrize(
    "template",
    [
        None,
        "",
        "/orders/{public_order_number}",
        "ftp://restaurant.example/{public_order_number}",
        "https:///orders/{public_order_number}",
        "https://user:password@restaurant.example/orders",
        "https://restaurant.example/{unknown}",
        "https://restaurant.example/{public_order_number",
        "https://restaurant.example/public_order_number}",
        ("https://restaurant.example/{public_order_number}/" "{public_order_number}"),
    ],
)
def test_redirect_url_rejects_invalid_configuration(template: str | None) -> None:
    """Reject missing, unsafe, malformed, or unsupported redirect templates."""
    with pytest.raises(CheckoutConfigurationError):
        render_checkout_redirect_url(template, PUBLIC_ORDER_NUMBER)


@pytest.mark.parametrize(
    ("template", "expected"),
    [
        (
            "https://restaurant.example/orders/{public_order_number}/success",
            f"https://restaurant.example/orders/{PUBLIC_ORDER_NUMBER}/success",
        ),
        (
            "http://localhost:5173/checkout/success",
            "http://localhost:5173/checkout/success",
        ),
    ],
)
def test_redirect_url_accepts_valid_static_or_single_placeholder_templates(
    template: str,
    expected: str,
) -> None:
    """Render the sole approved placeholder in an absolute HTTP(S) URL."""
    assert render_checkout_redirect_url(template, PUBLIC_ORDER_NUMBER) == expected


def test_redirect_url_never_inserts_an_unrequested_guest_token() -> None:
    """Substitute only the public order number into the approved placeholder."""
    rendered = render_checkout_redirect_url(
        "https://restaurant.example/orders/{public_order_number}",
        PUBLIC_ORDER_NUMBER,
    )
    assert "guest-access-token" not in rendered


def test_checkout_contract_dataclasses_are_immutable() -> None:
    """Prevent mutation of provider requests and validated results."""
    request = _request()
    result = CheckoutSessionResult(
        session_id="cs_test_contract",
        checkout_url="https://checkout.stripe.example/session",
        expires_at=datetime(2026, 8, 7, 12, tzinfo=UTC),
    )
    with pytest.raises(FrozenInstanceError):
        request.amount = 1  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        result.session_id = "changed"  # type: ignore[misc]


def test_client_rejects_an_empty_secret_before_sdk_use() -> None:
    """Fail locally when no usable provider secret is supplied."""
    with pytest.raises(CheckoutConfigurationError):
        StripeCheckoutClient(SecretStr(""), create_operation=lambda: None)
