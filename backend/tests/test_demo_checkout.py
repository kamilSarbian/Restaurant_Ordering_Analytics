"""Unit tests for the deterministic demo checkout contract."""

from __future__ import annotations

import hashlib
import inspect
import traceback
from contextlib import AbstractContextManager
from types import TracebackType
from typing import cast
from uuid import UUID, uuid4

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.payments import checkout
from app.payments.demo_checkout import (
    DEMO_OUTCOME_DOMAIN,
    build_demo_provider_idempotency_key,
    checkout_demo_order,
    demo_outcome_bucket,
    select_demo_outcome,
)
from app.payments.statuses import PaymentStatus

PUBLIC_ORDER_NUMBER = "ROA-23456789ABCD"
SYNTHETIC_SECRET_MARKER = "synthetic-db-password-marker"

GOLDEN_VECTORS = (
    (
        UUID("00000000-0000-4000-8000-00000000000b"),
        79,
        PaymentStatus.SUCCEEDED,
        "dd07c4dfcadedadb56a3511d6114dcf4c970acb845e0e5ded8b0a4f2c720571b",
    ),
    (
        UUID("00000000-0000-4000-8000-000000000095"),
        80,
        PaymentStatus.FAILED,
        "52da12921733e55037a549bab923880da2db055be04b1073938941fd20cd8e98",
    ),
    (
        UUID("00000000-0000-4000-8000-00000000001c"),
        89,
        PaymentStatus.FAILED,
        "34c40459c22f87895a70dc3e4921fb181e7af10f398575b597d4a50ff31675bd",
    ),
    (
        UUID("00000000-0000-4000-8000-000000000040"),
        90,
        PaymentStatus.EXPIRED,
        "1f1d1028a7cd6005e9c5e9218e2ba93766c71a8cc75f8031059fa9e7266c01f2",
    ),
)


class _FailingTransaction(AbstractContextManager[None]):
    def __init__(self, error: BaseException) -> None:
        self.error = error

    def __enter__(self) -> None:
        raise self.error

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        exc_traceback: TracebackType | None,
    ) -> bool | None:
        return None


class _FailingSession:
    def __init__(self, error: BaseException) -> None:
        self.error = error

    def begin(self) -> _FailingTransaction:
        return _FailingTransaction(self.error)


def test_demo_outcome_domain_is_exact_versioned_contract() -> None:
    """Keep the approved domain separators byte-exact."""
    nul = bytes((0,))
    assert DEMO_OUTCOME_DOMAIN == (
        b"restaurant-ordering-analytics"
        + nul
        + b"demo-checkout-outcome"
        + nul
        + b"v1"
        + nul
    )


@pytest.mark.parametrize(
    ("payment_id", "expected_bucket", "expected_status", "expected_digest"),
    GOLDEN_VECTORS,
)
def test_demo_outcome_matches_golden_vectors(
    payment_id: UUID,
    expected_bucket: int,
    expected_status: PaymentStatus,
    expected_digest: str,
) -> None:
    """Pin UUID network bytes, SHA-256, modulo buckets, and outcome thresholds."""
    digest = hashlib.sha256(DEMO_OUTCOME_DOMAIN + payment_id.bytes).hexdigest()

    assert digest == expected_digest
    assert demo_outcome_bucket(payment_id) == expected_bucket
    assert select_demo_outcome(payment_id) is expected_status


def test_demo_provider_key_is_versioned_and_bounded() -> None:
    """Bind the provider key to the backend Payment ID without request input."""
    payment_id = UUID("00000000-0000-4000-8000-00000000000b")

    key = build_demo_provider_idempotency_key(payment_id)

    assert key == "demo-runtime:v1:0000000000004000800000000000000b"
    assert len(key) == 48


def test_outcome_selector_accepts_only_backend_payment_id() -> None:
    """Keep request, Order, clock, and user values out of outcome selection."""
    assert tuple(inspect.signature(select_demo_outcome).parameters) == ("payment_id",)


def test_database_error_is_sanitized_without_exception_chain_or_marker() -> None:
    """Hide DB statements, parameters, and driver errors behind reconciliation."""
    original = IntegrityError(
        f"SELECT {SYNTHETIC_SECRET_MARKER}",
        {"password": SYNTHETIC_SECRET_MARKER},
        RuntimeError(SYNTHETIC_SECRET_MARKER),
    )

    with pytest.raises(checkout.PaymentSessionReconciliationRequiredError) as captured:
        checkout_demo_order(
            cast(Session, _FailingSession(original)),
            public_order_number=PUBLIC_ORDER_NUMBER,
            access_token="synthetic-capability",
            request_idempotency_key=uuid4(),
            payment_provider="demo",
        )

    error = captured.value
    assert error.__cause__ is None
    assert error.__context__ is None
    rendered = "".join(traceback.format_exception(error))
    assert SYNTHETIC_SECRET_MARKER not in rendered
    assert "SELECT" not in rendered


def test_programmer_error_is_not_masked_as_reconciliation() -> None:
    """Propagate non-SQLAlchemy programming errors unchanged."""
    original = RuntimeError("synthetic-programmer-error")

    with pytest.raises(RuntimeError, match="synthetic-programmer-error"):
        checkout_demo_order(
            cast(Session, _FailingSession(original)),
            public_order_number=PUBLIC_ORDER_NUMBER,
            access_token="synthetic-capability",
            request_idempotency_key=uuid4(),
            payment_provider="demo",
        )
