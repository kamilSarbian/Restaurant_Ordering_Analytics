"""Verify Stripe webhook signatures and extract minimal provider facts."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

import stripe
from pydantic import SecretStr

DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300
VERIFICATION_ERROR_MESSAGE = "Stripe webhook verification failed"


class StripeWebhookConfigurationError(ValueError):
    """Report unusable local Stripe webhook verifier configuration."""


class StripeWebhookVerificationError(ValueError):
    """Report a webhook that cannot produce a trusted provider event."""


class StripeWebhookEventType(StrEnum):
    """Enumerate Checkout event types processed by Stage 10."""

    COMPLETED = "checkout.session.completed"
    ASYNC_PAYMENT_SUCCEEDED = "checkout.session.async_payment_succeeded"
    ASYNC_PAYMENT_FAILED = "checkout.session.async_payment_failed"
    EXPIRED = "checkout.session.expired"


@dataclass(frozen=True)
class VerifiedStripeCheckoutEvent:
    """Carry verified Checkout facts without applying business decisions."""

    stripe_event_id: str
    event_type: StripeWebhookEventType
    livemode: bool
    stripe_created_at: datetime
    stripe_checkout_session_id: str
    session_status: str | None
    payment_status: str | None
    mode: str | None
    amount_total: int | None
    currency: str | None
    metadata_payment_id: str | None
    metadata_order_id: str | None
    metadata_public_order_number: str | None


@dataclass(frozen=True)
class IgnoredStripeEvent:
    """Carry core facts for a verified event outside the Stage 10 allowlist."""

    stripe_event_id: str
    event_type: str
    livemode: bool
    stripe_created_at: datetime


StripeConstructEventOperation = Callable[..., object]
VerifiedStripeEvent = VerifiedStripeCheckoutEvent | IgnoredStripeEvent


class StripeWebhookVerifier:
    """Verify raw Stripe payloads and return minimal immutable event data."""

    def __init__(
        self,
        webhook_secret: str | SecretStr,
        *,
        tolerance_seconds: int = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
        construct_event: StripeConstructEventOperation | None = None,
    ) -> None:
        """Configure local signature verification without mutating Stripe globals.

        Args:
            webhook_secret: Endpoint signing secret protected in memory.
            tolerance_seconds: Maximum accepted signature age in seconds.
            construct_event: Optional SDK-compatible verifier used by tests.

        Raises:
            StripeWebhookConfigurationError: If tolerance is not positive.
        """
        if isinstance(tolerance_seconds, bool) or tolerance_seconds <= 0:
            raise StripeWebhookConfigurationError(
                "Stripe webhook tolerance must be a positive integer"
            )
        self._webhook_secret = (
            webhook_secret
            if isinstance(webhook_secret, SecretStr)
            else SecretStr(webhook_secret)
        )
        self._tolerance_seconds = tolerance_seconds
        self._construct_event = construct_event or stripe.Webhook.construct_event

    def verify(
        self,
        payload: bytes,
        signature_header: str,
    ) -> VerifiedStripeEvent:
        """Verify untouched request bytes and extract trusted provider facts.

        Args:
            payload: Exact raw HTTP request body bytes.
            signature_header: Unmodified Stripe-Signature header value.

        Returns:
            A verified Checkout event or an ignored out-of-scope event.

        Raises:
            StripeWebhookConfigurationError: If the signing secret is empty.
            StripeWebhookVerificationError: If signature, JSON, or core provider
                structure is invalid.
        """
        raw_secret = self._webhook_secret.get_secret_value()
        if not raw_secret:
            raise StripeWebhookConfigurationError(
                "Stripe webhook secret is not configured"
            )

        verified_event: object | None = None
        try:
            verified_event = self._construct_event(
                payload,
                signature_header,
                raw_secret,
                tolerance=self._tolerance_seconds,
            )
        except (
            AttributeError,
            TypeError,
            UnicodeError,
            ValueError,
            stripe.SignatureVerificationError,
        ):
            pass
        if verified_event is None:
            raise StripeWebhookVerificationError(VERIFICATION_ERROR_MESSAGE)

        return _extract_verified_event(verified_event)


def _extract_verified_event(event: object) -> VerifiedStripeEvent:
    stripe_event_id = _required_nonblank_string(_provider_field(event, "id"))
    event_type = _required_nonblank_string(_provider_field(event, "type"))
    livemode = _provider_field(event, "livemode")
    if not isinstance(livemode, bool):
        raise StripeWebhookVerificationError(VERIFICATION_ERROR_MESSAGE)
    stripe_created_at = _provider_timestamp(_provider_field(event, "created"))

    try:
        checkout_event_type = StripeWebhookEventType(event_type)
    except ValueError:
        return IgnoredStripeEvent(
            stripe_event_id=stripe_event_id,
            event_type=event_type,
            livemode=livemode,
            stripe_created_at=stripe_created_at,
        )

    data = _provider_field(event, "data")
    checkout_session = _provider_field(data, "object")
    session_id = _required_nonblank_string(_provider_field(checkout_session, "id"))
    metadata = _provider_field(checkout_session, "metadata")
    return VerifiedStripeCheckoutEvent(
        stripe_event_id=stripe_event_id,
        event_type=checkout_event_type,
        livemode=livemode,
        stripe_created_at=stripe_created_at,
        stripe_checkout_session_id=session_id,
        session_status=_optional_string(_provider_field(checkout_session, "status")),
        payment_status=_optional_string(
            _provider_field(checkout_session, "payment_status")
        ),
        mode=_optional_string(_provider_field(checkout_session, "mode")),
        amount_total=_optional_integer(
            _provider_field(checkout_session, "amount_total")
        ),
        currency=_optional_string(_provider_field(checkout_session, "currency")),
        metadata_payment_id=_optional_string(_provider_field(metadata, "payment_id")),
        metadata_order_id=_optional_string(_provider_field(metadata, "order_id")),
        metadata_public_order_number=_optional_string(
            _provider_field(metadata, "public_order_number")
        ),
    )


def _provider_field(resource: object, field_name: str) -> object:
    if isinstance(resource, Mapping):
        return resource.get(field_name)
    return getattr(resource, field_name, None)


def _required_nonblank_string(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise StripeWebhookVerificationError(VERIFICATION_ERROR_MESSAGE)
    return value


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _optional_integer(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _provider_timestamp(value: object) -> datetime:
    if isinstance(value, bool) or not isinstance(value, int):
        raise StripeWebhookVerificationError(VERIFICATION_ERROR_MESSAGE)
    converted: datetime | None = None
    try:
        converted = datetime.fromtimestamp(value, tz=UTC)
    except (OSError, OverflowError, ValueError):
        pass
    if converted is None:
        raise StripeWebhookVerificationError(VERIFICATION_ERROR_MESSAGE)
    return converted
