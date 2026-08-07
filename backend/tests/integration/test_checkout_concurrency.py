"""PostgreSQL concurrency tests for checkout and D-017 lock ordering."""

from __future__ import annotations

from collections.abc import Callable, Generator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Event, Lock
from uuid import UUID, uuid4

import pytest
from sqlalchemy import delete, event, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.database.session import create_session_factory
from app.orders.access import (
    generate_order_access_token,
    generate_public_order_number,
    hash_order_access_token,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.statuses import OrderStatus, can_cancel_order
from app.payments.checkout import (
    ActivePaymentAttemptError,
    CheckoutOutcome,
    checkout_order,
)
from app.payments.models import Payment
from app.payments.policies import has_blocking_payment_status
from app.payments.statuses import PaymentStatus
from app.payments.stripe_checkout import (
    CheckoutSessionResult,
    StripeCheckoutDefinitiveError,
    StripeCheckoutRequest,
    build_stripe_idempotency_key,
)

pytestmark = pytest.mark.integration

NOW = datetime(2026, 8, 7, 12, tzinfo=UTC)
SUCCESS_TEMPLATE = "https://restaurant.example.test/{public_order_number}/ok"
CANCEL_TEMPLATE = "https://restaurant.example.test/{public_order_number}/cancel"
CHECKOUT_RESULT = CheckoutSessionResult(
    session_id="cs_concurrent_example",
    checkout_url="https://checkout.example.test/session/concurrent",
    expires_at=NOW + timedelta(hours=1),
)


class CallbackStripeClient:
    """Delegate fake provider creation to one deterministic callback."""

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
        """Record and execute one fake provider call without network access."""
        with self._lock:
            self.requests.append(request)
        return self.callback(request)


@pytest.fixture(autouse=True)
def empty_order_tables(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep concurrent tests isolated in the approved PostgreSQL database."""
    _clear_order_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_order_tables(test_database_engine)


@pytest.fixture
def checkout_session_factory(test_database_engine: Engine) -> sessionmaker[Session]:
    """Provide independent sessions for real PostgreSQL concurrency."""
    return create_session_factory(test_database_engine)


def _clear_order_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(delete(Payment))
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))


def _store_order(
    session_factory: sessionmaker[Session],
) -> tuple[UUID, str, str]:
    order_id = uuid4()
    public_number = generate_public_order_number()
    token = generate_order_access_token()
    with session_factory.begin() as session:
        session.add(
            Order(
                id=order_id,
                public_order_number=public_number,
                order_access_token_hash=hash_order_access_token(token),
                order_type="takeaway",
                table_id=None,
                table_number_snapshot=None,
                status=OrderStatus.CREATED.value,
                currency="NOK",
                subtotal_amount=53700,
                total_amount=53700,
            )
        )
    return order_id, public_number, token


def _run_checkout(
    session_factory: sessionmaker[Session],
    *,
    public_number: str,
    token: str,
    request_key: UUID,
    stripe_client: CallbackStripeClient,
) -> CheckoutOutcome:
    with session_factory() as session:
        return checkout_order(
            session,
            public_order_number=public_number,
            access_token=token,
            request_idempotency_key=request_key,
            stripe_client=stripe_client,  # type: ignore[arg-type]
            stripe_success_url_template=SUCCESS_TEMPLATE,
            stripe_cancel_url_template=CANCEL_TEMPLATE,
            now_provider=lambda: NOW,
        )


def _locked_cancellation_decision(
    session_factory: sessionmaker[Session],
    order_id: UUID,
) -> bool:
    with session_factory() as session, session.begin():
        order = session.scalar(
            select(Order).where(Order.id == order_id).with_for_update()
        )
        assert order is not None
        payments = session.scalars(
            select(Payment)
            .where(Payment.order_id == order.id)
            .order_by(Payment.created_at.asc(), Payment.id.asc())
            .with_for_update()
        ).all()
        return can_cancel_order(
            OrderStatus(order.status),
            has_blocking_payment=has_blocking_payment_status(
                payment.status for payment in payments
            ),
        )


def test_provider_call_has_no_transaction_and_releases_order_for_cancellation(
    checkout_session_factory: sessionmaker[Session],
) -> None:
    """Prove external I/O holds no DB transaction or Order/Payment lock."""
    order_id, public_number, token = _store_order(checkout_session_factory)
    provider_entered = Event()
    release_provider = Event()
    observed_no_transaction: list[bool] = []
    worker_session = checkout_session_factory()

    def provider_callback(_request: StripeCheckoutRequest) -> CheckoutSessionResult:
        observed_no_transaction.append(not worker_session.in_transaction())
        provider_entered.set()
        assert release_provider.wait(timeout=10)
        return CHECKOUT_RESULT

    fake = CallbackStripeClient(provider_callback)

    def worker() -> CheckoutOutcome:
        try:
            return checkout_order(
                worker_session,
                public_order_number=public_number,
                access_token=token,
                request_idempotency_key=uuid4(),
                stripe_client=fake,  # type: ignore[arg-type]
                stripe_success_url_template=SUCCESS_TEMPLATE,
                stripe_cancel_url_template=CANCEL_TEMPLATE,
                now_provider=lambda: NOW,
            )
        finally:
            worker_session.close()

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(worker)
        assert provider_entered.wait(timeout=10)
        assert (
            _locked_cancellation_decision(checkout_session_factory, order_id) is False
        )
        release_provider.set()
        outcome = future.result(timeout=10)

    assert observed_no_transaction == [True]
    assert outcome.created is True
    assert outcome.response.checkout_url == CHECKOUT_RESULT.checkout_url


def test_every_checkout_transaction_locks_order_before_ordered_payments(
    checkout_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Inspect SQL for the mandatory Order then Payment row-lock sequence."""
    _, public_number, token = _store_order(checkout_session_factory)
    statements: list[str] = []
    fake = CallbackStripeClient(lambda _request: CHECKOUT_RESULT)

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
        _run_checkout(
            checkout_session_factory,
            public_number=public_number,
            token=token,
            request_key=uuid4(),
            stripe_client=fake,
        )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    locked_entities = [
        "orders" if " from orders " in statement else "payments"
        for statement in statements
    ]
    assert locked_entities == ["orders", "payments", "orders", "payments"]
    payment_locks = [
        statement for statement in statements if " from payments " in statement
    ]
    assert all(
        "order by payments.created_at asc, payments.id asc" in statement
        for statement in payment_locks
    )


def test_same_key_concurrency_creates_one_payment_and_one_session_semantics(
    checkout_session_factory: sessionmaker[Session],
) -> None:
    """Serialize Phase 1 and converge concurrent provider retries by Stripe key."""
    _, public_number, token = _store_order(checkout_session_factory)
    request_key = uuid4()
    provider_barrier = Barrier(2)

    def provider_callback(_request: StripeCheckoutRequest) -> CheckoutSessionResult:
        provider_barrier.wait(timeout=10)
        return CHECKOUT_RESULT

    fake = CallbackStripeClient(provider_callback)

    def worker() -> CheckoutOutcome:
        return _run_checkout(
            checkout_session_factory,
            public_number=public_number,
            token=token,
            request_key=request_key,
            stripe_client=fake,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(lambda _index: worker(), range(2)))

    with checkout_session_factory() as session:
        payments = session.scalars(select(Payment)).all()
    assert len(payments) == 1
    payment = payments[0]
    assert payment.request_idempotency_key == request_key
    assert payment.stripe_idempotency_key == build_stripe_idempotency_key(payment.id)
    assert payment.stripe_checkout_session_id == CHECKOUT_RESULT.session_id
    assert len(fake.requests) == 2
    assert {request.stripe_idempotency_key for request in fake.requests} == {
        payment.stripe_idempotency_key
    }
    assert {outcome.created for outcome in outcomes} == {True, False}
    assert len({outcome.response.checkout_url for outcome in outcomes}) == 1


def test_different_key_concurrency_creates_one_attempt_and_one_provider_call(
    checkout_session_factory: sessionmaker[Session],
) -> None:
    """Block a different key after serialized observation of the pending attempt."""
    _, public_number, token = _store_order(checkout_session_factory)
    provider_entered = Event()
    release_provider = Event()

    def provider_callback(_request: StripeCheckoutRequest) -> CheckoutSessionResult:
        provider_entered.set()
        assert release_provider.wait(timeout=10)
        return CHECKOUT_RESULT

    fake = CallbackStripeClient(provider_callback)
    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(
            _run_checkout,
            checkout_session_factory,
            public_number=public_number,
            token=token,
            request_key=uuid4(),
            stripe_client=fake,
        )
        assert provider_entered.wait(timeout=10)
        with pytest.raises(ActivePaymentAttemptError):
            _run_checkout(
                checkout_session_factory,
                public_number=public_number,
                token=token,
                request_key=uuid4(),
                stripe_client=fake,
            )
        release_provider.set()
        assert first.result(timeout=10).created is True

    with checkout_session_factory() as session:
        assert len(session.scalars(select(Payment)).all()) == 1
    assert len(fake.requests) == 1


def test_stale_definitive_failure_cannot_overwrite_concurrent_success(
    checkout_session_factory: sessionmaker[Session],
) -> None:
    """Return stored success when another same-key request wins Phase 3."""
    _, public_number, token = _store_order(checkout_session_factory)
    request_key = uuid4()
    both_provider_calls = Event()
    success_persisted = Event()
    call_lock = Lock()
    call_count = 0

    def provider_callback(_request: StripeCheckoutRequest) -> CheckoutSessionResult:
        nonlocal call_count
        with call_lock:
            call_count += 1
            current_call = call_count
            if call_count == 2:
                both_provider_calls.set()
        assert both_provider_calls.wait(timeout=10)
        if current_call == 1:
            return CHECKOUT_RESULT
        assert success_persisted.wait(timeout=10)
        raise StripeCheckoutDefinitiveError("stale definitive failure")

    fake = CallbackStripeClient(provider_callback)

    def worker() -> CheckoutOutcome:
        outcome = _run_checkout(
            checkout_session_factory,
            public_number=public_number,
            token=token,
            request_key=request_key,
            stripe_client=fake,
        )
        if outcome.response.checkout_url == CHECKOUT_RESULT.checkout_url:
            success_persisted.set()
        return outcome

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(lambda _index: worker(), range(2)))

    with checkout_session_factory() as session:
        payment = session.scalar(select(Payment))
    assert payment is not None
    assert payment.status == PaymentStatus.PENDING.value
    assert payment.stripe_checkout_session_id == CHECKOUT_RESULT.session_id
    assert len(outcomes) == 2
    assert all(
        outcome.response.checkout_url == CHECKOUT_RESULT.checkout_url
        for outcome in outcomes
    )


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (PaymentStatus.PENDING, False),
        (PaymentStatus.SUCCEEDED, False),
        (PaymentStatus.FAILED, True),
        (PaymentStatus.EXPIRED, True),
    ],
)
def test_future_cancellation_uses_the_same_order_payment_lock_protocol(
    checkout_session_factory: sessionmaker[Session],
    status: PaymentStatus,
    expected: bool,
) -> None:
    """Apply D-016 under the same D-017 Order-to-Payment locking order."""
    order_id, _, _ = _store_order(checkout_session_factory)
    payment_id = uuid4()
    with checkout_session_factory.begin() as session:
        session.add(
            Payment(
                id=payment_id,
                order_id=order_id,
                status=status.value,
                amount=53700,
                currency="NOK",
                request_idempotency_key=uuid4(),
                stripe_idempotency_key=build_stripe_idempotency_key(payment_id),
            )
        )
    assert _locked_cancellation_decision(checkout_session_factory, order_id) is expected


def test_unexpected_payment_insert_error_rolls_back_and_propagates(
    checkout_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Do not disguise an unexpected persistence failure as a provider outcome."""
    _, public_number, token = _store_order(checkout_session_factory)
    fake = CallbackStripeClient(lambda _request: CHECKOUT_RESULT)

    def reject_payment_insert(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().upper().startswith("INSERT INTO PAYMENTS"):
            raise RuntimeError("injected persistence failure")

    event.listen(test_database_engine, "before_cursor_execute", reject_payment_insert)
    try:
        with pytest.raises(RuntimeError, match="injected persistence failure"):
            _run_checkout(
                checkout_session_factory,
                public_number=public_number,
                token=token,
                request_key=uuid4(),
                stripe_client=fake,
            )
    finally:
        event.remove(
            test_database_engine,
            "before_cursor_execute",
            reject_payment_insert,
        )

    with checkout_session_factory() as session:
        assert session.scalar(select(Payment)) is None
        assert session.execute(text("SELECT 1")).scalar_one() == 1
    assert fake.requests == []
