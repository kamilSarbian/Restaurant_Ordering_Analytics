"""Integration tests for the persistent Payment model."""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import BigInteger, DateTime, String, Text, inspect, select
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.engine import Engine
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from app.orders.models import Order
from app.payments.models import Payment
from app.payments.providers import PaymentProvider
from app.payments.statuses import PaymentStatus

pytestmark = pytest.mark.integration

PUBLIC_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def _public_order_number() -> str:
    return "ROA-" + "".join(secrets.choice(PUBLIC_ALPHABET) for _ in range(12))


def _order(**values: object) -> Order:
    defaults: dict[str, object] = {
        "public_order_number": _public_order_number(),
        "order_access_token_hash": uuid.uuid4().hex + uuid.uuid4().hex,
        "order_type": "takeaway",
        "table_id": None,
        "table_number_snapshot": None,
        "currency": "NOK",
        "subtotal_amount": 100,
        "total_amount": 100,
    }
    defaults.update(values)
    return Order(**defaults)


def _provider_key() -> str:
    return f"checkout-session:{uuid.uuid4()}"


def _payment(order: Order, **values: object) -> Payment:
    status = values.get("status", PaymentStatus.PENDING.value)
    defaults: dict[str, object] = {
        "order": order,
        "amount": 100,
        "currency": "NOK",
        "request_idempotency_key": uuid.uuid4(),
        "provider": PaymentProvider.STRIPE_TEST.value,
        "provider_idempotency_key": _provider_key(),
        "succeeded_at": (
            datetime.now(UTC) if status == PaymentStatus.SUCCEEDED.value else None
        ),
    }
    defaults.update(values)
    return Payment(**defaults)


def _assert_database_error(session: Session, payment: Payment) -> None:
    session.add(payment)
    with pytest.raises((IntegrityError, DataError)):
        session.flush()
    session.rollback()
    assert session.execute(select(1)).scalar_one() == 1


def test_payment_schema_has_exact_columns_and_types(
    test_database_engine: Engine,
) -> None:
    """Match the approved Payment field shape in PostgreSQL."""
    inspector = inspect(test_database_engine)
    columns = {
        column["name"]: column
        for column in inspector.get_columns("payments", schema="public")
    }
    assert set(columns) == {
        "id",
        "order_id",
        "status",
        "amount",
        "currency",
        "request_idempotency_key",
        "provider",
        "provider_idempotency_key",
        "provider_session_id",
        "provider_checkout_url",
        "provider_checkout_expires_at",
        "succeeded_at",
        "created_at",
        "updated_at",
    }
    assert isinstance(columns["id"]["type"], PostgreSQLUUID)
    assert isinstance(columns["order_id"]["type"], PostgreSQLUUID)
    assert isinstance(columns["request_idempotency_key"]["type"], PostgreSQLUUID)
    assert isinstance(columns["status"]["type"], String)
    assert columns["status"]["type"].length == 16
    assert isinstance(columns["amount"]["type"], BigInteger)
    assert isinstance(columns["currency"]["type"], String)
    assert columns["currency"]["type"].length == 3
    assert columns["provider"]["type"].length == 11
    assert columns["provider_idempotency_key"]["type"].length == 64
    assert columns["provider_session_id"]["type"].length == 255
    assert isinstance(columns["provider_checkout_url"]["type"], Text)
    for column_name in (
        "provider_checkout_expires_at",
        "succeeded_at",
        "created_at",
        "updated_at",
    ):
        assert isinstance(columns[column_name]["type"], DateTime)
        assert columns[column_name]["type"].timezone is True
    assert all(
        columns[column_name]["nullable"] is False
        for column_name in (
            "id",
            "order_id",
            "status",
            "amount",
            "currency",
            "request_idempotency_key",
            "provider",
            "provider_idempotency_key",
            "created_at",
            "updated_at",
        )
    )
    assert all(
        columns[column_name]["nullable"] is True
        for column_name in (
            "provider_session_id",
            "provider_checkout_url",
            "provider_checkout_expires_at",
            "succeeded_at",
        )
    )
    assert columns["provider"]["default"] is None


def test_payment_defaults_uuid_pending_timestamps_and_bigint(
    db_session: Session,
) -> None:
    """Persist Python and server defaults plus an amount above 32-bit range."""
    amount = 2_147_483_648
    payment = _payment(_order(total_amount=amount), amount=amount)
    db_session.add(payment)
    db_session.flush()
    assert isinstance(payment.id, uuid.UUID)
    assert payment.status == PaymentStatus.PENDING.value
    assert payment.provider == PaymentProvider.STRIPE_TEST.value
    assert payment.amount == amount
    assert payment.created_at.tzinfo is not None
    assert payment.updated_at.tzinfo is not None


