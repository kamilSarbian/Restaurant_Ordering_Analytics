"""PostgreSQL concurrency tests for checkout and D-017 lock ordering."""

from __future__ import annotations

from collections.abc import Callable, Generator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Event, Lock, local
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.service import UserTokenService
from app.core.config import Settings
from app.core.rate_limit import FixedWindowRateLimiter
from app.database.session import create_session_factory
from app.main import create_app
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
    ActivePaymentAttemptError,
    CheckoutOutcome,
    OrderNotPayableError,
    checkout_order,
)
from app.payments.models import Payment
from app.payments.providers import PaymentProvider
from app.payments.statuses import PaymentStatus
from app.payments.stripe_checkout import (
    CheckoutSessionResult,
    StripeCheckoutDefinitiveError,
    StripeCheckoutRequest,
    build_stripe_idempotency_key,
)

pytestmark = pytest.mark.integration

NOW = datetime(2026, 8, 7, 12, tzinfo=UTC)
CHECKOUT_PATH = "/api/v1/orders/{public_order_number}/checkout-session"
SYNTHETIC_SECRET = "s" * 32
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
        connection.execute(delete(User))


def _store_order(
    session_factory: sessionmaker[Session],
    *,
    customer_user_id: UUID | None = None,
) -> tuple[UUID, str, str]:
    order_id = uuid4()
    public_number = generate_public_order_number()
    token = generate_order_access_token()
    with session_factory.begin() as session:
        order = Order(
            id=order_id,
            public_order_number=public_number,
            order_access_token_hash=hash_order_access_token(token),
            customer_user_id=customer_user_id,
            order_type="takeaway",
            table_id=None,
            table_number_snapshot=None,
            status=OrderStatus.CREATED.value,
            currency="NOK",
            subtotal_amount=53700,
            total_amount=53700,
        )
        session.add(order)
        session.add(
            OrderStatusHistory(
                order=order,
                sequence=0,
                previous_status=None,
                new_status=OrderStatus.CREATED.value,
            )
        )
    return order_id, public_number, token


def _run_checkout(
    session_factory: sessionmaker[Session],
    *,
    public_number: str,
    token: str | None,
    request_key: UUID,
    stripe_client: CallbackStripeClient,
    current_user_id: UUID | None = None,
) -> CheckoutOutcome:
    with session_factory() as session:
        return checkout_order(
            session,
            public_order_number=public_number,
            access_token=token,
            request_idempotency_key=request_key,
            payment_provider=PaymentProvider.STRIPE_TEST,
            stripe_client=stripe_client,  # type: ignore[arg-type]
            stripe_success_url_template=SUCCESS_TEMPLATE,
            stripe_cancel_url_template=CANCEL_TEMPLATE,
            current_user_id=current_user_id,
            now_provider=lambda: NOW,
        )


def _store_user(session_factory: sessionmaker[Session]) -> UUID:
    with session_factory.begin() as session:
        user = User(
            email=f"checkout-concurrency-{uuid4().hex}@example.com",
            password_hash="synthetic-checkout-concurrency-password-hash",
            role=UserRole.CUSTOMER,
            is_active=True,
        )
        session.add(user)
        session.flush()
        return user.id


def _application(
    session_factory: sessionmaker[Session],
    *,
    stripe_client: CallbackStripeClient,
    user_token_service: UserTokenService,
):
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
            stripe_secret_key=None,
            stripe_success_url=SUCCESS_TEMPLATE,
            stripe_cancel_url=CANCEL_TEMPLATE,
        ),
        session_factory=session_factory,
        checkout_rate_limiter=FixedWindowRateLimiter(
            limit=10,
            window_seconds=60,
        ),
        stripe_checkout_client=stripe_client,  # type: ignore[arg-type]
        checkout_now_provider=lambda: NOW,
        user_token_service=user_token_service,
    )


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


