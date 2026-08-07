"""Unit tests for order fulfilment statuses and cancellation policy."""

import pytest

from app.orders.statuses import OrderStatus, can_cancel_order


def test_order_status_contains_exactly_the_approved_values() -> None:
    """Keep fulfilment status independent from payment status."""
    assert [status.value for status in OrderStatus] == [
        "created",
        "accepted",
        "preparing",
        "ready",
        "completed",
        "cancelled",
    ]


@pytest.mark.parametrize("has_blocking_payment", [False, True])
def test_created_cancellation_depends_on_blocking_payment(
    has_blocking_payment: bool,
) -> None:
    """Allow created cancellation only without a future blocking payment."""
    assert can_cancel_order(
        OrderStatus.CREATED,
        has_blocking_payment=has_blocking_payment,
    ) is (not has_blocking_payment)


@pytest.mark.parametrize(
    "status",
    [
        OrderStatus.ACCEPTED,
        OrderStatus.PREPARING,
        OrderStatus.READY,
        OrderStatus.COMPLETED,
        OrderStatus.CANCELLED,
    ],
)
def test_non_created_orders_cannot_be_cancelled(status: OrderStatus) -> None:
    """Reject cancellation from every non-created fulfilment status."""
    assert can_cancel_order(status, has_blocking_payment=False) is False
    assert can_cancel_order(status, has_blocking_payment=True) is False
