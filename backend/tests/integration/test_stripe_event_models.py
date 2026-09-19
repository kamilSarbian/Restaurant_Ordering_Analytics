"""Integration tests for durable Stripe event receipts."""

from __future__ import annotations

import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Barrier

import pytest
from sqlalchemy import Boolean, DateTime, String, inspect, select, text
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.engine import Engine
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from app.orders.models import Order
from app.payments.models import Payment, StripeEvent
from app.payments.statuses import PaymentStatus

pytestmark = pytest.mark.integration

PUBLIC_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
EVENT_TYPES = (
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
)
PROCESSING_RESULTS = (
    "transitioned",
    "awaiting_async_payment",
    "already_applied",
    "reconciliation_required",
)
EXPECTED_CHECKS = {
    "ck_stripe_events_checkout_session_id_not_blank",
    "ck_stripe_events_event_type_allowed",
    "ck_stripe_events_processing_result_allowed",
    "ck_stripe_events_stripe_event_id_not_blank",
}
EXPECTED_INDEXES = {
    "ix_stripe_events_payment_created_at_id": [
        "payment_id",
        "stripe_created_at",
        "id",
    ],
    "ix_stripe_events_session_created_at_id": [
        "stripe_checkout_session_id",
        "stripe_created_at",
        "id",
    ],
}


def _public_order_number() -> str:
    return "ROA-" + "".join(secrets.choice(PUBLIC_ALPHABET) for _ in range(12))


def _order() -> Order:
    return Order(
        public_order_number=_public_order_number(),
        order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
        order_type="takeaway",
        table_id=None,
        table_number_snapshot=None,
        currency="NOK",
        subtotal_amount=100,
        total_amount=100,
    )


def _payment(order: Order) -> Payment:
    payment_id = uuid.uuid4()
    return Payment(
        id=payment_id,
        order=order,
        status=PaymentStatus.FAILED.value,
        amount=100,
        currency="NOK",
        request_idempotency_key=uuid.uuid4(),
        provider="stripe_test",
        provider_idempotency_key=f"checkout-session:{payment_id}",
    )


def _event(**values: object) -> StripeEvent:
    defaults: dict[str, object] = {
        "stripe_event_id": f"evt_test_{uuid.uuid4().hex}",
        "event_type": "checkout.session.completed",
        "livemode": False,
        "stripe_created_at": datetime(2026, 8, 8, tzinfo=UTC),
        "stripe_checkout_session_id": f"cs_test_{uuid.uuid4().hex}",
        "payment_id": None,
        "processing_result": "transitioned",
    }
    defaults.update(values)
    return StripeEvent(**defaults)


def _assert_database_error(session: Session, event: StripeEvent) -> None:
    session.add(event)
    with pytest.raises((IntegrityError, DataError)):
        session.flush()
    session.rollback()
    assert session.execute(select(1)).scalar_one() == 1


def test_stripe_event_schema_has_exact_columns_and_types(
    test_database_engine: Engine,
) -> None:
    """Match the approved StripeEvent field shape in PostgreSQL."""
    columns = {
        column["name"]: column
        for column in inspect(test_database_engine).get_columns(
            "stripe_events", schema="public"
        )
    }
    assert list(columns) == [
        "id",
        "stripe_event_id",
        "event_type",
        "livemode",
        "stripe_created_at",
        "stripe_checkout_session_id",
        "payment_id",
        "processing_result",
        "created_at",
    ]
    assert isinstance(columns["id"]["type"], PostgreSQLUUID)
    assert isinstance(columns["payment_id"]["type"], PostgreSQLUUID)
    assert isinstance(columns["stripe_event_id"]["type"], String)
    assert columns["stripe_event_id"]["type"].length == 255
    assert isinstance(columns["event_type"]["type"], String)
    assert columns["event_type"]["type"].length == 64
    assert isinstance(columns["stripe_checkout_session_id"]["type"], String)
    assert columns["stripe_checkout_session_id"]["type"].length == 255
    assert isinstance(columns["processing_result"]["type"], String)
    assert columns["processing_result"]["type"].length == 32
    assert isinstance(columns["livemode"]["type"], Boolean)
    for column_name in ("stripe_created_at", "created_at"):
        assert isinstance(columns[column_name]["type"], DateTime)
        assert columns[column_name]["type"].timezone is True
    assert columns["payment_id"]["nullable"] is True
    assert all(
        columns[column_name]["nullable"] is False
        for column_name in set(columns) - {"payment_id"}
    )
    assert columns["id"]["default"] is None
    assert columns["stripe_created_at"]["default"] is None
    assert columns["created_at"]["default"] is not None


