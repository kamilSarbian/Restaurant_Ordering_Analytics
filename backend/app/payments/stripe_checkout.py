"""Narrow Stripe Checkout adapter and provider-independent contract helpers."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import stripe
from pydantic import SecretStr


class CheckoutConfigurationError(ValueError):
    """Report invalid local Stripe Checkout configuration."""


class InvalidCheckoutIdempotencyKeyError(ValueError):
    """Report a non-canonical UUIDv4 idempotency key."""


class StripeCheckoutDefinitiveError(RuntimeError):
    """Report a Stripe failure known to occur before session creation."""


class StripeCheckoutAmbiguousError(RuntimeError):
    """Report a Stripe failure whose remote creation outcome is uncertain."""


@dataclass(frozen=True)
class StripeCheckoutRequest:
    """Describe one isolated Stripe Checkout Session creation request."""

    amount: int
    currency: str
    public_order_number: str
    order_id: UUID
    payment_id: UUID
    success_url: str
    cancel_url: str
    stripe_idempotency_key: str


@dataclass(frozen=True)
class CheckoutSessionResult:
    """Represent the validated provider fields needed by the application."""

    session_id: str
    checkout_url: str
    expires_at: datetime


StripeCreateOperation = Callable[..., object]


def render_checkout_redirect_url(
    template: str | None,
    public_order_number: str,
) -> str:
    """Render and validate one configured checkout redirect URL.

    Args:
        template: Absolute HTTP(S) URL with at most one approved placeholder.
        public_order_number: Public number inserted into the approved placeholder.

    Returns:
        Validated absolute redirect URL.

    Raises:
        CheckoutConfigurationError: If the template or rendered URL is invalid.
    """
    if not template:
        raise CheckoutConfigurationError("Checkout redirect URL is not configured")

    placeholder = "{public_order_number}"
    if template.count(placeholder) > 1:
        raise CheckoutConfigurationError(
            "Checkout redirect URL contains the placeholder more than once"
        )

    remainder = template.replace(placeholder, "")
    if "{" in remainder or "}" in remainder:
        raise CheckoutConfigurationError(
            "Checkout redirect URL contains an unsupported or unmatched placeholder"
        )

    rendered_url = template.replace(placeholder, public_order_number)
    try:
        parsed = urlsplit(rendered_url)
        hostname = parsed.hostname
        username = parsed.username
        password = parsed.password
        _ = parsed.port
    except ValueError as exc:
        raise CheckoutConfigurationError("Checkout redirect URL is malformed") from exc

    if parsed.scheme.lower() not in {"http", "https"} or not hostname:
        raise CheckoutConfigurationError(
            "Checkout redirect URL must be an absolute HTTP(S) URL with a host"
        )
    if username is not None or password is not None:
        raise CheckoutConfigurationError(
            "Checkout redirect URL must not contain credentials"
        )
    return rendered_url


def parse_checkout_idempotency_key(value: str | None) -> UUID:
    """Parse a canonical lowercase hyphenated UUIDv4 idempotency key.

    Args:
        value: Untrusted idempotency-key header value.

    Returns:
        Parsed UUIDv4 value.

    Raises:
        InvalidCheckoutIdempotencyKeyError: If the value is not canonical UUIDv4
            text.
    """
    try:
        parsed = UUID(value)
    except (AttributeError, TypeError, ValueError) as exc:
        raise InvalidCheckoutIdempotencyKeyError(
            "Idempotency key must be a canonical UUIDv4"
        ) from exc
    if parsed.version != 4 or value != str(parsed):
        raise InvalidCheckoutIdempotencyKeyError(
            "Idempotency key must be a canonical UUIDv4"
        )
    return parsed


def build_stripe_idempotency_key(payment_id: UUID) -> str:
    """Build the stable provider idempotency key for a checkout request."""
    return f"checkout-session:{payment_id}"


class StripeCheckoutClient:
    """Create Stripe-hosted Checkout Sessions through an isolated SDK client."""

    def __init__(
        self,
        secret_key: SecretStr,
        *,
        expected_livemode: bool | None = None,
        create_operation: StripeCreateOperation | None = None,
    ) -> None:
        """Initialize the adapter with an isolated client or injected test seam.

        Args:
            secret_key: Stripe account secret stored in a protected value.
            expected_livemode: Optional provider-mode policy for returned sessions.
            create_operation: Optional narrow SDK-compatible creation callable.

        Raises:
            CheckoutConfigurationError: If the configured secret is empty.
        """
        raw_secret = secret_key.get_secret_value()
        if not raw_secret:
            raise CheckoutConfigurationError("Stripe secret key is not configured")
        if expected_livemode is not None and not isinstance(expected_livemode, bool):
            raise CheckoutConfigurationError("Stripe livemode policy is invalid")

        self._expected_livemode = expected_livemode
        if create_operation is None:
            client = stripe.StripeClient(raw_secret)
            self._create_operation = client.v1.checkout.sessions.create
        else:
            self._create_operation = create_operation

    def create_checkout_session(
        self,
        request: StripeCheckoutRequest,
    ) -> CheckoutSessionResult:
        """Create and validate one hosted Checkout Session.

        Args:
            request: Provider-ready checkout creation contract.

        Returns:
            Validated minimal session result.

        Raises:
            StripeCheckoutDefinitiveError: If Stripe clearly rejected the request.
            StripeCheckoutAmbiguousError: If remote creation may have occurred.
        """
        metadata = {
            "order_id": str(request.order_id),
            "payment_id": str(request.payment_id),
            "public_order_number": request.public_order_number,
        }
        params: dict[str, Any] = {
            "mode": "payment",
            "line_items": [
                {
                    "quantity": 1,
                    "price_data": {
                        "currency": request.currency.lower(),
                        "unit_amount": request.amount,
                        "product_data": {
                            "name": (f"Restaurant order {request.public_order_number}")
                        },
                    },
                }
            ],
            "success_url": request.success_url,
            "cancel_url": request.cancel_url,
            "metadata": metadata,
            "payment_intent_data": {"metadata": metadata.copy()},
        }
        options = {"idempotency_key": request.stripe_idempotency_key}

        try:
            response = self._create_operation(params=params, options=options)
        except (
            stripe.AuthenticationError,
            stripe.CardError,
            stripe.IdempotencyError,
            stripe.InvalidRequestError,
            stripe.PermissionError,
        ) as exc:
            raise StripeCheckoutDefinitiveError(
                "Stripe definitively rejected Checkout Session creation"
            ) from exc
        except (
            stripe.APIConnectionError,
            stripe.APIError,
            stripe.RateLimitError,
            stripe.StripeError,
        ) as exc:
            raise StripeCheckoutAmbiguousError(
                "Stripe Checkout Session creation outcome is ambiguous"
            ) from exc
        except Exception as exc:
            raise StripeCheckoutAmbiguousError(
                "Stripe Checkout Session creation outcome is ambiguous"
            ) from exc

        return _validate_checkout_session_response(
            response,
            expected_livemode=self._expected_livemode,
        )


def _validate_checkout_session_response(
    response: object,
    *,
    expected_livemode: bool | None,
) -> CheckoutSessionResult:
    """Validate the minimal provider response without assuming one SDK shape."""
    session_id = _provider_field(response, "id")
    checkout_url = _provider_field(response, "url")
    expires_at = _provider_field(response, "expires_at")
    livemode = _provider_field(response, "livemode")

    if expected_livemode is not None and (
        not isinstance(livemode, bool) or livemode is not expected_livemode
    ):
        raise StripeCheckoutAmbiguousError(
            "Stripe response does not match the configured provider mode"
        )

    if not isinstance(session_id, str) or not session_id.strip():
        raise StripeCheckoutAmbiguousError(
            "Stripe response is missing a valid Checkout Session identifier"
        )
    if not isinstance(checkout_url, str) or not checkout_url.strip():
        raise StripeCheckoutAmbiguousError(
            "Stripe response is missing a valid Checkout Session URL"
        )
    if isinstance(expires_at, bool) or not isinstance(expires_at, int):
        raise StripeCheckoutAmbiguousError(
            "Stripe response contains an invalid Checkout Session expiration"
        )

    try:
        expiration = datetime.fromtimestamp(expires_at, tz=UTC)
    except (OSError, OverflowError, ValueError) as exc:
        raise StripeCheckoutAmbiguousError(
            "Stripe response contains an invalid Checkout Session expiration"
        ) from exc

    return CheckoutSessionResult(
        session_id=session_id,
        checkout_url=checkout_url,
        expires_at=expiration,
    )


def _provider_field(response: object, field_name: str) -> object:
    """Read a provider field from either a mapping or Stripe resource object."""
    if isinstance(response, Mapping):
        return response.get(field_name)
    return getattr(response, field_name, None)
