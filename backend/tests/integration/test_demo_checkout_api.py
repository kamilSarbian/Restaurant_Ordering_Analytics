"""Integration tests for the public synchronous demo checkout API."""

from __future__ import annotations

import re
from collections.abc import Generator, Mapping
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.demo_admin import (
    DEMO_ADMIN_DISABLED_PASSWORD_HASH,
    DEMO_ADMIN_EMAIL,
    DEMO_ADMIN_ID,
)
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


def _store_demo_admin(session_factory: sessionmaker[Session]) -> UUID:
    with session_factory.begin() as session:
        session.add(
            User(
                id=DEMO_ADMIN_ID,
                email=DEMO_ADMIN_EMAIL,
                password_hash=DEMO_ADMIN_DISABLED_PASSWORD_HASH,
                role=UserRole.ADMIN,
                is_active=True,
            )
        )
    return DEMO_ADMIN_ID


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
    parameter_sets: list[object] = []

    def capture_statement(*args: object) -> None:
        statements.append(str(args[2]))
        parameter_sets.append(args[3])

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
    return response, statements, parameter_sets


def _assert_runtime_scoped_order_read(
    *,
    statement: str,
    parameters: object,
    public_number: str,
) -> None:
    """Prove the first Order query predicates both number and demo provenance."""
    compact = " ".join(statement.split())
    number_binds = re.findall(
        r"\borders\.public_order_number\s*=\s*%\(([A-Za-z_][A-Za-z0-9_]*)\)s",
        compact,
        flags=re.IGNORECASE,
    )
    origin_binds = re.findall(
        r"\borders\.data_origin\s*=\s*%\(([A-Za-z_][A-Za-z0-9_]*)\)s",
        compact,
        flags=re.IGNORECASE,
    )

    if len(number_binds) != 1 or len(origin_binds) != 1:
        raise AssertionError("Demo checkout Order read used an unsupported bind format")
    if not isinstance(parameters, Mapping):
        raise AssertionError("Demo checkout Order read did not bind named parameters")

    number_key = number_binds[0]
    origin_key = origin_binds[0]
    if number_key == origin_key:
        raise AssertionError("Demo checkout Order read reused an ambiguous bind")
    if number_key not in parameters or origin_key not in parameters:
        raise AssertionError("Demo checkout Order read omitted a required bind")
    if parameters[number_key] != public_number:
        raise AssertionError("Demo checkout Order read bound the wrong public number")
    if parameters[origin_key] != OrderDataOrigin.PORTFOLIO_RUNTIME.value:
        raise AssertionError("Demo checkout Order read bound the wrong origin")


def _captured_records_without_exact_probe(
    statements: list[str],
    parameter_sets: list[object],
) -> list[tuple[str, object]]:
    if len(statements) != len(parameter_sets):
        raise AssertionError("Demo checkout SQL capture lost statement parameters")
    return [
        (statement, parameters)
        for statement, parameters in zip(statements, parameter_sets, strict=True)
        if " ".join(statement.upper().split()) != "SELECT 1"
    ]


def _assert_anonymous_demo_denial_sql(
    *,
    statements: list[str],
    parameter_sets: list[object],
    public_number: str,
) -> None:
    """Require one isolated runtime-scoped Order read before anonymous denial."""
    records = _captured_records_without_exact_probe(statements, parameter_sets)
    if len(records) != 1:
        raise AssertionError("Anonymous demo checkout denial performed unexpected SQL")

    statement, parameters = records[0]
    normalized = " ".join(statement.upper().split())
    if (
        not normalized.startswith("SELECT ")
        or "FROM ORDERS" not in normalized
        or normalized.count(" FROM ") != 1
    ):
        raise AssertionError(
            "Anonymous demo checkout denial did not use one Order SELECT"
        )
    forbidden_markers = (
        " JOIN ",
        "ORDER_ITEMS",
        "ORDER_STATUS_HISTORY",
        "PAYMENTS",
        "STRIPE_EVENTS",
        "USERS",
    )
    if any(marker in normalized for marker in forbidden_markers):
        raise AssertionError(
            "Anonymous demo checkout denial performed a joined or child read"
        )
    _assert_runtime_scoped_order_read(
        statement=statement,
        parameters=parameters,
        public_number=public_number,
    )