def test_stripe_event_defaults_uuid_and_created_at(db_session: Session) -> None:
    """Persist the Python UUID and PostgreSQL receipt timestamp defaults."""
    event = _event()
    db_session.add(event)
    db_session.flush()
    assert isinstance(event.id, uuid.UUID)
    assert event.created_at.tzinfo is not None
    assert event.stripe_created_at == datetime(2026, 8, 8, tzinfo=UTC)


@pytest.mark.parametrize("event_type", EVENT_TYPES)
def test_stripe_event_accepts_each_approved_event_type(
    db_session: Session,
    event_type: str,
) -> None:
    """Persist every provider event type approved for Stage 10."""
    event = _event(event_type=event_type)
    db_session.add(event)
    db_session.flush()
    assert event.event_type == event_type


def test_stripe_event_rejects_unapproved_event_type(db_session: Session) -> None:
    """Reject a signed event type outside the persisted allowlist."""
    _assert_database_error(
        db_session,
        _event(event_type="payment_intent.succeeded"),
    )


@pytest.mark.parametrize("processing_result", PROCESSING_RESULTS)
def test_stripe_event_accepts_each_processing_result(
    db_session: Session,
    processing_result: str,
) -> None:
    """Persist every approved webhook processing result."""
    event = _event(processing_result=processing_result)
    db_session.add(event)
    db_session.flush()
    assert event.processing_result == processing_result


def test_stripe_event_rejects_unapproved_processing_result(
    db_session: Session,
) -> None:
    """Reject receipt outcomes outside the fixed Stage 10 vocabulary."""
    _assert_database_error(db_session, _event(processing_result="ignored"))


@pytest.mark.parametrize(
    "field_name",
    [
        "stripe_event_id",
        "event_type",
        "livemode",
        "stripe_created_at",
        "stripe_checkout_session_id",
        "processing_result",
    ],
)
def test_stripe_event_rejects_missing_required_fields(
    db_session: Session,
    field_name: str,
) -> None:
    """Require every provider and processing field without a default."""
    _assert_database_error(db_session, _event(**{field_name: None}))


@pytest.mark.parametrize("value", ["", "   "])
def test_stripe_event_id_must_be_nonblank(
    db_session: Session,
    value: str,
) -> None:
    """Reject empty and whitespace-only provider event identifiers."""
    _assert_database_error(db_session, _event(stripe_event_id=value))


@pytest.mark.parametrize("value", ["", "   "])
def test_checkout_session_id_must_be_nonblank(
    db_session: Session,
    value: str,
) -> None:
    """Reject empty and whitespace-only Checkout Session identifiers."""
    _assert_database_error(
        db_session,
        _event(stripe_checkout_session_id=value),
    )


@pytest.mark.parametrize("livemode", [False, True])
def test_stripe_event_persists_each_livemode_value(
    db_session: Session,
    livemode: bool,
) -> None:
    """Represent provider mode without a database environment policy."""
    event = _event(livemode=livemode)
    db_session.add(event)
    db_session.flush()
    assert event.livemode is livemode


def test_reconciliation_receipt_allows_null_payment(db_session: Session) -> None:
    """Persist an uncorrelated in-scope event without inventing a Payment."""
    event = _event(
        payment_id=None,
        processing_result="reconciliation_required",
    )
    db_session.add(event)
    db_session.flush()
    assert event.payment_id is None


def test_stripe_event_accepts_valid_payment_foreign_key(db_session: Session) -> None:
    """Associate a receipt with an existing Payment attempt."""
    payment = _payment(_order())
    db_session.add(payment)
    db_session.flush()
    event = _event(payment_id=payment.id)
    db_session.add(event)
    db_session.flush()
    assert event.payment_id == payment.id


def test_stripe_event_rejects_unknown_payment_foreign_key(
    db_session: Session,
) -> None:
    """Reject a non-null Payment reference that does not exist."""
    _assert_database_error(db_session, _event(payment_id=uuid.uuid4()))


def test_stripe_event_restricts_payment_deletion(db_session: Session) -> None:
    """Retain a Payment referenced by a durable event receipt."""
    payment = _payment(_order())
    db_session.add(payment)
    db_session.flush()
    event = _event(payment_id=payment.id)
    db_session.add(event)
    db_session.commit()
    payment_id = payment.id

    db_session.delete(payment)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()
    assert db_session.get(Payment, payment_id) is not None


def test_same_stripe_event_id_is_rejected_sequentially(db_session: Session) -> None:
    """Prevent a second durable receipt for one provider event."""
    event_id = f"evt_test_{uuid.uuid4().hex}"
    db_session.add(_event(stripe_event_id=event_id))
    db_session.commit()
    _assert_database_error(db_session, _event(stripe_event_id=event_id))


