"""Unit tests for the offline Stripe webhook verification adapter."""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import time
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime
from typing import Any

import pytest
import stripe
from pydantic import SecretStr

from app.payments.stripe_webhook import (
    DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
    IgnoredStripeEvent,
    StripeWebhookConfigurationError,
    StripeWebhookEventType,
    StripeWebhookVerificationError,
    StripeWebhookVerifier,
    VerifiedStripeCheckoutEvent,
)

TEST_SECRET = "local-test-only-webhook-secret"
OTHER_TEST_SECRET = "different-local-test-only-secret"
EVENT_CREATED = 1_786_104_000
PUBLIC_ORDER_NUMBER = "ROA-23456789ABCD"
PAYMENT_ID = "9c29c1ac-8633-46d0-9086-94de1be84bfa"
ORDER_ID = "32e93167-d250-4aeb-97b5-186839464176"
EVENT_TYPES = tuple(item.value for item in StripeWebhookEventType)


def _event(
    *,
    event_type: str = StripeWebhookEventType.COMPLETED.value,
) -> dict[str, Any]:
    return {
        "id": "evt_test_verified_contract",
        "object": "event",
        "created": EVENT_CREATED,
        "livemode": False,
        "type": event_type,
        "data": {
            "object": {
                "id": "cs_test_verified_contract",
                "object": "checkout.session",
                "status": "complete",
                "payment_status": "paid",
                "mode": "payment",
                "amount_total": 53700,
                "currency": "nok",
                "metadata": {
                    "payment_id": PAYMENT_ID,
                    "order_id": ORDER_ID,
                    "public_order_number": PUBLIC_ORDER_NUMBER,
                },
            }
        },
    }


