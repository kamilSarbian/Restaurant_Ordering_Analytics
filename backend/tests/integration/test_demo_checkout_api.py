"""Integration tests for the public synchronous demo checkout API."""

from __future__ import annotations

import re
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
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
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.origins import OrderDataOrigin
from app.orders.statuses import OrderStatus
from app.payments import demo_checkout
from app.payments.models import Payment, StripeEvent
from app.payments.providers import PaymentProvider
from app.payments.statuses import PaymentStatus
from app.payments.stripe_checkout import build_stripe_idempotency_key

pytestmark = pytest.mark.integration

NOW = datetime(2026, 9, 29, 12, tzinfo=UTC)
CHECKOUT_PATH = "/api/v1/orders/{public_order_number}/checkout-session"
SYNTHETIC_SECRET = "s" * 32
GOLDEN_SUCCEEDED_ID = UUID("00000000-0000-4000-8000-00000000000b")
GOLDEN_FAILED_ID = UUID("00000000-0000-4000-8000-000000000095")
GOLDEN_EXPIRED_ID = UUID("00000000-0000-4000-8000-000000000040")
DATA_WRITING_SQL_VERBS = ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "MERGE")
DATA_WRITING_CTE_PATTERN = re.compile(
    rf"(?:\bAS\s*(?:(?:NOT\s+)?MATERIALIZED\s*)?\(\s*|\)\s*)"
    rf"(?:{'|'.join(DATA_WRITING_SQL_VERBS)})\b"
)


class BombStripeClient:
    """Fail if synchronous demo checkout crosses the Stripe boundary."""

    def __init__(self) -> None:
        self.requests: list[object] = []

    def create_checkout_session(self, request: object) -> None:
        """Record and reject an unexpected Stripe checkout call."""
        self.requests.append(request)
        raise AssertionError("Demo checkout must not call Stripe")


@pytest.fixture(autouse=True)
def empty_order_tables(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep demo checkout tests isolated in the approved test database."""
    _clear_order_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_order_tables(test_database_engine)


@pytest.fixture
def api_session_factory(test_database_engine: Engine) -> sessionmaker[Session]:
    """Provide request sessions bound to the isolated PostgreSQL database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def user_token_service() -> UserTokenService:
    """Provide deterministic canonical bearer tokens for demo checkout tests."""
    return UserTokenService(SYNTHETIC_SECRET, now_provider=lambda: NOW)


def _clear_order_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(delete(StripeEvent))
        connection.execute(delete(Payment))
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))
        connection.execute(delete(User))


def _store_user(session_factory: sessionmaker[Session]) -> UUID:
    with session_factory.begin() as session:
        user = User(
            email=f"demo-checkout-{uuid4().hex}@example.com",
            password_hash="synthetic-demo-checkout-password-hash",
            role=UserRole.CUSTOMER,
            is_active=True,
        )
        session.add(user)
        session.flush()
        return user.id


def _store_order(
    session_factory: sessionmaker[Session],
    *,
    data_origin: OrderDataOrigin = OrderDataOrigin.PORTFOLIO_RUNTIME,
    customer_user_id: UUID | None = None,
    total_amount: int = 53700,
    currency: str = "NOK",
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
                customer_user_id=customer_user_id,
                order_type="takeaway",
                table_id=None,
                table_number_snapshot=None,
                status=OrderStatus.CREATED.value,
                data_origin=data_origin.value,
                currency=currency,
                subtotal_amount=total_amount,
                total_amount=total_amount,
            )
        )
    return order_id, public_number, token


def _store_payment(
    session_factory: sessionmaker[Session],
    *,
    order_id: UUID,
    request_key: UUID,
    status: PaymentStatus,
    provider: PaymentProvider = PaymentProvider.DEMO,
    amount: int = 53700,
    currency: str = "NOK",
    complete_session_tuple: bool = False,
) -> UUID:
    payment_id = uuid4()
    provider_key = (
        demo_checkout.build_demo_provider_idempotency_key(payment_id)
        if provider is PaymentProvider.DEMO
        else build_stripe_idempotency_key(payment_id)
    )
    payment = Payment(
        id=payment_id,
        order_id=order_id,
        status=status.value,
        amount=amount,
        currency=currency,
        request_idempotency_key=request_key,
        provider=provider.value,
        provider_idempotency_key=provider_key,
        succeeded_at=NOW if status is PaymentStatus.SUCCEEDED else None,
    )
    if complete_session_tuple:
        payment.provider_session_id = f"cs_corrupt_{payment_id.hex}"
        payment.provider_checkout_url = "https://checkout.example.test/corrupt"
        payment.provider_checkout_expires_at = NOW + timedelta(hours=1)
    with session_factory.begin() as session:
        session.add(payment)
    return payment_id


