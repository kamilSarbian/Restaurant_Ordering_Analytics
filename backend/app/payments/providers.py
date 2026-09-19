"""Payment-provider domain values."""

from enum import StrEnum


class PaymentProvider(StrEnum):
    """Identify the backend provider responsible for a payment attempt."""

    STRIPE_TEST = "stripe_test"
    DEMO = "demo"