@pytest.mark.parametrize("status", list(PaymentStatus))
def test_payment_accepts_every_approved_status(
    db_session: Session,
    status: PaymentStatus,
) -> None:
    """Persist every approved payment-attempt state."""
    payment = _payment(_order(), status=status.value)
    db_session.add(payment)
    db_session.flush()
    assert payment.status == status.value


def test_payment_rejects_unknown_status(db_session: Session) -> None:
    """Reject values outside the payment-attempt lifecycle."""
    _assert_database_error(db_session, _payment(_order(), status="refunded"))


@pytest.mark.parametrize("provider", list(PaymentProvider))
def test_payment_accepts_every_approved_provider(
    db_session: Session,
    provider: PaymentProvider,
) -> None:
    """Persist every approved payment provider."""
    payment = _payment(
        _order(),
        provider=provider.value,
        status=PaymentStatus.FAILED.value,
    )
    db_session.add(payment)
    db_session.flush()
    assert payment.provider == provider.value


def test_payment_rejects_unknown_provider(db_session: Session) -> None:
    """Reject payment-provider identities outside the approved contract."""
    _assert_database_error(
        db_session,
        _payment(
            _order(),
            provider="stripe_live",
            status=PaymentStatus.FAILED.value,
        ),
    )


def test_payment_requires_explicit_provider(db_session: Session) -> None:
    """Reject new payment rows without an explicitly selected provider."""
    _assert_database_error(
        db_session,
        _payment(_order(), provider=None, status=PaymentStatus.FAILED.value),
    )


@pytest.mark.parametrize("provider_key", ["", " ", "\t", "\n"])
def test_payment_rejects_blank_provider_idempotency_key(
    db_session: Session,
    provider_key: str,
) -> None:
    """Require a non-blank provider idempotency key."""
    _assert_database_error(
        db_session,
        _payment(
            _order(),
            provider_idempotency_key=provider_key,
            status=PaymentStatus.FAILED.value,
        ),
    )


def test_succeeded_payment_requires_succeeded_at(db_session: Session) -> None:
    """Reject a succeeded payment without its authoritative success time."""
    _assert_database_error(
        db_session,
        _payment(
            _order(),
            status=PaymentStatus.SUCCEEDED.value,
            succeeded_at=None,
        ),
    )


@pytest.mark.parametrize(
    "status",
    [PaymentStatus.PENDING, PaymentStatus.FAILED, PaymentStatus.EXPIRED],
)
def test_non_succeeded_payment_rejects_succeeded_at(
    db_session: Session,
    status: PaymentStatus,
) -> None:
    """Reject an authoritative success time on a non-succeeded payment."""
    _assert_database_error(
        db_session,
        _payment(
            _order(),
            status=status.value,
            succeeded_at=datetime.now(UTC),
        ),
    )


def test_succeeded_at_round_trips_timezone_aware(db_session: Session) -> None:
    """Persist the exact timezone-aware authoritative success time."""
    succeeded_at = datetime(2026, 9, 18, 12, 30, tzinfo=UTC)
    payment = _payment(
        _order(),
        status=PaymentStatus.SUCCEEDED.value,
        succeeded_at=succeeded_at,
    )
    db_session.add(payment)
    db_session.flush()
    assert payment.succeeded_at == succeeded_at
    assert payment.succeeded_at.tzinfo is not None


@pytest.mark.parametrize("amount", [0, -1])
def test_payment_rejects_nonpositive_amount(
    db_session: Session,
    amount: int,
) -> None:
    """Require a positive amount in integer minor units."""
    _assert_database_error(db_session, _payment(_order(), amount=amount))


@pytest.mark.parametrize("currency", ["nok", "NO", "NOKK", "N1K"])
def test_payment_rejects_invalid_currency(
    db_session: Session,
    currency: str,
) -> None:
    """Require exactly three uppercase ASCII currency letters."""
    _assert_database_error(db_session, _payment(_order(), currency=currency))


def test_request_idempotency_key_round_trips_as_uuid(db_session: Session) -> None:
    """Store request idempotency as PostgreSQL UUID rather than text."""
    request_key = uuid.uuid4()
    payment = _payment(
        _order(),
        request_idempotency_key=request_key,
        status=PaymentStatus.FAILED.value,
    )
    db_session.add(payment)
    db_session.flush()
    assert payment.request_idempotency_key == request_key
    assert isinstance(payment.request_idempotency_key, uuid.UUID)


