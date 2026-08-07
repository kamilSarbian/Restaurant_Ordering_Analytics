"""Payment-attempt lifecycle statuses."""

from enum import StrEnum


class PaymentStatus(StrEnum):
    """Enumerate the approved payment-attempt lifecycle values."""

    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    EXPIRED = "expired"
