"""Integration tests for D-016 using persisted Payment attempts."""

from __future__ import annotations

import secrets
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.orders.models import Order
from app.orders.statuses import OrderStatus, can_cancel_order
from app.payments.models import Payment
from app.payments.policies import has_blocking_payment_status
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
        stripe_idempotency_key=f"checkout-session:{uuid.uuid4()}",
    )


def _can_cancel_persisted_order(session: Session, order: Order) -> bool:
    statuses = session.scalars(
        select(Payment.status).where(Payment.order_id == order.id)
    ).all()
    return can_cancel_order(
        OrderStatus(order.status),
        has_blocking_payment=has_blocking_payment_status(statuses),
    )


@pytest.mark.parametrize(
    ("payment_status", "expected"),
    [
        (None, True),
        (PaymentStatus.FAILED, True),
        (PaymentStatus.EXPIRED, True),
        (PaymentStatus.PENDING, False),
        (PaymentStatus.SUCCEEDED, False),
    ],
)
def test_created_order_cancellation_uses_persisted_payment_statuses(
    db_session: Session,
    payment_status: PaymentStatus | None,
    expected: bool,
) -> None:
    """Apply the D-016 blocking rule to real Payment rows."""
    order = _order()
    db_session.add(order)
    if payment_status is not None:
        db_session.add(_payment(order, payment_status))
    db_session.flush()
    assert _can_cancel_persisted_order(db_session, order) is expected


@pytest.mark.parametrize("payment_status", [None, *list(PaymentStatus)])
def test_accepted_order_is_never_cancellable(
    db_session: Session,
    payment_status: PaymentStatus | None,
) -> None:
    """Keep fulfilment status authoritative regardless of payment attempts."""
    order = _order(status=OrderStatus.ACCEPTED)
    db_session.add(order)
    if payment_status is not None:
        db_session.add(_payment(order, payment_status))
    db_session.flush()
    assert _can_cancel_persisted_order(db_session, order) is False