def _application(
    session_factory: sessionmaker[Session],
    *,
    stripe_client: BombStripeClient,
    user_token_service: UserTokenService | None = None,
) -> FastAPI:
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
            stripe_secret_key=None,
            portfolio_demo_mode=True,
            payment_provider=PaymentProvider.DEMO.value,
        ),
        session_factory=session_factory,
        checkout_rate_limiter=FixedWindowRateLimiter(
            limit=100,
            window_seconds=60,
        ),
        stripe_checkout_client=stripe_client,  # type: ignore[arg-type]
        checkout_now_provider=lambda: NOW,
        user_token_service=user_token_service,
    )


def _headers(
    token: str | None,
    request_key: UUID,
    *,
    authorization: str | None = None,
) -> dict[str, str]:
    headers = {"Idempotency-Key": str(request_key)}
    if token is not None:
        headers["X-Order-Access-Token"] = token
    if authorization is not None:
        headers["Authorization"] = authorization
    return headers


def _post(
    client: TestClient,
    public_number: str,
    token: str | None,
    request_key: UUID,
    *,
    authorization: str | None = None,
):
    return client.post(
        CHECKOUT_PATH.format(public_order_number=public_number),
        headers=_headers(token, request_key, authorization=authorization),
    )


def _bearer(token: str) -> str:
    return f"Bearer {token}"


def _install_payment_ids(
    monkeypatch: pytest.MonkeyPatch,
    *payment_ids: UUID,
) -> None:
    remaining_ids = iter(payment_ids)
    original_checkout = demo_checkout.checkout_demo_order

    def next_payment_id() -> UUID:
        try:
            return next(remaining_ids)
        except StopIteration:
            raise AssertionError(
                "Demo checkout generated an unexpected Payment"
            ) from None

    def checkout_with_fixed_id(session: Session, **kwargs: object):
        return original_checkout(
            session,
            **kwargs,
            payment_id_provider=next_payment_id,
        )

    monkeypatch.setattr(demo_checkout, "checkout_demo_order", checkout_with_fixed_id)


def _checkout_state_snapshot(
    engine: Engine,
) -> tuple[tuple[tuple[object, ...], ...], ...]:
    tables = (
        User.__table__,
        Order.__table__,
        OrderItem.__table__,
        OrderStatusHistory.__table__,
        Payment.__table__,
        StripeEvent.__table__,
    )
    with engine.connect() as connection:
        return tuple(
            tuple(
                tuple(row)
                for row in connection.execute(
                    select(table).order_by(*tuple(table.primary_key.columns))
                )
            )
            for table in tables
        )


def _is_data_writing_statement(statement: str) -> bool:
    normalized = " ".join(statement.upper().split())
    if any(
        normalized == verb or normalized.startswith(f"{verb} ")
        for verb in DATA_WRITING_SQL_VERBS
    ):
        return True
    if not normalized.startswith(("WITH ", "WITH RECURSIVE ")):
        return False
    return DATA_WRITING_CTE_PATTERN.search(normalized) is not None


def _post_with_statement_capture(
    engine: Engine,
    client: TestClient,
    public_number: str,
    token: str | None,
    request_key: UUID,
    *,
    authorization: str | None = None,
):
    statements: list[str] = []

    def capture_statement(*args: object) -> None:
        statements.append(str(args[2]))

    event.listen(engine, "before_cursor_execute", capture_statement)
    try:
        response = _post(
            client,
            public_number,
            token,
            request_key,
            authorization=authorization,
        )
    finally:
        event.remove(engine, "before_cursor_execute", capture_statement)
    return response, statements


