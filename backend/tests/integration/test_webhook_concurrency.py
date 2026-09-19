"""PostgreSQL concurrency tests for Stripe webhook financial invariants."""

from __future__ import annotations

from collections.abc import Callable, Generator
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Event, Lock, local
from uuid import uuid4

import pytest
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.orders.access import (
    generate_order_access_token,
    generate_public_order_number,
    hash_order_access_token,
)
from app.orders.admin_service import (
    AdminOrderActivePaymentError,
    AdminOrderCannotCancelError,
    AdminOrderInvalidTransitionError,
    transition_order_status,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.statuses import OrderStatus
from app.payments.checkout import (
    CheckoutOutcome,
    PaymentSessionReconciliationRequiredError,
    checkout_order,
)
from app.payments.models import Payment, StripeEvent
from app.payments.statuses import PaymentStatus
from app.payments.stripe_checkout import (
    CheckoutSessionResult,
    StripeCheckoutRequest,
    build_stripe_idempotency_key,
)
from app.payments.stripe_webhook import (
    StripeWebhookEventType,
    VerifiedStripeCheckoutEvent,
)
from app.payments.webhook import (
    WebhookProcessingOutcome,
    process_verified_stripe_event,
)

pytestmark = pytest.mark.integration

NOW = datetime(2026, 8, 8, 12, tzinfo=UTC)
SUCCESS_TEMPLATE = "https://restaurant.example.test/{public_order_number}/ok"
CANCEL_TEMPLATE = "https://restaurant.example.test/{public_order_number}/cancel"
CHECKOUT_RESULT = CheckoutSessionResult(
    session_id="cs_synthetic_checkout_race",
    checkout_url="https://checkout.example.test/session/race",
    expires_at=NOW + timedelta(hours=1),
)


class CallbackStripeClient:
    """Execute one deterministic fake provider callback without network access."""

    def __init__(
        self,
        callback: Callable[[StripeCheckoutRequest], CheckoutSessionResult],
    ) -> None:
        self.callback = callback
        self.requests: list[StripeCheckoutRequest] = []
        self._lock = Lock()

    def create_checkout_session(
        self,
        request: StripeCheckoutRequest,
    ) -> CheckoutSessionResult:
        """Record the request and return the callback's synthetic result."""
        with self._lock:
            self.requests.append(request)
        return self.callback(request)


@pytest.fixture(autouse=True)
def empty_order_tables(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep financial races isolated in the approved PostgreSQL database."""
    _clear_order_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_order_tables(test_database_engine)


@pytest.fixture
def concurrency_session_factory(
    test_database_engine: Engine,
) -> Generator[sessionmaker[Session], None, None]:
    """Provide independent sessions with a bounded PostgreSQL lock wait."""

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


def _clear_order_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(delete(StripeEvent))
        connection.execute(delete(Payment))
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))


def _store_order(
    session_factory: sessionmaker[Session],
) -> tuple[Order, str]:
    token = generate_order_access_token()
    order = Order(
        id=uuid4(),
        public_order_number=generate_public_order_number(),
        order_access_token_hash=hash_order_access_token(token),
        order_type="takeaway",
        table_id=None,
        table_number_snapshot=None,
        status=OrderStatus.CREATED.value,
        currency="NOK",
        subtotal_amount=53700,
        total_amount=53700,
    )
    with session_factory.begin() as session:
        session.add(order)
        session.add(
            OrderStatusHistory(
                order=order,
                sequence=0,
                previous_status=None,
                new_status=OrderStatus.CREATED.value,
            )
        )
    return order, token


def _store_payment(
    session_factory: sessionmaker[Session],
    order: Order,
    *,
    status: PaymentStatus = PaymentStatus.PENDING,
) -> Payment:
    payment_id = uuid4()
    payment = Payment(
        id=payment_id,
        order_id=order.id,
        status=status.value,
        amount=order.total_amount,
        currency=order.currency,
        request_idempotency_key=uuid4(),
        provider="stripe_test",
        provider_idempotency_key=build_stripe_idempotency_key(payment_id),
        succeeded_at=(
            NOW - timedelta(days=1) if status is PaymentStatus.SUCCEEDED else None
        ),
    )
    with session_factory.begin() as session:
        session.add(payment)
    return payment


def _verified_event(
    order: Order,
    payment: Payment,
    *,
    event_type: StripeWebhookEventType = StripeWebhookEventType.COMPLETED,
    stripe_event_id: str | None = None,
) -> VerifiedStripeCheckoutEvent:
    session_status = (
        "expired" if event_type is StripeWebhookEventType.EXPIRED else "complete"
    )
    provider_payment_status = (
        "unpaid"
        if event_type
        in {
            StripeWebhookEventType.ASYNC_PAYMENT_FAILED,
            StripeWebhookEventType.EXPIRED,
        }
        else "paid"
    )
    return VerifiedStripeCheckoutEvent(
        stripe_event_id=stripe_event_id or f"evt_synthetic_{uuid4().hex}",
        event_type=event_type,
        livemode=False,
        stripe_created_at=NOW,
        stripe_checkout_session_id=CHECKOUT_RESULT.session_id,
        session_status=session_status,
        payment_status=provider_payment_status,
        mode="payment",
        amount_total=payment.amount,
        currency=payment.currency.lower(),
        metadata_payment_id=str(payment.id),
        metadata_order_id=str(order.id),
        metadata_public_order_number=order.public_order_number,
    )


def _process(
    session_factory: sessionmaker[Session],
    verified_event: VerifiedStripeCheckoutEvent,
) -> WebhookProcessingOutcome:
    with session_factory() as session:
        return process_verified_stripe_event(session, verified_event)


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


def test_concurrent_known_duplicate_transitions_once_and_stores_one_receipt(
    concurrency_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Serialize identical known deliveries at the shared Order row."""
    order, _ = _store_order(concurrency_session_factory)
    payment = _store_payment(concurrency_session_factory, order)
    verified = _verified_event(
        order,
        payment,
        stripe_event_id="evt_known_duplicate_race",
    )
    outcomes = _run_order_lock_race(
        test_database_engine,
        lambda: _process(concurrency_session_factory, verified),
        lambda: _process(concurrency_session_factory, verified),
    )
    with concurrency_session_factory() as session:
        stored_payment = session.get(Payment, payment.id)
        receipts = list(session.scalars(select(StripeEvent)).all())
    assert set(outcomes) == {
        WebhookProcessingOutcome.TRANSITIONED,
        WebhookProcessingOutcome.DUPLICATE,
    }
    assert stored_payment is not None
    assert stored_payment.status == PaymentStatus.SUCCEEDED.value
    assert stored_payment.succeeded_at == NOW
    assert len(receipts) == 1


def test_concurrent_unknown_duplicate_uses_unique_receipt_without_deadlock(
    concurrency_session_factory: sessionmaker[Session],
) -> None:
    """Converge uncorrelated deliveries through ON CONFLICT without fake locks."""
    order, _ = _store_order(concurrency_session_factory)
    payment = _store_payment(concurrency_session_factory, order)
    verified = _verified_event(
        order,
        payment,
        stripe_event_id="evt_unknown_duplicate_race",
    )
    verified = VerifiedStripeCheckoutEvent(
        **{
            **verified.__dict__,
            "metadata_payment_id": "malformed-payment-id",
        }
    )
    barrier = Barrier(2)

    def worker() -> WebhookProcessingOutcome:
        barrier.wait(timeout=10)
        return _process(concurrency_session_factory, verified)

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(lambda _index: worker(), range(2)))
    with concurrency_session_factory() as session:
        stored_payment = session.get(Payment, payment.id)
        receipts = list(session.scalars(select(StripeEvent)).all())
    assert set(outcomes) == {
        WebhookProcessingOutcome.RECONCILIATION_REQUIRED,
        WebhookProcessingOutcome.DUPLICATE,
    }
    assert stored_payment is not None
    assert stored_payment.status == PaymentStatus.PENDING.value
    assert len(receipts) == 1
    assert receipts[0].payment_id is None


@pytest.mark.parametrize(
    ("first_type", "second_type", "expected_status"),
    [
        (
            StripeWebhookEventType.COMPLETED,
            StripeWebhookEventType.EXPIRED,
            PaymentStatus.SUCCEEDED,
        ),
        (
            StripeWebhookEventType.EXPIRED,
            StripeWebhookEventType.COMPLETED,
            PaymentStatus.EXPIRED,
        ),
    ],
)
def test_first_terminal_outcome_wins_concurrent_success_expired_race(
    concurrency_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    first_type: StripeWebhookEventType,
    second_type: StripeWebhookEventType,
    expected_status: PaymentStatus,
) -> None:
    """Receipt both events while preserving the first committed terminal state."""
    order, _ = _store_order(concurrency_session_factory)
    payment = _store_payment(concurrency_session_factory, order)
    first_event = _verified_event(order, payment, event_type=first_type)
    second_event = _verified_event(order, payment, event_type=second_type)
    outcomes = _run_order_lock_race(
        test_database_engine,
        lambda: _process(concurrency_session_factory, first_event),
        lambda: _process(concurrency_session_factory, second_event),
    )
    with concurrency_session_factory() as session:
        stored_payment = session.get(Payment, payment.id)
        receipts = list(session.scalars(select(StripeEvent)).all())
    assert outcomes == (
        WebhookProcessingOutcome.TRANSITIONED,
        WebhookProcessingOutcome.RECONCILIATION_REQUIRED,
    )
    assert stored_payment is not None
    assert stored_payment.status == expected_status.value
    assert len(receipts) == 2
    assert {item.processing_result for item in receipts} == {
        "transitioned",
        "reconciliation_required",
    }


def _run_checkout(
    session_factory: sessionmaker[Session],
    *,
    order: Order,
    token: str,
    stripe_client: CallbackStripeClient,
) -> CheckoutOutcome:
    with session_factory() as session:
        return checkout_order(
            session,
            public_order_number=order.public_order_number,
            access_token=token,
            request_idempotency_key=uuid4(),
            stripe_client=stripe_client,  # type: ignore[arg-type]
            stripe_success_url_template=SUCCESS_TEMPLATE,
            stripe_cancel_url_template=CANCEL_TEMPLATE,
            now_provider=lambda: NOW,
        )


def test_webhook_success_before_checkout_phase_three_fills_session_tuple(
    concurrency_session_factory: sessionmaker[Session],
) -> None:
    """Preserve webhook success while Phase 3 stores its trusted provider tuple."""
    order, token = _store_order(concurrency_session_factory)
    provider_entered = Event()
    release_provider = Event()

    def provider_callback(_request: StripeCheckoutRequest) -> CheckoutSessionResult:
        provider_entered.set()
        assert release_provider.wait(timeout=10)
        return CHECKOUT_RESULT

    fake = CallbackStripeClient(provider_callback)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            _run_checkout,
            concurrency_session_factory,
            order=order,
            token=token,
            stripe_client=fake,
        )
        assert provider_entered.wait(timeout=10)
        with concurrency_session_factory() as session:
            payment = session.scalar(select(Payment))
        assert payment is not None
        verified = _verified_event(order, payment)
        assert (
            _process(concurrency_session_factory, verified)
            is WebhookProcessingOutcome.TRANSITIONED
        )
        release_provider.set()
        outcome = future.result(timeout=10)

    with concurrency_session_factory() as session:
        stored_payment = session.get(Payment, payment.id)
        receipts = list(session.scalars(select(StripeEvent)).all())
    assert outcome.response.payment_status is PaymentStatus.SUCCEEDED
    assert stored_payment is not None
    assert stored_payment.status == PaymentStatus.SUCCEEDED.value
    assert stored_payment.succeeded_at == NOW
    assert stored_payment.provider_session_id == CHECKOUT_RESULT.session_id
    assert stored_payment.provider_checkout_url == CHECKOUT_RESULT.checkout_url
    assert stored_payment.provider_checkout_expires_at == CHECKOUT_RESULT.expires_at
    assert len(receipts) == 1


