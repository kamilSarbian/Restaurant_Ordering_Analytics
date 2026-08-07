"""Unit tests for payment-attempt statuses and cancellation policy input."""

import pytest

from app.payments.policies import has_blocking_payment_status
from app.payments.statuses import PaymentStatus


def test_payment_status_has_exactly_the_approved_values() -> None:
    """Keep the payment-attempt lifecycle limited to four approved values."""
    assert [status.value for status in PaymentStatus] == [
        "pending",
        "succeeded",
        "failed",
        "expired",
    ]


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        ([], False),
        ([PaymentStatus.FAILED], False),
        ([PaymentStatus.EXPIRED], False),
        ([PaymentStatus.FAILED, PaymentStatus.EXPIRED], False),
        ([PaymentStatus.PENDING], True),
        ([PaymentStatus.SUCCEEDED], True),
        ([PaymentStatus.PENDING, PaymentStatus.FAILED], True),
        ([PaymentStatus.SUCCEEDED, PaymentStatus.EXPIRED], True),
    ],
)
def test_blocking_payment_status_policy(
    statuses: list[PaymentStatus],
    expected: bool,
) -> None:
    """Classify pending and succeeded attempts as cancellation blocking."""
    assert has_blocking_payment_status(statuses) is expected