def test_checkout_wins_before_provider_call_and_real_cancellation_is_blocked(
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
                payment_provider=PaymentProvider.STRIPE_TEST,
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
        assert _run_cancellation(checkout_session_factory, public_number) is False
        release_provider.set()
        outcome = future.result(timeout=10)

    assert observed_no_transaction == [True]
    assert outcome.created is True
    assert outcome.response.checkout_url == CHECKOUT_RESULT.checkout_url
    with checkout_session_factory() as session:
        stored_order = session.get(Order, order_id)
        stored_payment = session.scalar(select(Payment))
    assert stored_order is not None
    assert stored_order.status == OrderStatus.CREATED.value
    assert stored_payment is not None
    assert stored_payment.status == PaymentStatus.PENDING.value


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
    assert payment.provider == "stripe_test"
    assert payment.provider_idempotency_key == build_stripe_idempotency_key(payment.id)
    assert payment.provider_session_id == CHECKOUT_RESULT.session_id
    assert len(fake.requests) == 2
    assert {request.stripe_idempotency_key for request in fake.requests} == {
        payment.provider_idempotency_key
    }
    assert {outcome.created for outcome in outcomes} == {True, False}
    assert len({outcome.response.checkout_url for outcome in outcomes}) == 1


@pytest.mark.parametrize("capability_identity", ["anonymous", "non-owner"])
def test_owned_order_same_key_owner_and_capability_callers_converge(
    checkout_session_factory: sessionmaker[Session],
    capability_identity: str,
) -> None:
    """Converge owner and independent capability traffic on one attempt."""
    owner_id = _store_user(checkout_session_factory)
    capability_user_id = (
        _store_user(checkout_session_factory)
        if capability_identity == "non-owner"
        else None
    )
    order_id, public_number, token = _store_order(
        checkout_session_factory,
        customer_user_id=owner_id,
    )
    request_key = uuid4()
    provider_barrier = Barrier(2)

    def provider_callback(_request: StripeCheckoutRequest) -> CheckoutSessionResult:
        provider_barrier.wait(timeout=10)
        return CHECKOUT_RESULT

    fake = CallbackStripeClient(provider_callback)

    def owner_worker() -> CheckoutOutcome:
        return _run_checkout(
            checkout_session_factory,
            public_number=public_number,
            token=None,
            request_key=request_key,
            stripe_client=fake,
            current_user_id=owner_id,
        )

    def capability_worker() -> CheckoutOutcome:
        return _run_checkout(
            checkout_session_factory,
            public_number=public_number,
            token=token,
            request_key=request_key,
            stripe_client=fake,
            current_user_id=capability_user_id,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(owner_worker), executor.submit(capability_worker)]
        outcomes = [future.result(timeout=15) for future in futures]

    with checkout_session_factory() as session:
        order = session.get(Order, order_id)
        payments = list(session.scalars(select(Payment)).all())
        history = list(
            session.scalars(
                select(OrderStatusHistory)
                .where(OrderStatusHistory.order_id == order_id)
                .order_by(OrderStatusHistory.sequence.asc())
            ).all()
        )
    assert order is not None
    assert order.customer_user_id == owner_id
    assert order.status == OrderStatus.CREATED.value
    assert [(entry.sequence, entry.new_status) for entry in history] == [
        (0, OrderStatus.CREATED.value)
    ]
    assert len(payments) == 1
    payment = payments[0]
    assert payment.request_idempotency_key == request_key
    assert payment.provider_idempotency_key == build_stripe_idempotency_key(payment.id)
    assert len(fake.requests) == 2
    assert {request.stripe_idempotency_key for request in fake.requests} == {
        payment.provider_idempotency_key
    }
    assert {outcome.created for outcome in outcomes} == {True, False}
    assert {outcome.response.checkout_url for outcome in outcomes} == {
        CHECKOUT_RESULT.checkout_url
    }


def test_denied_identities_have_no_side_effects_during_owner_checkout(
    checkout_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Reject 404 and 401 contenders before Payment or provider side effects."""
    owner_id = _store_user(checkout_session_factory)
    non_owner_id = _store_user(checkout_session_factory)
    order_id, public_number, token = _store_order(
        checkout_session_factory,
        customer_user_id=owner_id,
    )
    owner_key = uuid4()
    non_owner_key = uuid4()
    invalid_auth_key = uuid4()
    provider_entered = Event()
    release_provider = Event()

    def provider_callback(_request: StripeCheckoutRequest) -> CheckoutSessionResult:
        provider_entered.set()
        assert release_provider.wait(timeout=10)
        return CHECKOUT_RESULT

    fake = CallbackStripeClient(provider_callback)
    user_token_service = UserTokenService(
        SYNTHETIC_SECRET,
        now_provider=lambda: NOW,
    )
    application = _application(
        checkout_session_factory,
        stripe_client=fake,
        user_token_service=user_token_service,
    )

    def owner_worker() -> CheckoutOutcome:
        return _run_checkout(
            checkout_session_factory,
            public_number=public_number,
            token=None,
            request_key=owner_key,
            stripe_client=fake,
            current_user_id=owner_id,
        )

    denied_statements: list[str] = []

    def capture_denied_sql(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        denied_statements.append(" ".join(statement.lower().split()))

    with ThreadPoolExecutor(max_workers=1) as executor:
        owner_future = executor.submit(owner_worker)
        assert provider_entered.wait(timeout=10)
        event.listen(
            test_database_engine,
            "before_cursor_execute",
            capture_denied_sql,
        )
        try:
            with TestClient(
                application,
                client=("198.51.100.40", 50000),
            ) as test_client:
                path = CHECKOUT_PATH.format(public_order_number=public_number)
                non_owner_response = test_client.post(
                    path,
                    headers={
                        "Authorization": (
                            "Bearer "
                            + user_token_service.create_access_token(non_owner_id)
                        ),
                        "Idempotency-Key": str(non_owner_key),
                    },
                )
                invalid_auth_response = test_client.post(
                    path,
                    headers={
                        "Authorization": "Bearer malformed-token",
                        "X-Order-Access-Token": token,
                        "Idempotency-Key": str(invalid_auth_key),
                    },
                )
        finally:
            event.remove(
                test_database_engine,
                "before_cursor_execute",
                capture_denied_sql,
            )
            release_provider.set()
        owner_outcome = owner_future.result(timeout=15)

    assert owner_outcome.created is True
    assert non_owner_response.status_code == 404
    assert non_owner_response.json() == {"detail": "Order not found"}
    assert invalid_auth_response.status_code == 401
    assert invalid_auth_response.json() == {
        "detail": "Invalid authentication credentials"
    }
    assert invalid_auth_response.headers["WWW-Authenticate"] == "Bearer"
    assert not any(" from payments " in statement for statement in denied_statements)
    assert not any(
        statement.startswith(("insert", "update", "delete"))
        for statement in denied_statements
    )

    with checkout_session_factory() as session:
        order = session.get(Order, order_id)
        payments = list(session.scalars(select(Payment)).all())
        history = list(
            session.scalars(
                select(OrderStatusHistory)
                .where(OrderStatusHistory.order_id == order_id)
                .order_by(OrderStatusHistory.sequence.asc())
            ).all()
        )
    assert order is not None
    assert order.customer_user_id == owner_id
    assert order.status == OrderStatus.CREATED.value
    assert [(entry.sequence, entry.new_status) for entry in history] == [
        (0, OrderStatus.CREATED.value)
    ]
    assert len(payments) == 1
    assert payments[0].request_idempotency_key == owner_key
    assert {payments[0].request_idempotency_key}.isdisjoint(
        {non_owner_key, invalid_auth_key}
    )
    assert len(fake.requests) == 1


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
    assert payment.provider_session_id == CHECKOUT_RESULT.session_id
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
def test_real_cancellation_uses_the_same_order_payment_lock_protocol(
    checkout_session_factory: sessionmaker[Session],
    status: PaymentStatus,
    expected: bool,
) -> None:
    """Apply D-016 under the same D-017 Order-to-Payment locking order."""
    order_id, public_number, _ = _store_order(checkout_session_factory)
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
                provider="stripe_test",
                provider_idempotency_key=build_stripe_idempotency_key(payment_id),
                succeeded_at=NOW if status is PaymentStatus.SUCCEEDED else None,
            )
        )
    assert _run_cancellation(checkout_session_factory, public_number) is expected


def test_cancellation_wins_order_lock_and_checkout_cannot_create_payment(
    checkout_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Serialize cancellation before Checkout Phase 1 without a deadlock."""
    order_id, public_number, token = _store_order(checkout_session_factory)
    thread_role = local()
    cancellation_locked = Event()
    release_cancellation = Event()
    checkout_attempted = Event()

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
            getattr(thread_role, "value", None) == "checkout"
            and " from orders " in normalized
            and "for update" in normalized
        ):
            checkout_attempted.set()

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
            getattr(thread_role, "value", None) == "cancellation"
            and " from orders " in normalized
            and "for update" in normalized
        ):
            cancellation_locked.set()
            assert release_cancellation.wait(timeout=10)

    fake = CallbackStripeClient(lambda _request: CHECKOUT_RESULT)

    def cancel_worker() -> bool:
        thread_role.value = "cancellation"
        return _run_cancellation(checkout_session_factory, public_number)

    def checkout_worker() -> CheckoutOutcome:
        thread_role.value = "checkout"
        return _run_checkout(
            checkout_session_factory,
            public_number=public_number,
            token=token,
            request_key=uuid4(),
            stripe_client=fake,
        )

    event.listen(test_database_engine, "before_cursor_execute", before_cursor_execute)
    event.listen(test_database_engine, "after_cursor_execute", after_cursor_execute)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            cancellation = executor.submit(cancel_worker)
            assert cancellation_locked.wait(timeout=10)
            checkout = executor.submit(checkout_worker)
            assert checkout_attempted.wait(timeout=10)
            release_cancellation.set()
            assert cancellation.result(timeout=10) is True
            with pytest.raises(OrderNotPayableError):
                checkout.result(timeout=10)
    finally:
        release_cancellation.set()
        event.remove(
            test_database_engine, "before_cursor_execute", before_cursor_execute
        )
        event.remove(test_database_engine, "after_cursor_execute", after_cursor_execute)

    with checkout_session_factory() as session:
        stored_order = session.get(Order, order_id)
        payments = list(session.scalars(select(Payment)).all())
        history = list(
            session.scalars(
                select(OrderStatusHistory)
                .where(OrderStatusHistory.order_id == order_id)
                .order_by(OrderStatusHistory.sequence.asc())
            ).all()
        )
    assert stored_order is not None
    assert stored_order.status == OrderStatus.CANCELLED.value
    assert payments == []
    assert [entry.sequence for entry in history] == [0, 1]
    assert fake.requests == []


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