@pytest.mark.parametrize(
    "event_type",
    [StripeWebhookEventType.ASYNC_PAYMENT_FAILED, StripeWebhookEventType.EXPIRED],
)
def test_failed_or_expired_webhook_before_phase_three_remains_incompatible(
    concurrency_session_factory: sessionmaker[Session],
    event_type: StripeWebhookEventType,
) -> None:
    """Never fill provider success fields after a failure or expiration wins."""
    order, token = _store_order(concurrency_session_factory)
    provider_entered = Event()
    release_provider = Event()

    def provider_callback(_request: StripeCheckoutRequest) -> CheckoutSessionResult:
        provider_entered.set()
        assert release_provider.wait(timeout=10)
        return CHECKOUT_RESULT

    fake = CallbackStripeClient(provider_callback)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            _run_checkout,
            concurrency_session_factory,
            order=order,
            token=token,
            stripe_client=fake,
        )
        assert provider_entered.wait(timeout=10)
        with concurrency_session_factory() as session:
            payment = session.scalar(select(Payment))
        assert payment is not None
        verified = _verified_event(order, payment, event_type=event_type)
        assert (
            _process(concurrency_session_factory, verified)
            is WebhookProcessingOutcome.TRANSITIONED
        )
        release_provider.set()
        with pytest.raises(PaymentSessionReconciliationRequiredError):
            future.result(timeout=10)

    with concurrency_session_factory() as session:
        stored_payment = session.get(Payment, payment.id)
    assert stored_payment is not None
    assert stored_payment.status == (
        PaymentStatus.FAILED.value
        if event_type is StripeWebhookEventType.ASYNC_PAYMENT_FAILED
        else PaymentStatus.EXPIRED.value
    )
    assert stored_payment.succeeded_at is None
    assert stored_payment.provider_session_id is None
    assert stored_payment.provider_checkout_url is None
    assert stored_payment.provider_checkout_expires_at is None


