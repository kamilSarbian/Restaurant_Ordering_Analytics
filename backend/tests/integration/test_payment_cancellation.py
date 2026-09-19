"""Integration tests for D-016 using persisted Payment attempts."""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session

from app.orders.admin_service import (
    AdminOrderActivePaymentError,
    AdminOrderCannotCancelError,
    AdminOrderInvalidTransitionError,
    transition_order_status,
)
from app.orders.models import Order, OrderStatusHistory
from app.orders.statuses import OrderStatus
from app.payments.models import Payment
from app.payments.statuses import PaymentStatus

pytestmark = pytest.mark.integration

PUBLIC_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def _order(*, status: OrderStatus = OrderStatus.CREATED) -> Order:
    return Order(
        public_order_number="ROA-"
        + "".join(secrets.choice(PUBLIC_ALPHABET) for _ in range(12)),
        order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
        order_type="takeaway",
        table_id=None,
        table_number_snapshot=None,
        status=status.value,
        currency="NOK",
        subtotal_amount=100,
        total_amount=100,
    )


def _payment(order: Order, status: PaymentStatus) -> Payment:
    return Payment(
        order=order,
        status=status.value,
        amount=order.total_amount,
        currency=order.currency,
        request_idempotency_key=uuid.uuid4(),
        provider="stripe_test",
        provider_idempotency_key=f"checkout-session:{uuid.uuid4()}",
        succeeded_at=(datetime.now(UTC) if status is PaymentStatus.SUCCEEDED else None),
    )


def _store_initial_history(session: Session, order: Order) -> None:
    session.add(
        OrderStatusHistory(
            order=order,
            sequence=0,
            previous_status=None,
            new_status=OrderStatus.CREATED.value,
        )
    )


def _cancel_persisted_order(session: Session, order: Order) -> None:
    transition_order_status(
        session,
        public_order_number=order.public_order_number,
        target_status=OrderStatus.CANCELLED,
    )


@pytest.mark.parametrize(
    ("payment_status", "expected_error"),
    [
        (None, None),
        (PaymentStatus.FAILED, None),
        (PaymentStatus.EXPIRED, None),
        (PaymentStatus.PENDING, AdminOrderActivePaymentError),
        (PaymentStatus.SUCCEEDED, AdminOrderCannotCancelError),
    ],
)
def test_created_order_cancellation_uses_persisted_payment_statuses(
    db_session: Session,
    payment_status: PaymentStatus | None,
    expected_error: type[Exception] | None,
) -> None:
    """Apply real Stage 12 cancellation to persisted Payment rows."""
    order = _order()
    db_session.add(order)
    _store_initial_history(db_session, order)
    if payment_status is not None:
        db_session.add(_payment(order, payment_status))
    db_session.commit()

    if expected_error is None:
        _cancel_persisted_order(db_session, order)
        db_session.expire(order, ["status_history"])
        assert order.status == OrderStatus.CANCELLED.value
        assert [entry.sequence for entry in order.status_history] == [0, 1]
    else:
        with pytest.raises(expected_error):
            _cancel_persisted_order(db_session, order)
        assert order.status == OrderStatus.CREATED.value
        assert [entry.sequence for entry in order.status_history] == [0]


@pytest.mark.parametrize("payment_status", [None, *list(PaymentStatus)])
def test_accepted_order_is_never_cancellable(
    db_session: Session,
    payment_status: PaymentStatus | None,
) -> None:
    """Keep fulfilment status authoritative regardless of payment attempts."""
    order = _order(status=OrderStatus.ACCEPTED)
    db_session.add(order)
    _store_initial_history(db_session, order)
    db_session.add(
        OrderStatusHistory(
            order=order,
            sequence=1,
            previous_status=OrderStatus.CREATED.value,
            new_status=OrderStatus.ACCEPTED.value,
        )
    )
    if payment_status is not None:
        db_session.add(_payment(order, payment_status))
    db_session.commit()

    with pytest.raises(AdminOrderInvalidTransitionError):
        _cancel_persisted_order(db_session, order)
    assert order.status == OrderStatus.ACCEPTED.value
    assert [entry.sequence for entry in order.status_history] == [0, 1]


def test_succeeded_precedes_pending_when_both_attempts_exist(
    db_session: Session,
) -> None:
    """Return the stronger terminal cancellation conflict deterministically."""
    order = _order()
    db_session.add(order)
    _store_initial_history(db_session, order)
    db_session.add_all(
        [
            _payment(order, PaymentStatus.PENDING),
            _payment(order, PaymentStatus.SUCCEEDED),
        ]
    )
    db_session.commit()

    with pytest.raises(AdminOrderCannotCancelError):
        _cancel_persisted_order(db_session, order)
    assert order.status == OrderStatus.CREATED.value
    assert [entry.sequence for entry in order.status_history] == [0]
