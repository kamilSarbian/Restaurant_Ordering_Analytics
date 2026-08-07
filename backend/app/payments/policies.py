"""Pure policies derived from persisted payment-attempt state."""

from collections.abc import Iterable

from app.payments.statuses import PaymentStatus

BLOCKING_PAYMENT_STATUSES = {
    PaymentStatus.PENDING.value,
    PaymentStatus.SUCCEEDED.value,
}


def has_blocking_payment_status(
    statuses: Iterable[PaymentStatus | str],
) -> bool:
    """Return whether any payment attempt blocks order cancellation.

    Args:
        statuses: Persisted payment-attempt statuses for one order.

    Returns:
        True when at least one attempt is pending or succeeded.
    """
    return any(status in BLOCKING_PAYMENT_STATUSES for status in statuses)