@pytest.mark.parametrize(
    ("payment_id", "expected_status"),
    [
        (GOLDEN_SUCCEEDED_ID, PaymentStatus.SUCCEEDED),
        (GOLDEN_FAILED_ID, PaymentStatus.FAILED),
        (GOLDEN_EXPIRED_ID, PaymentStatus.EXPIRED),
    ],
)
def test_demo_checkout_persists_each_terminal_golden_outcome(
    api_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    payment_id: UUID,
    expected_status: PaymentStatus,
) -> None:
    """Return 201 and persist the trusted order money for every demo outcome."""
    _, public_number, token = _store_order(
        api_session_factory,
        total_amount=41825,
        currency="SEK",
    )
    request_key = uuid4()
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch, payment_id)

    with TestClient(_application(api_session_factory, stripe_client=stripe)) as client:
        response = _post(client, public_number, token, request_key)

    assert response.status_code == 201
    assert response.json() == {
        "public_order_number": public_number,
        "payment_status": expected_status.value,
        "checkout_url": None,
        "expires_at": None,
    }
    with api_session_factory() as session:
        payment = session.scalar(select(Payment))
        stripe_events = list(session.scalars(select(StripeEvent)).all())
    assert payment is not None
    assert payment.id == payment_id
    assert payment.request_idempotency_key == request_key
    assert payment.provider == PaymentProvider.DEMO.value
    assert payment.provider_idempotency_key == (
        demo_checkout.build_demo_provider_idempotency_key(payment_id)
    )
    assert (payment.amount, payment.currency) == (41825, "SEK")
    assert payment.status == expected_status.value
    assert payment.succeeded_at == (
        NOW if expected_status is PaymentStatus.SUCCEEDED else None
    )
    assert payment.provider_session_id is None
    assert payment.provider_checkout_url is None
    assert payment.provider_checkout_expires_at is None
    assert stripe_events == []
    assert stripe.requests == []


def test_same_key_replay_after_order_acceptance_is_200_and_zero_dml(
    test_database_engine: Engine,
    api_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Replay stored terminal data after status change without hashing or DML."""
    order_id, public_number, token = _store_order(api_session_factory)
    request_key = uuid4()
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch, GOLDEN_SUCCEEDED_ID)
    application = _application(api_session_factory, stripe_client=stripe)

    with TestClient(application) as client:
        first = _post(client, public_number, token, request_key)
        assert first.status_code == 201
        with api_session_factory.begin() as session:
            order = session.get(Order, order_id)
            assert order is not None
            order.status = OrderStatus.ACCEPTED.value
        state_before_replay = _checkout_state_snapshot(test_database_engine)

        def reject_recomputed_outcome(_payment_id: UUID) -> PaymentStatus:
            raise AssertionError("Terminal replay must not recompute the demo outcome")

        monkeypatch.setattr(
            demo_checkout,
            "select_demo_outcome",
            reject_recomputed_outcome,
        )
        replay, statements = _post_with_statement_capture(
            test_database_engine,
            client,
            public_number,
            token,
            request_key,
        )

    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert not any(_is_data_writing_statement(item) for item in statements)
    assert _checkout_state_snapshot(test_database_engine) == state_before_replay
    assert stripe.requests == []


@pytest.mark.parametrize(
    ("first_payment_id", "first_status"),
    [
        (GOLDEN_FAILED_ID, PaymentStatus.FAILED),
        (GOLDEN_EXPIRED_ID, PaymentStatus.EXPIRED),
    ],
)
def test_new_key_retries_failed_or_expired_demo_attempt(
    api_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    first_payment_id: UUID,
    first_status: PaymentStatus,
) -> None:
    """Allow a distinct key after a non-success terminal demo attempt."""
    _, public_number, token = _store_order(api_session_factory)
    first_key = uuid4()
    second_key = uuid4()
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch, first_payment_id, GOLDEN_SUCCEEDED_ID)

    with TestClient(_application(api_session_factory, stripe_client=stripe)) as client:
        first = _post(client, public_number, token, first_key)
        second = _post(client, public_number, token, second_key)

    assert first.status_code == second.status_code == 201
    assert first.json()["payment_status"] == first_status.value
    assert second.json()["payment_status"] == PaymentStatus.SUCCEEDED.value
    with api_session_factory() as session:
        payments = list(
            session.scalars(
                select(Payment).order_by(Payment.created_at, Payment.id)
            ).all()
        )
    assert len(payments) == 2
    assert {payment.request_idempotency_key for payment in payments} == {
        first_key,
        second_key,
    }
    assert {payment.status for payment in payments} == {
        first_status.value,
        PaymentStatus.SUCCEEDED.value,
    }
    assert stripe.requests == []


def test_new_key_after_demo_success_is_409_without_another_payment(
    api_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject a different key after success before generating another Payment ID."""
    _, public_number, token = _store_order(api_session_factory)
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch, GOLDEN_SUCCEEDED_ID)

    with TestClient(_application(api_session_factory, stripe_client=stripe)) as client:
        first = _post(client, public_number, token, uuid4())
        conflict = _post(client, public_number, token, uuid4())

    assert first.status_code == 201
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": "Order is already paid"}
    with api_session_factory() as session:
        assert len(session.scalars(select(Payment)).all()) == 1
    assert stripe.requests == []