def _payload(
    *,
    event_type: str = StripeWebhookEventType.COMPLETED.value,
) -> bytes:
    return json.dumps(
        _event(event_type=event_type),
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _signature(payload: bytes, secret: str, timestamp: int) -> str:
    signed_payload = f"{timestamp}.{payload.decode('utf-8')}".encode()
    digest = hmac.new(
        secret.encode(),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()
    return f"t={timestamp},v1={digest}"


def _injected_verifier(
    event: object,
    *,
    expected_livemode: bool | None = None,
) -> StripeWebhookVerifier:
    def construct_event(
        payload: bytes,
        signature_header: str,
        secret: str,
        *,
        tolerance: int,
    ) -> object:
        return event

    return StripeWebhookVerifier(
        SecretStr(TEST_SECRET),
        expected_livemode=expected_livemode,
        construct_event=construct_event,
    )


def test_actual_sdk_verifies_untouched_raw_payload_offline() -> None:
    """Use the installed Stripe SDK without making a provider request."""
    payload = _payload()
    timestamp = int(time.time())
    original_api_key = stripe.api_key

    result = StripeWebhookVerifier(SecretStr(TEST_SECRET)).verify(
        payload,
        _signature(payload, TEST_SECRET, timestamp),
    )

    assert isinstance(result, VerifiedStripeCheckoutEvent)
    assert result.stripe_event_id == "evt_test_verified_contract"
    assert stripe.api_key == original_api_key


def test_changing_one_payload_byte_invalidates_the_sdk_signature() -> None:
    """Prove that verified bytes cannot be normalized or modified."""
    payload = _payload()
    signature = _signature(payload, TEST_SECRET, int(time.time()))
    changed_payload = payload.replace(b'"nok"', b'"sek"', 1)
    assert changed_payload != payload

    with pytest.raises(StripeWebhookVerificationError):
        StripeWebhookVerifier(TEST_SECRET).verify(changed_payload, signature)


def test_wrong_secret_invalidates_the_sdk_signature() -> None:
    """Reject a locally signed payload when the verifier uses another secret."""
    payload = _payload()
    signature = _signature(payload, TEST_SECRET, int(time.time()))
    with pytest.raises(StripeWebhookVerificationError):
        StripeWebhookVerifier(OTHER_TEST_SECRET).verify(payload, signature)


def test_stale_signature_uses_the_default_five_minute_tolerance() -> None:
    """Map an authentic but stale delivery to the stable verification error."""
    payload = _payload()
    stale_timestamp = int(time.time()) - DEFAULT_WEBHOOK_TOLERANCE_SECONDS - 1
    signature = _signature(payload, TEST_SECRET, stale_timestamp)
    with pytest.raises(StripeWebhookVerificationError):
        StripeWebhookVerifier(TEST_SECRET).verify(payload, signature)


def test_malformed_signed_json_maps_to_verification_error() -> None:
    """Reject malformed JSON only after its local SDK signature validates."""
    payload = b'{"id":"evt_test_malformed"'
    signature = _signature(payload, TEST_SECRET, int(time.time()))
    with pytest.raises(StripeWebhookVerificationError):
        StripeWebhookVerifier(TEST_SECRET).verify(payload, signature)


def test_signed_json_with_unusable_root_maps_to_verification_error() -> None:
    """Hide SDK shape errors for JSON that cannot construct a Stripe Event."""
    payload = b"[]"
    signature = _signature(payload, TEST_SECRET, int(time.time()))
    with pytest.raises(StripeWebhookVerificationError):
        StripeWebhookVerifier(TEST_SECRET).verify(payload, signature)


def test_invalid_signature_error_exposes_no_sensitive_input() -> None:
    """Keep payload, header, secret, and Stripe exception details private."""
    payload_marker = b'{"payload-marker":true}'
    signature_marker = "signature-marker"
    secret_marker = "secret-marker"
    with pytest.raises(StripeWebhookVerificationError) as caught:
        StripeWebhookVerifier(secret_marker).verify(
            payload_marker,
            signature_marker,
        )
    message = str(caught.value)
    assert secret_marker not in message
    assert signature_marker not in message
    assert payload_marker.decode() not in message
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_injected_verifier_receives_identical_raw_bytes_and_header() -> None:
    """Forward the same bytes object and unparsed signature header unchanged."""
    payload = b'{ "data": { "spacing": "must stay unchanged" } }'
    signature_header = "t=123,v1=unchanged-test-signature"
    captured: dict[str, object] = {}

    def construct_event(
        received_payload: bytes,
        received_header: str,
        received_secret: str,
        *,
        tolerance: int,
    ) -> object:
        captured["payload"] = received_payload
        captured["header"] = received_header
        captured["secret"] = received_secret
        captured["tolerance"] = tolerance
        return _event()

    result = StripeWebhookVerifier(
        SecretStr(TEST_SECRET),
        construct_event=construct_event,
    ).verify(payload, signature_header)

    assert isinstance(result, VerifiedStripeCheckoutEvent)
    assert captured["payload"] is payload
    assert captured["header"] is signature_header
    assert captured["secret"] == TEST_SECRET
    assert captured["tolerance"] == 300


def test_custom_positive_tolerance_is_forwarded() -> None:
    """Permit an explicit positive tolerance without changing SDK globals."""
    captured: dict[str, int] = {}

    def construct_event(
        payload: bytes,
        signature_header: str,
        secret: str,
        *,
        tolerance: int,
    ) -> object:
        captured["tolerance"] = tolerance
        return _event()

    StripeWebhookVerifier(
        TEST_SECRET,
        tolerance_seconds=120,
        construct_event=construct_event,
    ).verify(b"{}", "unchanged")
    assert captured["tolerance"] == 120


@pytest.mark.parametrize("tolerance", [0, -1, True])
def test_nonpositive_or_boolean_tolerance_is_rejected(tolerance: int) -> None:
    """Reject tolerance values that disable or confuse recency validation."""
    with pytest.raises(StripeWebhookConfigurationError):
        StripeWebhookVerifier(TEST_SECRET, tolerance_seconds=tolerance)


def test_nonboolean_livemode_policy_is_rejected() -> None:
    """Reject an ambiguous deployment policy before webhook verification."""
    with pytest.raises(StripeWebhookConfigurationError, match="livemode policy"):
        StripeWebhookVerifier(
            TEST_SECRET,
            expected_livemode="false",  # type: ignore[arg-type]
        )


def test_empty_secret_is_rejected_only_when_verification_is_used() -> None:
    """Keep construction possible while failing before an SDK verification call."""
    called = False

    def construct_event(*args: object, **kwargs: object) -> object:
        nonlocal called
        called = True
        return _event()

    verifier = StripeWebhookVerifier("", construct_event=construct_event)
    with pytest.raises(StripeWebhookConfigurationError):
        verifier.verify(b"{}", "unused")
    assert called is False


@pytest.mark.parametrize("event_type", EVENT_TYPES)
def test_each_in_scope_checkout_event_extracts_minimal_provider_facts(
    event_type: str,
) -> None:
    """Extract the approved facts from every Stage 10 Checkout event."""
    result = _injected_verifier(_event(event_type=event_type)).verify(
        b"unchanged",
        "unchanged",
    )

    assert isinstance(result, VerifiedStripeCheckoutEvent)
    assert result.stripe_event_id == "evt_test_verified_contract"
    assert result.event_type is StripeWebhookEventType(event_type)
    assert result.livemode is False
    assert result.stripe_created_at == datetime.fromtimestamp(EVENT_CREATED, tz=UTC)
    assert result.stripe_created_at.tzinfo is UTC
    assert result.stripe_checkout_session_id == "cs_test_verified_contract"
    assert result.session_status == "complete"
    assert result.payment_status == "paid"
    assert result.mode == "payment"
    assert result.amount_total == 53700
    assert result.currency == "nok"
    assert result.metadata_payment_id == PAYMENT_ID
    assert result.metadata_order_id == ORDER_ID
    assert result.metadata_public_order_number == PUBLIC_ORDER_NUMBER


def test_missing_business_data_remains_a_verified_checkout_event() -> None:
    """Leave absent reconciliation facts as None after authentic verification."""
    event = _event()
    event["data"]["object"] = {  # type: ignore[index]
        "id": "cs_test_missing_business_data",
        "object": "checkout.session",
    }

    result = _injected_verifier(event).verify(b"unchanged", "unchanged")

    assert isinstance(result, VerifiedStripeCheckoutEvent)
    assert result.stripe_checkout_session_id == "cs_test_missing_business_data"
    assert result.session_status is None
    assert result.payment_status is None
    assert result.mode is None
    assert result.amount_total is None
    assert result.currency is None
    assert result.metadata_payment_id is None
    assert result.metadata_order_id is None
    assert result.metadata_public_order_number is None


def test_malformed_business_data_becomes_optional_none() -> None:
    """Defer malformed correlation and money facts to future reconciliation."""
    event = _event()
    session = event["data"]["object"]  # type: ignore[index]
    session.update(  # type: ignore[union-attr]
        {
            "status": 1,
            "payment_status": False,
            "mode": ["payment"],
            "amount_total": True,
            "currency": 123,
            "metadata": ["not", "a", "mapping"],
        }
    )

    result = _injected_verifier(event).verify(b"unchanged", "unchanged")

    assert isinstance(result, VerifiedStripeCheckoutEvent)
    assert result.session_status is None
    assert result.payment_status is None
    assert result.mode is None
    assert result.amount_total is None
    assert result.currency is None
    assert result.metadata_payment_id is None
    assert result.metadata_order_id is None
    assert result.metadata_public_order_number is None


def _structurally_invalid_event(case: str) -> dict[str, Any]:
    event = copy.deepcopy(_event())
    session = event["data"]["object"]
    if case == "missing_event_id":
        event.pop("id")
    elif case == "blank_event_id":
        event["id"] = "   "
    elif case == "missing_event_type":
        event.pop("type")
    elif case == "blank_event_type":
        event["type"] = ""
    elif case == "invalid_created_type":
        event["created"] = "not-a-timestamp"
    elif case == "invalid_created_range":
        event["created"] = 10**30
    elif case == "invalid_livemode":
        event["livemode"] = 0
    elif case == "missing_livemode":
        event.pop("livemode")
    elif case == "missing_session_id":
        session.pop("id")
    elif case == "blank_session_id":
        session["id"] = "   "
    return event


@pytest.mark.parametrize(
    "case",
    [
        "missing_event_id",
        "blank_event_id",
        "missing_event_type",
        "blank_event_type",
        "invalid_created_type",
        "invalid_created_range",
        "invalid_livemode",
        "missing_livemode",
        "missing_session_id",
        "blank_session_id",
    ],
)
def test_structurally_invalid_events_are_rejected(case: str) -> None:
    """Prevent unusable provider identity data from reaching the service layer."""
    with pytest.raises(StripeWebhookVerificationError):
        _injected_verifier(_structurally_invalid_event(case)).verify(
            b"unchanged",
            "unchanged",
        )


def test_verified_out_of_scope_event_is_ignored_without_checkout_data() -> None:
    """Return core provider facts without requiring a Checkout Session object."""
    event = {
        "id": "evt_test_verified_contract",
        "object": "event",
        "created": EVENT_CREATED,
        "livemode": False,
        "type": "customer.created",
    }
    payload = json.dumps(event, separators=(",", ":"), sort_keys=True).encode()
    result = StripeWebhookVerifier(TEST_SECRET).verify(
        payload,
        _signature(payload, TEST_SECRET, int(time.time())),
    )

    assert result == IgnoredStripeEvent(
        stripe_event_id="evt_test_verified_contract",
        event_type="customer.created",
        livemode=False,
        stripe_created_at=datetime.fromtimestamp(EVENT_CREATED, tz=UTC),
    )


@pytest.mark.parametrize("livemode", [False, True])
def test_adapter_faithfully_returns_livemode(livemode: bool) -> None:
    """Preserve provider mode without enforcing deployment policy."""
    event = _event()
    event["livemode"] = livemode
    result = _injected_verifier(event).verify(b"unchanged", "unchanged")
    assert result.livemode is livemode


def test_expected_test_mode_accepts_a_verified_sandbox_event() -> None:
    """Return an authentic event only when it matches the sandbox policy."""
    result = _injected_verifier(
        _event(),
        expected_livemode=False,
    ).verify(b"unchanged", "unchanged")
    assert result.livemode is False


@pytest.mark.parametrize(
    "event_type",
    [StripeWebhookEventType.COMPLETED.value, "customer.created"],
)
def test_expected_test_mode_rejects_live_events_before_processing(
    event_type: str,
) -> None:
    """Reject both in-scope and ignored live events at the verification boundary."""
    event = _event(event_type=event_type)
    event["livemode"] = True
    with pytest.raises(StripeWebhookVerificationError) as caught:
        _injected_verifier(
            event,
            expected_livemode=False,
        ).verify(b"unchanged", "unchanged")
    assert str(caught.value) == "Stripe webhook verification failed"


def test_verified_event_dataclasses_are_immutable() -> None:
    """Prevent later layers from mutating verified provider facts."""
    checkout_event = _injected_verifier(_event()).verify(b"unchanged", "unchanged")
    ignored_event = _injected_verifier(
        {
            "id": "evt_test_ignored",
            "type": "customer.created",
            "created": EVENT_CREATED,
            "livemode": False,
        }
    ).verify(b"unchanged", "unchanged")
    with pytest.raises(FrozenInstanceError):
        checkout_event.livemode = True  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        ignored_event.livemode = True  # type: ignore[misc]
