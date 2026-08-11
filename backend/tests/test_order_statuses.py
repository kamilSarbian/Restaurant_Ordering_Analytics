"""Unit tests for order fulfilment statuses and cancellation policy."""

import pytest

from app.orders.statuses import (
    ALLOWED_ORDER_STATUS_TRANSITIONS,
    OrderStatus,
    can_cancel_order,
    can_transition_order_status,
)


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


def test_transition_graph_contains_exactly_the_five_approved_edges() -> None:
    """Freeze the complete operational fulfilment state machine."""
    assert ALLOWED_ORDER_STATUS_TRANSITIONS == {
        (OrderStatus.CREATED, OrderStatus.ACCEPTED),
        (OrderStatus.CREATED, OrderStatus.CANCELLED),
        (OrderStatus.ACCEPTED, OrderStatus.PREPARING),
        (OrderStatus.PREPARING, OrderStatus.READY),
        (OrderStatus.READY, OrderStatus.COMPLETED),
    }


@pytest.mark.parametrize("current_status", list(OrderStatus))
@pytest.mark.parametrize("target_status", list(OrderStatus))
def test_transition_helper_accepts_only_approved_edges(
    current_status: OrderStatus,
    target_status: OrderStatus,
) -> None:
    """Reject repeats, skips, reversals, and terminal-state exits."""
    expected = (current_status, target_status) in ALLOWED_ORDER_STATUS_TRANSITIONS
    assert can_transition_order_status(current_status, target_status) is expected
    assert (
        can_transition_order_status(
            current_status.value,
            target_status.value,
        )
        is expected
    )


@pytest.mark.parametrize(
    ("current_status", "target_status"),
    [("unknown", "created"), ("created", "unknown"), ("unknown", "unknown")],
)
def test_transition_helper_rejects_unknown_raw_values(
    current_status: str,
    target_status: str,
) -> None:
    """Treat arbitrary persisted or caller values as invalid graph edges."""
    assert can_transition_order_status(current_status, target_status) is False