def test_owner_and_capability_can_create_demo_payments(
    api_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Preserve canonical owner and guest-capability access in demo mode."""
    owner_id = _store_user(api_session_factory)
    _, owned_number, _ = _store_order(
        api_session_factory,
        customer_user_id=owner_id,
    )
    _, capability_number, capability_token = _store_order(api_session_factory)
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch, GOLDEN_FAILED_ID, GOLDEN_EXPIRED_ID)
    application = _application(
        api_session_factory,
        stripe_client=stripe,
        user_token_service=user_token_service,
    )

    with TestClient(application) as client:
        owner_response = _post(
            client,
            owned_number,
            None,
            uuid4(),
            authorization=_bearer(user_token_service.create_access_token(owner_id)),
        )
        capability_response = _post(
            client,
            capability_number,
            capability_token,
            uuid4(),
        )

    assert owner_response.status_code == capability_response.status_code == 201
    assert owner_response.json()["payment_status"] == PaymentStatus.FAILED.value
    assert capability_response.json()["payment_status"] == PaymentStatus.EXPIRED.value
    with api_session_factory() as session:
        assert len(session.scalars(select(Payment)).all()) == 2
    assert stripe.requests == []


def test_privacy_and_invalid_present_bearer_precede_demo_checkout(
    api_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Return privacy-safe 404s and never fall back from an invalid bearer."""
    owner_id = _store_user(api_session_factory)
    other_id = _store_user(api_session_factory)
    _, public_number, token = _store_order(
        api_session_factory,
        customer_user_id=owner_id,
    )
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch)
    application = _application(
        api_session_factory,
        stripe_client=stripe,
        user_token_service=user_token_service,
    )

    with TestClient(application) as client:
        wrong_capability = _post(client, public_number, "wrong-token", uuid4())
        non_owner = _post(
            client,
            public_number,
            None,
            uuid4(),
            authorization=_bearer(user_token_service.create_access_token(other_id)),
        )
        invalid_bearer = _post(
            client,
            public_number,
            token,
            uuid4(),
            authorization="Bearer invalid-present-token",
        )

    assert [wrong_capability.status_code, non_owner.status_code] == [404, 404]
    assert wrong_capability.json() == non_owner.json() == {"detail": "Order not found"}
    assert invalid_bearer.status_code == 401
    assert invalid_bearer.json() == {"detail": "Invalid authentication credentials"}
    with api_session_factory() as session:
        assert session.scalar(select(Payment)) is None
    assert stripe.requests == []


@pytest.mark.parametrize(
    ("data_origin", "provider_override"),
    [
        (OrderDataOrigin.LIVE, PaymentProvider.DEMO.value),
        (OrderDataOrigin.PORTFOLIO_SEED, PaymentProvider.DEMO.value),
        (OrderDataOrigin.PORTFOLIO_RUNTIME, "unsupported"),
    ],
)
def test_invalid_demo_boundary_is_503_without_dml(
    test_database_engine: Engine,
    api_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    data_origin: OrderDataOrigin,
    provider_override: str,
) -> None:
    """Fail closed for invalid origin/provider pairs without mutating state."""
    _, public_number, token = _store_order(
        api_session_factory,
        data_origin=data_origin,
    )
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch)
    application = _application(api_session_factory, stripe_client=stripe)
    application.state.payment_provider = provider_override
    state_before = _checkout_state_snapshot(test_database_engine)

    with TestClient(application) as client:
        response, statements = _post_with_statement_capture(
            test_database_engine,
            client,
            public_number,
            token,
            uuid4(),
        )

    assert response.status_code == 503
    assert response.json() == {"detail": "Payment service unavailable"}
    assert not any(_is_data_writing_statement(item) for item in statements)
    assert _checkout_state_snapshot(test_database_engine) == state_before
    assert stripe.requests == []