def test_checkout_session_accepts_all_null_fields(db_session: Session) -> None:
    """Allow an attempt before a Checkout Session has been stored."""
    payment = _payment(_order(), status=PaymentStatus.FAILED.value)
    db_session.add(payment)
    db_session.flush()
    assert payment.provider_session_id is None
    assert payment.provider_checkout_url is None
    assert payment.provider_checkout_expires_at is None


def test_checkout_session_accepts_all_populated_fields(db_session: Session) -> None:
    """Allow a complete hosted Checkout Session snapshot."""
    expires_at = datetime.now(UTC) + timedelta(hours=1)
    payment = _payment(
        _order(),
        status=PaymentStatus.FAILED.value,
        provider_session_id=f"cs_test_{uuid.uuid4().hex}",
        provider_checkout_url="https://checkout.stripe.example/session",
        provider_checkout_expires_at=expires_at,
    )
    db_session.add(payment)
    db_session.flush()
    assert payment.provider_checkout_expires_at == expires_at


@pytest.mark.parametrize(
    "session_fields",
    [
        {"provider_session_id": "cs_test_incomplete"},
        {"provider_checkout_url": "https://checkout.stripe.example/session"},
        {"provider_checkout_expires_at": datetime.now(UTC)},
        {
            "provider_session_id": "cs_test_incomplete",
            "provider_checkout_url": "https://checkout.stripe.example/session",
        },
        {
            "provider_session_id": "cs_test_incomplete",
            "provider_checkout_expires_at": datetime.now(UTC),
        },
        {
            "provider_checkout_url": "https://checkout.stripe.example/session",
            "provider_checkout_expires_at": datetime.now(UTC),
        },
    ],
)
def test_checkout_session_rejects_partial_fields(
    db_session: Session,
    session_fields: dict[str, object],
) -> None:
    """Reject every partially populated Checkout Session combination."""
    _assert_database_error(
        db_session,
        _payment(_order(), status=PaymentStatus.FAILED.value, **session_fields),
    )


def test_same_order_and_request_key_is_unique(db_session: Session) -> None:
    """Reject concurrent-equivalent retries for one order at the database."""
    order = _order()
    request_key = uuid.uuid4()
    db_session.add(
        _payment(
            order,
            status=PaymentStatus.FAILED.value,
            request_idempotency_key=request_key,
        )
    )
    db_session.commit()
    _assert_database_error(
        db_session,
        _payment(
            order,
            status=PaymentStatus.EXPIRED.value,
            request_idempotency_key=request_key,
        ),
    )


def test_same_request_key_is_allowed_for_different_orders(
    db_session: Session,
) -> None:
    """Scope request idempotency uniqueness to one order."""
    request_key = uuid.uuid4()
    payments = [
        _payment(
            _order(),
            status=PaymentStatus.FAILED.value,
            request_idempotency_key=request_key,
        )
        for _ in range(2)
    ]
    db_session.add_all(payments)
    db_session.flush()
    assert {payment.request_idempotency_key for payment in payments} == {request_key}


def test_provider_idempotency_key_is_unique_within_provider(
    db_session: Session,
) -> None:
    """Reject reuse of one idempotency key within a provider."""
    provider_key = _provider_key()
    db_session.add(
        _payment(
            _order(),
            status=PaymentStatus.FAILED.value,
            provider_idempotency_key=provider_key,
        )
    )
    db_session.commit()
    _assert_database_error(
        db_session,
        _payment(
            _order(),
            status=PaymentStatus.FAILED.value,
            provider_idempotency_key=provider_key,
        ),
    )


def test_provider_idempotency_key_may_repeat_across_providers(
    db_session: Session,
) -> None:
    """Scope provider idempotency uniqueness to the provider identity."""
    provider_key = _provider_key()
    payments = [
        _payment(
            _order(),
            provider=provider.value,
            provider_idempotency_key=provider_key,
            status=PaymentStatus.FAILED.value,
        )
        for provider in PaymentProvider
    ]
    db_session.add_all(payments)
    db_session.flush()
    assert {payment.provider for payment in payments} == {
        PaymentProvider.STRIPE_TEST.value,
        PaymentProvider.DEMO.value,
    }


def test_non_null_session_id_is_unique_within_provider(
    db_session: Session,
) -> None:
    """Reject reuse of one non-null session ID within a provider."""
    session_id = f"cs_test_{uuid.uuid4().hex}"
    fields = {
        "status": PaymentStatus.FAILED.value,
        "provider_session_id": session_id,
        "provider_checkout_url": "https://checkout.stripe.example/session",
        "provider_checkout_expires_at": datetime.now(UTC) + timedelta(hours=1),
    }
    db_session.add(_payment(_order(), **fields))
    db_session.commit()
    _assert_database_error(db_session, _payment(_order(), **fields))