def _run_cancellation(
    session_factory: sessionmaker[Session],
    public_number: str,
) -> bool:
    with session_factory() as session:
        try:
            transition_order_status(
                session,
                public_order_number=public_number,
                target_status=OrderStatus.CANCELLED,
            )
        except (
            AdminOrderActivePaymentError,
            AdminOrderCannotCancelError,
            AdminOrderInvalidTransitionError,
        ):
            return False
    return True


@pytest.mark.parametrize(
    ("event_type", "expected_cancellable"),
    [
        (StripeWebhookEventType.COMPLETED, False),
        (StripeWebhookEventType.ASYNC_PAYMENT_FAILED, True),
        (StripeWebhookEventType.EXPIRED, True),
    ],
)
def test_webhook_and_real_cancellation_share_lock_order_without_deadlock(
    concurrency_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    event_type: StripeWebhookEventType,
    expected_cancellable: bool,
) -> None:
    """Make cancellation observe the committed webhook terminal state."""
    order, _ = _store_order(concurrency_session_factory)
    payment = _store_payment(concurrency_session_factory, order)
    verified = _verified_event(order, payment, event_type=event_type)
    webhook_outcome, cancellation_applied = _run_order_lock_race(
        test_database_engine,
        lambda: _process(concurrency_session_factory, verified),
        lambda: _run_cancellation(
            concurrency_session_factory,
            order.public_order_number,
        ),
    )
    assert webhook_outcome is WebhookProcessingOutcome.TRANSITIONED
    assert cancellation_applied is expected_cancellable

    with concurrency_session_factory() as session:
        stored_order = session.get(Order, order.id)
        stored_payment = session.get(Payment, payment.id)
    assert stored_order is not None
    assert stored_payment is not None
    assert stored_order.status == (
        OrderStatus.CANCELLED.value
        if expected_cancellable
        else OrderStatus.CREATED.value
    )
    assert stored_payment.status == (
        PaymentStatus.SUCCEEDED.value
        if event_type is StripeWebhookEventType.COMPLETED
        else (
            PaymentStatus.FAILED.value
            if event_type is StripeWebhookEventType.ASYNC_PAYMENT_FAILED
            else PaymentStatus.EXPIRED.value
        )
    )
    assert stored_payment.succeeded_at == (
        NOW if event_type is StripeWebhookEventType.COMPLETED else None
    )