def test_same_stripe_event_id_is_rejected_concurrently(
    test_database_engine: Engine,
) -> None:
    """Allow only one committed receipt across concurrent database sessions."""
    event_id = f"evt_test_{uuid.uuid4().hex}"
    barrier = Barrier(2)

    def insert_receipt() -> str:
        with Session(test_database_engine) as session:
            session.execute(text("SET LOCAL lock_timeout = '5s'"))
            session.add(_event(stripe_event_id=event_id))
            barrier.wait(timeout=10)
            try:
                session.commit()
            except IntegrityError:
                session.rollback()
                return "duplicate"
        return "committed"

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(insert_receipt) for _ in range(2)]
            outcomes = [future.result(timeout=10) for future in futures]
        assert sorted(outcomes) == ["committed", "duplicate"]
        with Session(test_database_engine) as session:
            receipts = session.scalars(
                select(StripeEvent).where(StripeEvent.stripe_event_id == event_id)
            ).all()
        assert len(receipts) == 1
    finally:
        with test_database_engine.begin() as connection:
            connection.execute(
                StripeEvent.__table__.delete().where(
                    StripeEvent.stripe_event_id == event_id
                )
            )


@pytest.mark.parametrize(
    "variation",
    ["processing_result", "payment", "session"],
)
def test_stripe_event_id_is_globally_unique_across_other_fields(
    db_session: Session,
    variation: str,
) -> None:
    """Keep provider event uniqueness independent of mutable receipt details."""
    event_id = f"evt_test_{uuid.uuid4().hex}"
    db_session.add(_event(stripe_event_id=event_id))
    db_session.commit()
    changes: dict[str, object] = {}
    if variation == "processing_result":
        changes["processing_result"] = "already_applied"
    elif variation == "payment":
        payment = _payment(_order())
        db_session.add(payment)
        db_session.flush()
        changes["payment_id"] = payment.id
    else:
        changes["stripe_checkout_session_id"] = f"cs_test_{uuid.uuid4().hex}"
    _assert_database_error(
        db_session,
        _event(stripe_event_id=event_id, **changes),
    )


def test_different_event_ids_are_allowed(db_session: Session) -> None:
    """Permit distinct provider events to produce distinct receipts."""
    events = [_event(), _event()]
    db_session.add_all(events)
    db_session.flush()
    assert events[0].stripe_event_id != events[1].stripe_event_id


def test_same_session_allows_different_event_ids_and_types(
    db_session: Session,
) -> None:
    """Allow a Checkout Session to have a related sequence of event states."""
    session_id = f"cs_test_{uuid.uuid4().hex}"
    events = [
        _event(
            stripe_checkout_session_id=session_id,
            event_type="checkout.session.completed",
        ),
        _event(
            stripe_checkout_session_id=session_id,
            event_type="checkout.session.expired",
        ),
    ]
    db_session.add_all(events)
    db_session.flush()
    assert len({event.stripe_event_id for event in events}) == 2


def test_same_session_and_event_type_allow_different_event_ids(
    db_session: Session,
) -> None:
    """Avoid treating semantically similar provider events as duplicates."""
    session_id = f"cs_test_{uuid.uuid4().hex}"
    events = [
        _event(stripe_checkout_session_id=session_id),
        _event(stripe_checkout_session_id=session_id),
    ]
    db_session.add_all(events)
    db_session.flush()
    assert len({event.stripe_event_id for event in events}) == 2


def test_stripe_event_has_exact_constraints_and_indexes(
    test_database_engine: Engine,
) -> None:
    """Keep durable idempotency and history access definitions deterministic."""
    inspector = inspect(test_database_engine)
    assert inspector.get_pk_constraint("stripe_events")["name"] == ("pk_stripe_events")
    assert {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("stripe_events")
    } == {"uq_stripe_events_stripe_event_id"}
    assert {
        constraint["name"]
        for constraint in inspector.get_check_constraints("stripe_events")
    } == EXPECTED_CHECKS
    foreign_keys = inspector.get_foreign_keys("stripe_events")
    assert len(foreign_keys) == 1
    assert foreign_keys[0]["name"] == "fk_stripe_events_payment_id_payments"
    assert foreign_keys[0]["referred_table"] == "payments"
    assert foreign_keys[0]["options"]["ondelete"] == "RESTRICT"

    indexes = {
        index["name"]: index
        for index in inspector.get_indexes("stripe_events")
        if index["name"].startswith("ix_")
    }
    assert set(indexes) == set(EXPECTED_INDEXES)
    for name, columns in EXPECTED_INDEXES.items():
        assert indexes[name]["column_names"] == columns
        assert indexes[name]["unique"] is False

    with test_database_engine.connect() as connection:
        index_names = set(
            connection.scalars(
                text(
                    "SELECT indexname FROM pg_indexes "
                    "WHERE schemaname = 'public' AND tablename = 'stripe_events'"
                )
            )
        )
    assert index_names == {
        "pk_stripe_events",
        "uq_stripe_events_stripe_event_id",
        *EXPECTED_INDEXES,
    }
