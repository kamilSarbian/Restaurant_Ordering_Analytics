"""Order fulfilment statuses and pure transition policies."""

from enum import StrEnum


class OrderStatus(StrEnum):
    """Enumerate the approved order fulfilment lifecycle values."""

    CREATED = "created"
    ACCEPTED = "accepted"
    PREPARING = "preparing"
    READY = "ready"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


ALLOWED_ORDER_STATUS_TRANSITIONS = frozenset(
    {
        (OrderStatus.CREATED, OrderStatus.ACCEPTED),
        (OrderStatus.CREATED, OrderStatus.CANCELLED),
        (OrderStatus.ACCEPTED, OrderStatus.PREPARING),
        (OrderStatus.PREPARING, OrderStatus.READY),
        (OrderStatus.READY, OrderStatus.COMPLETED),
    }
)


def can_transition_order_status(
    current_status: str | OrderStatus,
    target_status: str | OrderStatus,
) -> bool:
    """Return whether the approved fulfilment graph allows a transition.

    Args:
        current_status: Current persisted fulfilment status.
        target_status: Requested next fulfilment status.

    Returns:
        True only for one of the five approved directed graph edges. Unknown
        raw values are rejected without raising an exception.
    """
    try:
        current = OrderStatus(current_status)
        target = OrderStatus(target_status)
    except ValueError:
        return False
    return (current, target) in ALLOWED_ORDER_STATUS_TRANSITIONS


def can_cancel_order(
    status: OrderStatus,
    *,
    has_blocking_payment: bool,
) -> bool:
    """Return whether the approved cancellation policy permits cancellation.

    Args:
        status: Current order fulfilment status.
        has_blocking_payment: Whether a future pending or succeeded payment exists.

    Returns:
        True only for an unpaid order that remains in the created state.
    """
    return status is OrderStatus.CREATED and not has_blocking_payment