@pytest.mark.parametrize(
    "unsafe_state",
    ["cross-provider", "session-tuple", "pending", "amount-drift", "currency-drift"],
)
def test_unsafe_persisted_demo_state_requires_reconciliation_without_dml(
    test_database_engine: Engine,
    api_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    unsafe_state: str,
) -> None:
    """Reject unsafe persisted attempts without silently repairing them."""
    order_id, public_number, token = _store_order(api_session_factory)
    request_key = uuid4()
    _store_payment(
        api_session_factory,
        order_id=order_id,
        request_key=request_key,
        status=(
            PaymentStatus.PENDING if unsafe_state == "pending" else PaymentStatus.FAILED
        ),
        provider=(
            PaymentProvider.STRIPE_TEST
            if unsafe_state == "cross-provider"
            else PaymentProvider.DEMO
        ),
        amount=53701 if unsafe_state == "amount-drift" else 53700,
        currency="SEK" if unsafe_state == "currency-drift" else "NOK",
        complete_session_tuple=unsafe_state == "session-tuple",
    )
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch)
    application = _application(api_session_factory, stripe_client=stripe)
    state_before = _checkout_state_snapshot(test_database_engine)

    with TestClient(application) as client:
        response, statements = _post_with_statement_capture(
            test_database_engine,
            client,
            public_number,
            token,
            request_key,
        )

    assert response.status_code == 503
    assert response.json() == {"detail": "Payment session requires reconciliation"}
    assert not any(_is_data_writing_statement(item) for item in statements)
    assert _checkout_state_snapshot(test_database_engine) == state_before
    assert stripe.requests == []


def test_outcome_selector_failure_rolls_back_the_pending_demo_attempt(
    test_database_engine: Engine,
    api_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rollback the first flush if deterministic outcome selection fails."""
    _, public_number, token = _store_order(api_session_factory)
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch, GOLDEN_SUCCEEDED_ID)
    application = _application(api_session_factory, stripe_client=stripe)
    state_before = _checkout_state_snapshot(test_database_engine)

    def fail_selection(_payment_id: UUID) -> PaymentStatus:
        raise RuntimeError("synthetic-selector-failure")

    monkeypatch.setattr(demo_checkout, "select_demo_outcome", fail_selection)
    with TestClient(application) as client:
        with pytest.raises(RuntimeError, match="synthetic-selector-failure"):
            _post(client, public_number, token, uuid4())

    assert _checkout_state_snapshot(test_database_engine) == state_before
    assert stripe.requests == []


def test_second_flush_failure_rolls_back_the_entire_demo_attempt(
    test_database_engine: Engine,
    api_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Rollback the pending insert when terminal-state persistence fails."""
    _, public_number, token = _store_order(api_session_factory)
    private_marker = "synthetic-private-second-flush-marker"
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch, GOLDEN_SUCCEEDED_ID)
    application = _application(api_session_factory, stripe_client=stripe)
    state_before = _checkout_state_snapshot(test_database_engine)

    def reject_terminal_update(
        _connection: object,
        _cursor: object,
        statement: str,
        parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        normalized = " ".join(statement.upper().split())
        if normalized.startswith("UPDATE PAYMENTS SET "):
            raise IntegrityError(
                statement,
                parameters,
                RuntimeError(private_marker),
            )

    event.listen(test_database_engine, "before_cursor_execute", reject_terminal_update)
    try:
        with TestClient(application) as client:
            response = _post(client, public_number, token, uuid4())
    finally:
        event.remove(
            test_database_engine,
            "before_cursor_execute",
            reject_terminal_update,
        )

    assert response.status_code == 503
    assert response.json() == {"detail": "Payment session requires reconciliation"}
    assert _checkout_state_snapshot(test_database_engine) == state_before
    assert private_marker not in response.text
    assert private_marker not in caplog.text
    assert stripe.requests == []
