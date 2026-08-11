"""PostgreSQL concurrency tests for administrator order transitions."""

from __future__ import annotations

import uuid
from collections.abc import Callable, Generator
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Event, local
from uuid import UUID

import pytest
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.orders.access import generate_public_order_number
from app.orders.admin_service import (
    AdminOrderCannotCancelError,
    AdminOrderInvalidTransitionError,
    AdminOrderNotPaidError,
    transition_order_status,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.statuses import OrderStatus
from app.payments.models import Payment, StripeEvent
from app.payments.statuses import PaymentStatus
from app.payments.stripe_checkout import build_stripe_idempotency_key
from app.payments.stripe_webhook import (
    StripeWebhookEventType,
    VerifiedStripeCheckoutEvent,
)
from app.payments.webhook import (
    WebhookProcessingOutcome,
    process_verified_stripe_event,
)

pytestmark = pytest.mark.integration

NOW = datetime(2026, 8, 11, 12, tzinfo=UTC)


@pytest.fixture(autouse=True)
def empty_admin_transition_tables(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep transition races isolated in the approved PostgreSQL database."""

    def clear() -> None:
        with test_database_engine.begin() as connection:
            connection.execute(delete(StripeEvent))
            connection.execute(delete(Payment))
            connection.execute(delete(OrderStatusHistory))
            connection.execute(delete(OrderItem))
            connection.execute(delete(Order))

    clear()
    try:
        yield
    finally:
        clear()


@pytest.fixture
def transition_session_factory(
    test_database_engine: Engine,
) -> Generator[sessionmaker[Session], None, None]:
    """Provide independent sessions with bounded PostgreSQL lock waits."""

    def configure_lock_timeout(
        dbapi_connection: object,
        _connection_record: object,
        _connection_proxy: object,
    ) -> None:
        cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
        try:
            cursor.execute("SET lock_timeout = '5s'")
        finally:
            cursor.close()

    event.listen(test_database_engine, "checkout", configure_lock_timeout)
    try:
        yield sessionmaker[Session](
            bind=test_database_engine,
            expire_on_commit=False,
        )
    finally:
        event.remove(test_database_engine, "checkout", configure_lock_timeout)


def _store_order(
    session_factory: sessionmaker[Session],
    *,
    status: OrderStatus,
    payment_status: PaymentStatus | None = None,
) -> tuple[Order, Payment | None]:
    order = Order(
        id=uuid.uuid4(),
        public_order_number=generate_public_order_number(),
        order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
        order_type="takeaway",
        table_id=None,
        table_number_snapshot=None,
        status=status.value,
        currency="NOK",
        subtotal_amount=500,
        total_amount=500,
    )
    status_path = (
        [OrderStatus.CREATED, OrderStatus.ACCEPTED]
        if status is OrderStatus.ACCEPTED
        else [OrderStatus.CREATED]
    )
    payment = None
    with session_factory.begin() as session:
        session.add(order)
        session.flush()
        session.add_all(
            [
                OrderStatusHistory(
                    order_id=order.id,
                    sequence=sequence,
                    previous_status=(
                        status_path[sequence - 1].value if sequence else None
                    ),
                    new_status=status_value.value,
                )
                for sequence, status_value in enumerate(status_path)
            ]
        )
        if payment_status is not None:
            payment_id = uuid.uuid4()
            payment = Payment(
                id=payment_id,
                order_id=order.id,
                status=payment_status.value,
                amount=order.total_amount,
                currency=order.currency,
                request_idempotency_key=uuid.uuid4(),
                stripe_idempotency_key=build_stripe_idempotency_key(payment_id),
            )
            session.add(payment)
    return order, payment


def _transition(
    session_factory: sessionmaker[Session],
    order: Order,
    target_status: OrderStatus,
) -> OrderStatus:
    with session_factory() as session:
        response = transition_order_status(
            session,
            public_order_number=order.public_order_number,
            target_status=target_status,
        )
    return response.status


def _run_order_lock_race(
    engine: Engine,
    first_work: Callable[[], object],
    second_work: Callable[[], object],
) -> tuple[object, object]:
    thread_role = local()
    first_locked = Event()
    release_first = Event()
    second_attempted = Event()

    def before_cursor_execute(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        normalized = " ".join(statement.lower().split())
        if (
            getattr(thread_role, "value", None) == "second"
            and " from orders " in normalized
            and "for update" in normalized
        ):
            second_attempted.set()

    def after_cursor_execute(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        normalized = " ".join(statement.lower().split())
        if (
            getattr(thread_role, "value", None) == "first"
            and " from orders " in normalized
            and "for update" in normalized
        ):
            first_locked.set()
            assert release_first.wait(timeout=10)

    def wrapped(role: str, work: Callable[[], object]) -> object:
        thread_role.value = role
        return work()

    event.listen(engine, "before_cursor_execute", before_cursor_execute)
    event.listen(engine, "after_cursor_execute", after_cursor_execute)
    first: Future[object] | None = None
    second: Future[object] | None = None
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(wrapped, "first", first_work)
            assert first_locked.wait(timeout=10)
            second = executor.submit(wrapped, "second", second_work)
            assert second_attempted.wait(timeout=10)
            release_first.set()
            return first.result(timeout=10), second.result(timeout=10)
    finally:
        release_first.set()
        event.remove(engine, "before_cursor_execute", before_cursor_execute)
        event.remove(engine, "after_cursor_execute", after_cursor_execute)


def _history(
    session_factory: sessionmaker[Session],
    order_id: UUID,
) -> list[OrderStatusHistory]:
    with session_factory() as session:
        return list(
            session.scalars(
                select(OrderStatusHistory)
                .where(OrderStatusHistory.order_id == order_id)
                .order_by(OrderStatusHistory.sequence.asc())
            ).all()
        )


def test_concurrent_same_transition_appends_one_unique_history_row(
    transition_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Serialize two accepted-to-preparing attempts at the Order lock."""
    order, _ = _store_order(
        transition_session_factory,
        status=OrderStatus.ACCEPTED,
    )

    def attempt() -> OrderStatus | str:
        try:
            return _transition(
                transition_session_factory,
                order,
                OrderStatus.PREPARING,
            )
        except AdminOrderInvalidTransitionError:
            return "invalid"

    outcomes = _run_order_lock_race(
        test_database_engine,
        attempt,
        attempt,
    )
    assert outcomes == (OrderStatus.PREPARING, "invalid")

    with transition_session_factory() as session:
        stored_order = session.get(Order, order.id)
    history = _history(transition_session_factory, order.id)
    assert stored_order is not None
    assert stored_order.status == OrderStatus.PREPARING.value
    assert [entry.sequence for entry in history] == [0, 1, 2]
    assert history[-1].previous_status == OrderStatus.ACCEPTED.value
    assert history[-1].new_status == OrderStatus.PREPARING.value


@pytest.mark.parametrize("first_action", ["accept", "cancel"])
def test_accept_and_cancel_race_converges_on_paid_acceptance(
    transition_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    first_action: str,
) -> None:
    """Prevent a succeeded Payment from coexisting with cancellation."""
    order, payment = _store_order(
        transition_session_factory,
        status=OrderStatus.CREATED,
        payment_status=PaymentStatus.SUCCEEDED,
    )
    assert payment is not None

    def accept() -> str:
        try:
            _transition(transition_session_factory, order, OrderStatus.ACCEPTED)
            return "accepted"
        except AdminOrderInvalidTransitionError:
            return "invalid"

    def cancel() -> str:
        try:
            _transition(transition_session_factory, order, OrderStatus.CANCELLED)
            return "cancelled"
        except AdminOrderCannotCancelError:
            return "paid"
        except AdminOrderInvalidTransitionError:
            return "invalid"

    first = accept if first_action == "accept" else cancel
    second = cancel if first_action == "accept" else accept
    outcomes = _run_order_lock_race(test_database_engine, first, second)
    assert "accepted" in outcomes
    assert "cancelled" not in outcomes

    with transition_session_factory() as session:
        stored_order = session.get(Order, order.id)
        stored_payment = session.get(Payment, payment.id)
    history = _history(transition_session_factory, order.id)
    assert stored_order is not None
    assert stored_payment is not None
    assert stored_order.status == OrderStatus.ACCEPTED.value
    assert stored_payment.status == PaymentStatus.SUCCEEDED.value
    assert [entry.sequence for entry in history] == [0, 1]
    assert history[-1].new_status == OrderStatus.ACCEPTED.value


def _verified_success_event(
    order: Order,
    payment: Payment,
) -> VerifiedStripeCheckoutEvent:
    return VerifiedStripeCheckoutEvent(
        stripe_event_id=f"evt_admin_accept_{uuid.uuid4().hex}",
        event_type=StripeWebhookEventType.COMPLETED,
        livemode=False,
        stripe_created_at=NOW,
        stripe_checkout_session_id="cs_synthetic_admin_accept_race",
        session_status="complete",
        payment_status="paid",
        mode="payment",
        amount_total=payment.amount,
        currency=payment.currency.lower(),
        metadata_payment_id=str(payment.id),
        metadata_order_id=str(order.id),
        metadata_public_order_number=order.public_order_number,
    )


@pytest.mark.parametrize("first_action", ["accept", "webhook"])
def test_accept_and_success_webhook_never_accepts_without_succeeded_payment(
    transition_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    first_action: str,
) -> None:
    """Serialize acceptance with the provider-authoritative success update."""
    order, payment = _store_order(
        transition_session_factory,
        status=OrderStatus.CREATED,
        payment_status=PaymentStatus.PENDING,
    )
    assert payment is not None
    verified = _verified_success_event(order, payment)

    def accept() -> str:
        try:
            _transition(transition_session_factory, order, OrderStatus.ACCEPTED)
            return "accepted"
        except AdminOrderNotPaidError:
            return "not_paid"

    def webhook() -> WebhookProcessingOutcome:
        with transition_session_factory() as session:
            return process_verified_stripe_event(session, verified)

    first = accept if first_action == "accept" else webhook
    second = webhook if first_action == "accept" else accept
    outcomes = _run_order_lock_race(test_database_engine, first, second)
    assert WebhookProcessingOutcome.TRANSITIONED in outcomes

    with transition_session_factory() as session:
        stored_order = session.get(Order, order.id)
        stored_payment = session.get(Payment, payment.id)
    history = _history(transition_session_factory, order.id)
    assert stored_order is not None
    assert stored_payment is not None
    assert stored_payment.status == PaymentStatus.SUCCEEDED.value
    if first_action == "accept":
        assert outcomes[0] == "not_paid"
        assert stored_order.status == OrderStatus.CREATED.value
        assert [entry.sequence for entry in history] == [0]
    else:
        assert outcomes[1] == "accepted"
        assert stored_order.status == OrderStatus.ACCEPTED.value
        assert [entry.sequence for entry in history] == [0, 1]