def test_pending_payment_blocks_real_cancellation(
    concurrency_session_factory: sessionmaker[Session],
) -> None:
    """Retain D-016 before any terminal webhook has arrived."""
    order, _ = _store_order(concurrency_session_factory)
    _store_payment(concurrency_session_factory, order)
    assert (
        _run_cancellation(
            concurrency_session_factory,
            order.public_order_number,
        )
        is False
    )


def test_cancellation_attempt_before_success_webhook_cannot_create_invalid_state(
    concurrency_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Block cancellation on pending before the waiting webhook succeeds."""
    order, _ = _store_order(concurrency_session_factory)
    payment = _store_payment(concurrency_session_factory, order)
    verified = _verified_event(order, payment)

    cancellation_result, webhook_outcome = _run_order_lock_race(
        test_database_engine,
        lambda: _run_cancellation(
            concurrency_session_factory,
            order.public_order_number,
        ),
        lambda: _process(concurrency_session_factory, verified),
    )
    assert cancellation_result is False
    assert webhook_outcome is WebhookProcessingOutcome.TRANSITIONED

    with concurrency_session_factory() as session:
        stored_order = session.get(Order, order.id)
        stored_payment = session.get(Payment, payment.id)
        history = list(
            session.scalars(
                select(OrderStatusHistory)
                .where(OrderStatusHistory.order_id == order.id)
                .order_by(OrderStatusHistory.sequence.asc())
            ).all()
        )
    assert stored_order is not None
    assert stored_payment is not None
    assert stored_order.status == OrderStatus.CREATED.value
    assert stored_payment.status == PaymentStatus.SUCCEEDED.value
    assert stored_payment.succeeded_at == NOW
    assert [entry.sequence for entry in history] == [0]


def test_known_webhook_locks_order_before_ordered_payments(
    concurrency_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Inspect SQL for the mandatory D-017 lock order and deterministic sort."""
    order, _ = _store_order(concurrency_session_factory)
    payment = _store_payment(concurrency_session_factory, order)
    verified = _verified_event(order, payment)
    statements: list[str] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if "FOR UPDATE" in statement.upper():
            statements.append(" ".join(statement.lower().split()))

    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        _process(concurrency_session_factory, verified)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)
    locked_entities = [
        "orders" if " from orders " in statement else "payments"
        for statement in statements
    ]
    assert locked_entities == ["orders", "payments"]
    assert "order by payments.created_at asc, payments.id asc" in statements[1]
