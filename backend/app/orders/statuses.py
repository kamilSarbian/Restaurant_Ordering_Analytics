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