def _assert_demo_identity_denial_sql(
    *,
    statements: list[str],
    parameter_sets: list[object],
    public_number: str,
) -> None:
    """Require one auth read and one scoped Order read before demo denial."""
    records = _captured_records_without_exact_probe(statements, parameter_sets)
    if any(_is_data_writing_statement(statement) for statement, _ in records):
        raise AssertionError("Demo checkout denial performed data-writing SQL")

    normalized_records = [
        (" ".join(statement.upper().split()), statement, parameters)
        for statement, parameters in records
    ]
    if any(
        not normalized.startswith("SELECT ") for normalized, _, _ in normalized_records
    ):
        raise AssertionError("Demo checkout denial performed unexpected non-SELECT SQL")
    if len(normalized_records) != 2:
        raise AssertionError("Demo checkout denial performed unexpected SQL")

    user_reads = [
        (statement, parameters)
        for normalized, statement, parameters in normalized_records
        if "FROM USERS" in normalized
    ]
    order_reads = [
        (statement, parameters)
        for normalized, statement, parameters in normalized_records
        if "FROM ORDERS" in normalized
    ]
    if len(user_reads) != 1:
        raise AssertionError("Demo checkout denial used an unexpected auth query count")
    if len(order_reads) != 1:
        raise AssertionError(
            "Demo checkout denial used an unexpected Order query count"
        )
    if "FROM USERS" not in normalized_records[0][0]:
        raise AssertionError(
            "Demo checkout denial did not authenticate before Order read"
        )
    if "FROM ORDERS" not in normalized_records[1][0]:
        raise AssertionError("Demo checkout denial did not stop after the Order read")
    forbidden_domain_tables = (
        "ORDER_ITEMS",
        "ORDER_STATUS_HISTORY",
        "PAYMENTS",
        "STRIPE_EVENTS",
    )
    if any(
        any(table_name in normalized for table_name in forbidden_domain_tables)
        for normalized, _, _ in normalized_records
    ):
        raise AssertionError("Demo checkout denial performed a child or Payment read")

    user_statement, user_parameters = user_reads[0]
    normalized_user_statement = " ".join(user_statement.upper().split())
    if "USERS.ID =" not in normalized_user_statement.partition(" WHERE ")[2]:
        raise AssertionError("Demo checkout auth read lacks its User-id predicate")
    if any(
        marker in normalized_user_statement
        for marker in ("COUNT(", "ORDER BY", "FOR UPDATE", " JOIN ")
    ):
        raise AssertionError("Demo checkout auth read was not canonical")
    if not isinstance(user_parameters, Mapping):
        raise AssertionError("Demo checkout auth read did not bind named parameters")
    if DEMO_ADMIN_ID not in user_parameters.values():
        raise AssertionError("Demo checkout auth read bound the wrong User")

    order_statement, order_parameters = order_reads[0]
    if "FOR UPDATE" not in " ".join(order_statement.upper().split()):
        raise AssertionError("Demo checkout denial Order read lost its row lock")
    _assert_runtime_scoped_order_read(
        statement=order_statement,
        parameters=order_parameters,
        public_number=public_number,
    )


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
        replay, statements, _ = _post_with_statement_capture(
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


def test_demo_checkout_is_capability_only_for_shared_identity_and_guest(
    test_database_engine: Engine,
    api_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Require capability for exact demo-admin and anonymous demo checkout."""
    demo_admin_id = _store_demo_admin(api_session_factory)
    _, legacy_owned_number, _ = _store_order(
        api_session_factory,
        customer_user_id=demo_admin_id,
    )
    order_id_a, runtime_number_a, runtime_token_a = _store_order(api_session_factory)
    order_id_b, runtime_number_b, runtime_token_b = _store_order(api_session_factory)
    guest_order_id, guest_number, guest_token = _store_order(api_session_factory)
    if hash_order_access_token(runtime_token_a) == hash_order_access_token(
        runtime_token_b
    ):
        raise AssertionError("Independent demo Orders received colliding capabilities")
    stripe = BombStripeClient()
    _install_payment_ids(
        monkeypatch,
        GOLDEN_FAILED_ID,
        GOLDEN_EXPIRED_ID,
        GOLDEN_SUCCEEDED_ID,
    )
    visitor_a_application = _application(
        api_session_factory,
        stripe_client=stripe,
        user_token_service=user_token_service,
    )
    visitor_b_application = _application(
        api_session_factory,
        stripe_client=stripe,
        user_token_service=user_token_service,
    )
    guest_application = _application(
        api_session_factory,
        stripe_client=stripe,
        user_token_service=user_token_service,
    )
    demo_auth = _bearer(user_token_service.create_access_token(demo_admin_id))
    state_before_denials = _checkout_state_snapshot(test_database_engine)

    with (
        TestClient(
            visitor_a_application,
            client=("198.51.100.20", 50000),
        ) as visitor_a,
        TestClient(
            visitor_b_application,
            client=("198.51.100.21", 50000),
        ) as visitor_b,
    ):
        owner_only_response, statements, parameter_sets = _post_with_statement_capture(
            test_database_engine,
            visitor_a,
            legacy_owned_number,
            None,
            uuid4(),
            authorization=demo_auth,
        )
        if owner_only_response.status_code != 404 or owner_only_response.json() != {
            "detail": "Order not found"
        }:
            raise AssertionError("Shared demo JWT unexpectedly gained owner authority")
        _assert_demo_identity_denial_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_number=legacy_owned_number,
        )

        visitor_a_cross, statements, parameter_sets = _post_with_statement_capture(
            test_database_engine,
            visitor_a,
            runtime_number_b,
            runtime_token_a,
            uuid4(),
            authorization=demo_auth,
        )
        if visitor_a_cross.status_code != 404 or visitor_a_cross.json() != {
            "detail": "Order not found"
        }:
            raise AssertionError("Visitor A cross-capability checkout denial changed")
        _assert_demo_identity_denial_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_number=runtime_number_b,
        )

        visitor_b_cross, statements, parameter_sets = _post_with_statement_capture(
            test_database_engine,
            visitor_b,
            runtime_number_a,
            runtime_token_b,
            uuid4(),
            authorization=demo_auth,
        )
        if visitor_b_cross.status_code != 404 or visitor_b_cross.json() != {
            "detail": "Order not found"
        }:
            raise AssertionError("Visitor B cross-capability checkout denial changed")
        _assert_demo_identity_denial_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_number=runtime_number_a,
        )

        if _checkout_state_snapshot(test_database_engine) != state_before_denials:
            raise AssertionError("Demo checkout denial changed persisted state")

        visitor_a_success = _post(
            visitor_a,
            runtime_number_a,
            runtime_token_a,
            uuid4(),
            authorization=demo_auth,
        )
        visitor_b_success = _post(
            visitor_b,
            runtime_number_b,
            runtime_token_b,
            uuid4(),
            authorization=demo_auth,
        )

    with TestClient(
        guest_application,
        client=("198.51.100.22", 50000),
    ) as guest_client:
        guest_capability_response = _post(
            guest_client,
            guest_number,
            guest_token,
            uuid4(),
        )

    if visitor_a_success.status_code != 201:
        raise AssertionError("Visitor A capability checkout failed")
    if visitor_a_success.json().get("public_order_number") != runtime_number_a:
        raise AssertionError("Visitor A checkout returned the wrong Order")
    if visitor_a_success.json().get("payment_status") != PaymentStatus.FAILED.value:
        raise AssertionError("Visitor A checkout returned an unexpected outcome")
    if visitor_b_success.status_code != 201:
        raise AssertionError("Visitor B capability checkout failed")
    if visitor_b_success.json().get("public_order_number") != runtime_number_b:
        raise AssertionError("Visitor B checkout returned the wrong Order")
    if visitor_b_success.json().get("payment_status") != PaymentStatus.EXPIRED.value:
        raise AssertionError("Visitor B checkout returned an unexpected outcome")
    if guest_capability_response.status_code != 201:
        raise AssertionError("Anonymous capability checkout failed")
    if guest_capability_response.json().get("public_order_number") != guest_number:
        raise AssertionError("Anonymous checkout returned the wrong Order")
    if (
        guest_capability_response.json().get("payment_status")
        != PaymentStatus.SUCCEEDED.value
    ):
        raise AssertionError("Anonymous checkout returned an unexpected outcome")
    with api_session_factory() as session:
        payments = list(session.scalars(select(Payment)).all())
        payment_order_ids = {payment.id: payment.order_id for payment in payments}
        runtime_owners = list(
            session.scalars(
                select(Order.customer_user_id).where(
                    Order.public_order_number.in_([runtime_number_a, runtime_number_b])
                )
            ).all()
        )
    if len(payments) != 3:
        raise AssertionError("Capability checkout persisted the wrong Payment count")
    if payment_order_ids != {
        GOLDEN_FAILED_ID: order_id_a,
        GOLDEN_EXPIRED_ID: order_id_b,
        GOLDEN_SUCCEEDED_ID: guest_order_id,
    }:
        raise AssertionError("Capability checkout persisted Payments for wrong Orders")
    if len(runtime_owners) != 2 or any(
        owner_id is not None for owner_id in runtime_owners
    ):
        raise AssertionError("Demo runtime Orders unexpectedly gained an owner")
    if stripe.requests:
        raise AssertionError("Demo checkout unexpectedly called Stripe")


def test_privacy_and_invalid_present_bearer_precede_demo_checkout(
    test_database_engine: Engine,
    api_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Separate capability privacy from actor and malformed-bearer denial."""
    demo_admin_id = _store_demo_admin(api_session_factory)
    other_id = _store_user(api_session_factory)
    _, public_number, token = _store_order(api_session_factory)
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch)
    application = _application(
        api_session_factory,
        stripe_client=stripe,
        user_token_service=user_token_service,
    )
    demo_auth = _bearer(user_token_service.create_access_token(demo_admin_id))
    state_before_denials = _checkout_state_snapshot(test_database_engine)

    with TestClient(application) as client:
        missing_capability, statements, parameter_sets = _post_with_statement_capture(
            test_database_engine,
            client,
            public_number,
            None,
            uuid4(),
            authorization=demo_auth,
        )
        if missing_capability.status_code != 404 or missing_capability.json() != {
            "detail": "Order not found"
        }:
            raise AssertionError("Missing demo capability privacy response changed")
        _assert_demo_identity_denial_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_number=public_number,
        )

        wrong_capability, statements, parameter_sets = _post_with_statement_capture(
            test_database_engine,
            client,
            public_number,
            "wrong-token",
            uuid4(),
            authorization=demo_auth,
        )
        if wrong_capability.status_code != 404 or wrong_capability.json() != {
            "detail": "Order not found"
        }:
            raise AssertionError("Wrong demo capability privacy response changed")
        _assert_demo_identity_denial_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_number=public_number,
        )

        wrong_actor = _post(
            client,
            public_number,
            token,
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

    if wrong_actor.status_code != 403 or wrong_actor.json() != {
        "detail": "Order access is not allowed"
    }:
        raise AssertionError("Reserved demo checkout actor denial changed")
    if invalid_bearer.status_code != 401 or invalid_bearer.json() != {
        "detail": "Invalid authentication credentials"
    }:
        raise AssertionError("Invalid bearer checkout denial changed")
    if _checkout_state_snapshot(test_database_engine) != state_before_denials:
        raise AssertionError("Demo checkout privacy denial changed persisted state")
    with api_session_factory() as session:
        if session.scalar(select(Payment)) is not None:
            raise AssertionError("Demo checkout privacy denial persisted a Payment")
    if stripe.requests:
        raise AssertionError("Demo checkout denial unexpectedly called Stripe")


@pytest.mark.parametrize(
    ("number_kind", "capability_kind"),
    [
        ("existing", "missing"),
        ("existing", "wrong"),
        ("unknown", "valid"),
    ],
)
def test_anonymous_demo_checkout_denials_stop_after_scoped_order_select(
    test_database_engine: Engine,
    api_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    number_kind: str,
    capability_kind: str,
) -> None:
    """Use one provenance-scoped Order read for every anonymous denial."""
    _, public_number, token = _store_order(api_session_factory)
    requested_number = (
        public_number if number_kind == "existing" else "ROA-ZZZZZZZZZZZZ"
    )
    presented_capability = {
        "valid": token,
        "wrong": "wrong-token",
        "missing": None,
    }[capability_kind]
    stripe = BombStripeClient()
    _install_payment_ids(monkeypatch)
    application = _application(api_session_factory, stripe_client=stripe)

    with TestClient(application) as client:
        response, statements, parameter_sets = _post_with_statement_capture(
            test_database_engine,
            client,
            requested_number,
            presented_capability,
            uuid4(),
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "Order not found"}
    _assert_anonymous_demo_denial_sql(
        statements=statements,
        parameter_sets=parameter_sets,
        public_number=requested_number,
    )
    assert not any(_is_data_writing_statement(statement) for statement in statements)
    assert stripe.requests == []


@pytest.mark.parametrize(
    (
        "data_origin",
        "provider_override",
        "expected_status",
        "expected_detail",
        "expected_order_reads",
    ),
    [
        (
            OrderDataOrigin.LIVE,
            PaymentProvider.DEMO.value,
            404,
            "Order not found",
            1,
        ),
        (
            OrderDataOrigin.PORTFOLIO_SEED,
            PaymentProvider.DEMO.value,
            404,
            "Order not found",
            1,
        ),
        (
            OrderDataOrigin.PORTFOLIO_RUNTIME,
            "unsupported",
            403,
            "Order access is not allowed",
            0,
        ),
    ],
)
def test_invalid_demo_boundary_fails_closed_without_payment_work(
    test_database_engine: Engine,
    api_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    data_origin: OrderDataOrigin,
    provider_override: str,
    expected_status: int,
    expected_detail: str,
    expected_order_reads: int,
) -> None:
    """Hide invalid provenance and reject invalid runtime before domain SQL."""
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
        response, statements, parameter_sets = _post_with_statement_capture(
            test_database_engine,
            client,
            public_number,
            token,
            uuid4(),
        )

    assert response.status_code == expected_status
    assert response.json() == {"detail": expected_detail}
    if expected_order_reads == 1:
        _assert_anonymous_demo_denial_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_number=public_number,
        )
    elif expected_order_reads == 0:
        if _captured_records_without_exact_probe(statements, parameter_sets):
            raise AssertionError("Invalid demo runtime performed unexpected SQL")
    else:
        raise AssertionError("Invalid demo boundary test expectation")
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
        response, statements, _ = _post_with_statement_capture(
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