def test_non_null_session_id_may_repeat_across_providers(
    db_session: Session,
) -> None:
    """Scope non-null session identity uniqueness to the provider."""
    session_id = f"session_{uuid.uuid4().hex}"
    expires_at = datetime.now(UTC) + timedelta(hours=1)
    payments = [
        _payment(
            _order(),
            provider=provider.value,
            status=PaymentStatus.FAILED.value,
            provider_session_id=session_id,
            provider_checkout_url="https://provider.example/session",
            provider_checkout_expires_at=expires_at,
        )
        for provider in PaymentProvider
    ]
    db_session.add_all(payments)
    db_session.flush()
    assert {payment.provider_session_id for payment in payments} == {session_id}


def test_multiple_null_session_ids_are_allowed(db_session: Session) -> None:
    """Permit multiple attempts that do not yet have a provider session."""
    order = _order()
    payments = [
        _payment(order, status=PaymentStatus.FAILED.value),
        _payment(order, status=PaymentStatus.EXPIRED.value),
    ]
    db_session.add_all(payments)
    db_session.flush()
    assert all(payment.provider_session_id is None for payment in payments)


@pytest.mark.parametrize(
    "status",
    [PaymentStatus.PENDING, PaymentStatus.SUCCEEDED],
)
def test_partial_unique_indexes_reject_second_active_status(
    db_session: Session,
    status: PaymentStatus,
) -> None:
    """Allow at most one pending and one succeeded attempt per order."""
    order = _order()
    db_session.add(_payment(order, status=status.value))
    db_session.commit()
    _assert_database_error(db_session, _payment(order, status=status.value))


def test_failed_and_expired_attempts_may_coexist(db_session: Session) -> None:
    """Leave terminal unsuccessful attempt history unrestricted by indexes."""
    order = _order()
    payments = [
        _payment(order, status=PaymentStatus.FAILED.value),
        _payment(order, status=PaymentStatus.FAILED.value),
        _payment(order, status=PaymentStatus.EXPIRED.value),
        _payment(order, status=PaymentStatus.EXPIRED.value),
    ]
    db_session.add_all(payments)
    db_session.flush()
    assert len(payments) == 4


def test_pending_and_succeeded_can_coexist_at_index_level(
    db_session: Session,
) -> None:
    """Document that partial indexes do not replace Order-first locking."""
    order = _order()
    payments = [
        _payment(order, status=PaymentStatus.PENDING.value),
        _payment(order, status=PaymentStatus.SUCCEEDED.value),
    ]
    db_session.add_all(payments)
    db_session.flush()
    assert {payment.status for payment in payments} == {"pending", "succeeded"}


def test_order_payments_are_deterministic_and_have_no_delete_cascade(
    db_session: Session,
) -> None:
    """Order attempts by creation time and UUID without ownership deletion."""
    order = _order()
    earlier = datetime(2026, 1, 1, tzinfo=UTC)
    later = datetime(2026, 1, 2, tzinfo=UTC)
    first_id = uuid.UUID("00000000-0000-0000-0000-000000000001")
    second_id = uuid.UUID("00000000-0000-0000-0000-000000000002")
    payments = [
        _payment(
            order,
            id=second_id,
            status=PaymentStatus.EXPIRED.value,
            created_at=later,
        ),
        _payment(
            order,
            id=first_id,
            status=PaymentStatus.FAILED.value,
            created_at=earlier,
        ),
    ]
    db_session.add_all(payments)
    db_session.commit()
    order_id = order.id
    db_session.expunge_all()

    stored = db_session.get(Order, order_id)
    assert stored is not None
    assert [payment.id for payment in stored.payments] == [first_id, second_id]
    assert Payment.order.property.back_populates == "payments"
    assert Order.payments.property.passive_deletes == "all"
    assert "delete" not in Order.payments.property.cascade
    assert "delete-orphan" not in Order.payments.property.cascade


def test_payment_blocks_physical_order_deletion(db_session: Session) -> None:
    """Retain an Order referenced by historical payment attempts."""
    order = _order()
    payment = _payment(order, status=PaymentStatus.FAILED.value)
    db_session.add(payment)
    db_session.commit()
    order_id = order.id
    payment_id = payment.id
    db_session.expunge_all()

    stored_order = db_session.get(Order, order_id)
    assert stored_order is not None
    db_session.delete(stored_order)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()
    assert db_session.get(Order, order_id) is not None
    assert db_session.get(Payment, payment_id) is not None
