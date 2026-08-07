"""Integration tests for the authenticated public checkout endpoint."""

from __future__ import annotations

from collections.abc import Callable, Generator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

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
from app.orders.statuses import OrderStatus
from app.payments.models import Payment
from app.payments.statuses import PaymentStatus
from app.payments.stripe_checkout import (
    CheckoutSessionResult,
    StripeCheckoutAmbiguousError,
    StripeCheckoutDefinitiveError,
    StripeCheckoutRequest,
    build_stripe_idempotency_key,
)

pytestmark = pytest.mark.integration

NOW = datetime(2026, 8, 7, 12, tzinfo=UTC)
SUCCESS_TEMPLATE = "https://restaurant.example.test/orders/{public_order_number}/ok"
CANCEL_TEMPLATE = "https://restaurant.example.test/orders/{public_order_number}/cancel"
CHECKOUT_URL = "https://checkout.example.test/session/example"
CHECKOUT_PATH = "/api/v1/orders/{public_order_number}/checkout-session"


class FakeClock:
    """Provide deterministic monotonic seconds for HTTP rate-limit tests."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        """Advance the deterministic monotonic clock."""
        self.now += seconds


class FakeStripeClient:
    """Record provider requests and return or raise a deterministic result."""

    def __init__(
        self,
        *,
        result: CheckoutSessionResult | None = None,
        error: Exception | None = None,
        callback: Callable[[StripeCheckoutRequest], None] | None = None,
    ) -> None:
        self.result = result or CheckoutSessionResult(
            session_id="cs_fake_example",
            checkout_url=CHECKOUT_URL,
            expires_at=NOW + timedelta(hours=1),
        )
        self.error = error
        self.callback = callback
        self.requests: list[StripeCheckoutRequest] = []

    def create_checkout_session(
        self,
        request: StripeCheckoutRequest,
    ) -> CheckoutSessionResult:
        """Return the configured fake result without network access."""
        self.requests.append(request)
        if self.callback is not None:
            self.callback(request)
        if self.error is not None:
            raise self.error
        return self.result


@pytest.fixture(autouse=True)
def empty_order_tables(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep checkout tests isolated within the approved test database."""
    _clear_order_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_order_tables(test_database_engine)


@pytest.fixture
def api_session_factory(test_database_engine: Engine) -> sessionmaker[Session]:
    """Provide request sessions bound to the isolated PostgreSQL database."""
    return create_session_factory(test_database_engine)


def _clear_order_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(delete(Payment))
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))


def _store_order(
    session_factory: sessionmaker[Session],
    *,
    status: OrderStatus = OrderStatus.CREATED,
    total_amount: int = 53700,
    currency: str = "NOK",
) -> tuple[UUID, str, str]:
    token = generate_order_access_token()
    order_id = uuid4()
    public_order_number = generate_public_order_number()
    order = Order(
        id=order_id,
        public_order_number=public_order_number,
        order_access_token_hash=hash_order_access_token(token),
        order_type="takeaway",
        table_id=None,
        table_number_snapshot=None,
        status=status.value,
        currency=currency,
        subtotal_amount=total_amount,
        total_amount=total_amount,
    )
    with session_factory.begin() as session:
        session.add(order)
    return order_id, public_order_number, token


def _store_payment(
    session_factory: sessionmaker[Session],
    *,
    order_id: UUID,
    request_key: UUID,
    status: PaymentStatus,
    created_at: datetime = NOW - timedelta(hours=1),
    complete: bool = False,
    expires_at: datetime | None = None,
) -> UUID:
    payment_id = uuid4()
    payment = Payment(
        id=payment_id,
        order_id=order_id,
        status=status.value,
        amount=53700,
        currency="NOK",
        request_idempotency_key=request_key,
        stripe_idempotency_key=build_stripe_idempotency_key(payment_id),
        created_at=created_at,
    )
    if complete:
        payment.stripe_checkout_session_id = "cs_stored_example"
        payment.stripe_checkout_url = CHECKOUT_URL
        payment.stripe_checkout_expires_at = expires_at or NOW + timedelta(hours=1)
    with session_factory.begin() as session:
        session.add(payment)
    return payment_id


def _application(
    session_factory: sessionmaker[Session],
    *,
    stripe_client: FakeStripeClient | None,
    limiter: FixedWindowRateLimiter | None = None,
    configured_urls: bool = True,
) -> FastAPI:
    settings = Settings(
        _env_file=None,
        database_url=None,
        stripe_secret_key=None,
        stripe_success_url=SUCCESS_TEMPLATE if configured_urls else None,
        stripe_cancel_url=CANCEL_TEMPLATE if configured_urls else None,
    )
    return create_app(
        settings=settings,
        session_factory=session_factory,
        checkout_rate_limiter=limiter,
        stripe_checkout_client=stripe_client,  # type: ignore[arg-type]
        checkout_now_provider=lambda: NOW,
    )


def _headers(token: str | None, request_key: UUID | str | None) -> dict[str, str]:
    headers: dict[str, str] = {}
    if token is not None:
        headers["X-Order-Access-Token"] = token
    if request_key is not None:
        headers["Idempotency-Key"] = str(request_key)
    return headers


def _post(
    client: TestClient,
    public_order_number: str,
    token: str | None,
    request_key: UUID | str | None,
):
    return client.post(
        CHECKOUT_PATH.format(public_order_number=public_order_number),
        headers=_headers(token, request_key),
    )


def test_new_checkout_uses_durable_money_and_persists_one_pending_attempt(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Create the exact public response from server-owned Order values."""
    order_id, public_number, token = _store_order(api_session_factory)
    request_key = uuid4()
    fake = FakeStripeClient()
    application = _application(api_session_factory, stripe_client=fake)

    with TestClient(application) as client:
        response = client.post(
            CHECKOUT_PATH.format(public_order_number=public_number),
            headers=_headers(token, request_key),
            json={"amount": 1, "currency": "USD"},
        )

    assert response.status_code == 201
    assert set(response.json()) == {
        "public_order_number",
        "payment_status",
        "checkout_url",
        "expires_at",
    }
    assert response.json()["public_order_number"] == public_number
    assert response.json()["payment_status"] == "pending"
    assert response.json()["checkout_url"] == CHECKOUT_URL
    assert "location" not in response.headers
    assert len(fake.requests) == 1
    provider_request = fake.requests[0]
    assert provider_request.amount == 53700
    assert provider_request.currency == "NOK"
    assert provider_request.order_id == order_id
    assert provider_request.success_url.endswith(f"/{public_number}/ok")

    with api_session_factory() as session:
        payments = session.scalars(select(Payment)).all()
    assert len(payments) == 1
    payment = payments[0]
    assert payment.amount == 53700
    assert payment.currency == "NOK"
    assert payment.request_idempotency_key == request_key
    assert payment.stripe_idempotency_key == build_stripe_idempotency_key(payment.id)
    assert payment.stripe_checkout_session_id == "cs_fake_example"
    assert payment.stripe_checkout_url == CHECKOUT_URL
    assert payment.stripe_checkout_expires_at == NOW + timedelta(hours=1)
    assert token not in repr(payment)


@pytest.mark.parametrize("access_case", ["unknown", "wrong", "missing", "malformed"])
def test_guest_access_failures_share_one_public_404(
    api_session_factory: sessionmaker[Session],
    access_case: str,
) -> None:
    """Hide whether the public number or guest token was invalid."""
    _, public_number, token = _store_order(api_session_factory)
    fake = FakeStripeClient()
    target_number = public_number
    target_token: str | None = token
    if access_case == "unknown":
        target_number = generate_public_order_number()
    elif access_case == "wrong":
        target_token = generate_order_access_token()
    elif access_case == "missing":
        target_token = None
    else:
        target_number = "not-a-public-number"

    with TestClient(_application(api_session_factory, stripe_client=fake)) as client:
        response = _post(client, target_number, target_token, uuid4())

    assert response.status_code == 404
    assert response.json() == {"detail": "Order not found"}
    assert fake.requests == []


@pytest.mark.parametrize(
    "request_key",
    [
        None,
        "not-a-uuid",
        "9a6a229e-b7ee-11f0-9f3a-0242ac120002",
        "F47AC10B-58CC-4372-A567-0E02B2C3D479",
    ],
)
def test_invalid_idempotency_key_precedes_sql_and_stripe(
    api_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    request_key: str | None,
) -> None:
    """Return 422 before database work, limiting, or provider access."""
    _, public_number, token = _store_order(api_session_factory)
    fake = FakeStripeClient()
    statements: list[str] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with TestClient(
            _application(api_session_factory, stripe_client=fake)
        ) as client:
            response = _post(client, public_number, token, request_key)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid Idempotency-Key"}
    assert statements == []
    assert fake.requests == []


@pytest.mark.parametrize(
    "order_status",
    [
        OrderStatus.ACCEPTED,
        OrderStatus.PREPARING,
        OrderStatus.READY,
        OrderStatus.COMPLETED,
        OrderStatus.CANCELLED,
    ],
)
def test_non_created_order_is_not_payable_before_payment_history(
    api_session_factory: sessionmaker[Session],
    order_status: OrderStatus,
) -> None:
    """Give fulfilment eligibility precedence over historical payment state."""
    order_id, public_number, token = _store_order(
        api_session_factory,
        status=order_status,
    )
    _store_payment(
        api_session_factory,
        order_id=order_id,
        request_key=uuid4(),
        status=PaymentStatus.SUCCEEDED,
    )
    fake = FakeStripeClient()
    with TestClient(_application(api_session_factory, stripe_client=fake)) as client:
        response = _post(client, public_number, token, uuid4())
    assert response.status_code == 409
    assert response.json() == {"detail": "Order is not payable"}
    assert fake.requests == []


def test_complete_future_pending_session_replays_without_configuration(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Return a stored future session without a Stripe client or URL templates."""
    order_id, public_number, token = _store_order(api_session_factory)
    request_key = uuid4()
    _store_payment(
        api_session_factory,
        order_id=order_id,
        request_key=request_key,
        status=PaymentStatus.PENDING,
        complete=True,
    )
    application = _application(
        api_session_factory,
        stripe_client=None,
        configured_urls=False,
    )
    with TestClient(application) as client:
        response = _post(client, public_number, token, request_key)
    assert response.status_code == 200
    assert response.json()["checkout_url"] == CHECKOUT_URL


def test_complete_time_expired_pending_requires_reconciliation(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Keep a locally time-expired complete pending session unchanged."""
    order_id, public_number, token = _store_order(api_session_factory)
    request_key = uuid4()
    payment_id = _store_payment(
        api_session_factory,
        order_id=order_id,
        request_key=request_key,
        status=PaymentStatus.PENDING,
        complete=True,
        expires_at=NOW,
    )
    fake = FakeStripeClient()
    with TestClient(_application(api_session_factory, stripe_client=fake)) as client:
        response = _post(client, public_number, token, request_key)
    assert response.status_code == 503
    assert response.json() == {"detail": "Payment session requires reconciliation"}
    assert fake.requests == []
    with api_session_factory() as session:
        assert session.get(Payment, payment_id).status == PaymentStatus.PENDING.value


@pytest.mark.parametrize(
    ("age", "expected_status", "provider_calls"),
    [
        (timedelta(hours=22, minutes=59, seconds=59), 200, 1),
        (timedelta(hours=23), 503, 0),
        (timedelta(hours=23, seconds=1), 503, 0),
    ],
)
def test_incomplete_pending_uses_the_exact_twenty_three_hour_boundary(
    api_session_factory: sessionmaker[Session],
    age: timedelta,
    expected_status: int,
    provider_calls: int,
) -> None:
    """Retry below 23 hours and reconcile at or above the boundary."""
    order_id, public_number, token = _store_order(api_session_factory)
    request_key = uuid4()
    payment_id = _store_payment(
        api_session_factory,
        order_id=order_id,
        request_key=request_key,
        status=PaymentStatus.PENDING,
        created_at=NOW - age,
    )
    fake = FakeStripeClient()
    with TestClient(_application(api_session_factory, stripe_client=fake)) as client:
        response = _post(client, public_number, token, request_key)
    assert response.status_code == expected_status
    assert len(fake.requests) == provider_calls
    with api_session_factory() as session:
        payment = session.get(Payment, payment_id)
        assert payment is not None
        assert payment.status == PaymentStatus.PENDING.value
        if provider_calls:
            assert fake.requests[0].stripe_idempotency_key == (
                payment.stripe_idempotency_key
            )
        else:
            assert payment.stripe_checkout_session_id is None


def test_different_key_is_blocked_by_an_active_pending_attempt(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Reject a new key without creating a second Payment or calling Stripe."""
    order_id, public_number, token = _store_order(api_session_factory)
    _store_payment(
        api_session_factory,
        order_id=order_id,
        request_key=uuid4(),
        status=PaymentStatus.PENDING,
    )
    fake = FakeStripeClient()
    with TestClient(_application(api_session_factory, stripe_client=fake)) as client:
        response = _post(client, public_number, token, uuid4())
    assert response.status_code == 409
    assert response.json() == {"detail": "Active payment attempt exists"}
    assert fake.requests == []


def test_any_succeeded_attempt_precedes_request_key_matching(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Reject checkout whenever the Order already has a succeeded attempt."""
    order_id, public_number, token = _store_order(api_session_factory)
    _store_payment(
        api_session_factory,
        order_id=order_id,
        request_key=uuid4(),
        status=PaymentStatus.SUCCEEDED,
    )
    fake = FakeStripeClient()
    with TestClient(_application(api_session_factory, stripe_client=fake)) as client:
        response = _post(client, public_number, token, uuid4())
    assert response.status_code == 409
    assert response.json() == {"detail": "Order is already paid"}
    assert fake.requests == []


@pytest.mark.parametrize(
    ("terminal_status", "same_status", "same_detail"),
    [
        (PaymentStatus.FAILED, 502, "Payment provider unavailable"),
        (PaymentStatus.EXPIRED, 409, "Payment attempt expired"),
    ],
)
def test_terminal_attempt_same_key_replays_error_and_new_key_allows_retry(
    api_session_factory: sessionmaker[Session],
    terminal_status: PaymentStatus,
    same_status: int,
    same_detail: str,
) -> None:
    """Keep terminal same-key semantics while allowing a different-key attempt."""
    order_id, public_number, token = _store_order(api_session_factory)
    old_key = uuid4()
    _store_payment(
        api_session_factory,
        order_id=order_id,
        request_key=old_key,
        status=terminal_status,
    )
    fake = FakeStripeClient()
    with TestClient(_application(api_session_factory, stripe_client=fake)) as client:
        same_response = _post(client, public_number, token, old_key)
        new_response = _post(client, public_number, token, uuid4())
    assert same_response.status_code == same_status
    assert same_response.json() == {"detail": same_detail}
    assert new_response.status_code == 201
    assert len(fake.requests) == 1


@pytest.mark.parametrize(
    ("provider_error", "expected_detail", "expected_payment_status"),
    [
        (
            StripeCheckoutDefinitiveError("rejected"),
            "Payment provider unavailable",
            PaymentStatus.FAILED,
        ),
        (
            StripeCheckoutAmbiguousError("unknown"),
            "Payment session outcome is unknown",
            PaymentStatus.PENDING,
        ),
    ],
)
def test_provider_failures_preserve_definitive_and_ambiguous_semantics(
    api_session_factory: sessionmaker[Session],
    provider_error: Exception,
    expected_detail: str,
    expected_payment_status: PaymentStatus,
) -> None:
    """Fail definitive attempts and leave ambiguous attempts pending."""
    _, public_number, token = _store_order(api_session_factory)
    fake = FakeStripeClient(error=provider_error)
    with TestClient(_application(api_session_factory, stripe_client=fake)) as client:
        response = _post(client, public_number, token, uuid4())
    assert response.status_code in {502, 503}
    assert response.json() == {"detail": expected_detail}
    with api_session_factory() as session:
        payment = session.scalar(select(Payment))
    assert payment is not None
    assert payment.status == expected_payment_status.value
    assert payment.stripe_checkout_session_id is None


def test_ambiguous_retry_recovers_the_same_payment_and_stripe_key(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Recover a lost Phase 3 by retrying the same durable provider operation."""
    _, public_number, token = _store_order(api_session_factory)
    request_key = uuid4()
    ambiguous = FakeStripeClient(error=StripeCheckoutAmbiguousError("unknown"))
    with TestClient(
        _application(api_session_factory, stripe_client=ambiguous)
    ) as client:
        first_response = _post(client, public_number, token, request_key)
    with api_session_factory() as session:
        original = session.scalar(select(Payment))
        assert original is not None
        original_payment_id = original.id
        original_stripe_key = original.stripe_idempotency_key

    recovery = FakeStripeClient()
    with TestClient(
        _application(api_session_factory, stripe_client=recovery)
    ) as client:
        retry_response = _post(client, public_number, token, request_key)

    assert first_response.status_code == 503
    assert retry_response.status_code == 200
    assert len(recovery.requests) == 1
    assert recovery.requests[0].payment_id == original_payment_id
    assert recovery.requests[0].stripe_idempotency_key == original_stripe_key
    with api_session_factory() as session:
        payments = session.scalars(select(Payment)).all()
    assert len(payments) == 1
    assert payments[0].stripe_checkout_session_id == "cs_fake_example"


@pytest.mark.parametrize("matching", [True, False])
def test_concurrent_provider_persistence_is_identical_or_requires_reconciliation(
    api_session_factory: sessionmaker[Session],
    matching: bool,
) -> None:
    """Never overwrite provider fields persisted after Phase 1."""
    _, public_number, token = _store_order(api_session_factory)
    provider_result = CheckoutSessionResult(
        session_id="cs_provider_result",
        checkout_url=CHECKOUT_URL,
        expires_at=NOW + timedelta(hours=1),
    )

    def persist_during_provider(request: StripeCheckoutRequest) -> None:
        with api_session_factory.begin() as session:
            payment = session.get(Payment, request.payment_id)
            assert payment is not None
            payment.stripe_checkout_session_id = (
                provider_result.session_id if matching else "cs_different_result"
            )
            payment.stripe_checkout_url = (
                provider_result.checkout_url
                if matching
                else "https://checkout.example.test/session/different"
            )
            payment.stripe_checkout_expires_at = provider_result.expires_at

    fake = FakeStripeClient(result=provider_result, callback=persist_during_provider)
    with TestClient(_application(api_session_factory, stripe_client=fake)) as client:
        response = _post(client, public_number, token, uuid4())
    assert response.status_code == (201 if matching else 503)
    if not matching:
        assert response.json() == {"detail": "Payment session requires reconciliation"}
    with api_session_factory() as session:
        payment = session.scalar(select(Payment))
    assert payment is not None
    assert payment.stripe_checkout_session_id == (
        "cs_provider_result" if matching else "cs_different_result"
    )


def test_new_attempt_requires_provider_configuration_before_insert(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Return service unavailable without leaving a new pending attempt."""
    _, public_number, token = _store_order(api_session_factory)
    application = _application(
        api_session_factory,
        stripe_client=None,
        configured_urls=False,
    )
    with TestClient(application) as client:
        response = _post(client, public_number, token, uuid4())
    assert response.status_code == 503
    assert response.json() == {"detail": "Payment service unavailable"}
    with api_session_factory() as session:
        assert session.scalar(select(Payment)) is None


def test_checkout_rate_limit_denial_runs_zero_sql_and_zero_stripe(
    api_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Apply direct-peer isolation, Retry-After, reset, and pre-SQL denial."""
    _, public_number, token = _store_order(api_session_factory)
    request_key = uuid4()
    fake = FakeStripeClient()
    clock = FakeClock()
    limiter = FixedWindowRateLimiter(clock=clock)
    application = _application(
        api_session_factory,
        stripe_client=fake,
        limiter=limiter,
    )
    path = CHECKOUT_PATH.format(public_order_number=public_number)

    with TestClient(application, client=("first-client", 50000)) as client:
        responses = [
            client.post(path, headers=_headers(token, request_key)) for _ in range(10)
        ]
        statements: list[str] = []

        def capture_statement(
            _connection: object,
            _cursor: object,
            statement: str,
            _parameters: object,
            _context: object,
            _executemany: bool,
        ) -> None:
            statements.append(statement)

        event.listen(test_database_engine, "before_cursor_execute", capture_statement)
        try:
            denied = client.post(
                path,
                headers={
                    **_headers(token, request_key),
                    "X-Forwarded-For": "second-client",
                },
            )
        finally:
            event.remove(
                test_database_engine,
                "before_cursor_execute",
                capture_statement,
            )
        clock.advance(60)
        reset_response = client.post(path, headers=_headers(token, request_key))

    with TestClient(application, client=("second-client", 50001)) as client:
        independent = client.post(path, headers=_headers(token, request_key))

    assert responses[0].status_code == 201
    assert all(response.status_code == 200 for response in responses[1:])
    assert denied.status_code == 429
    assert denied.json() == {"detail": "Too many checkout requests"}
    assert int(denied.headers["Retry-After"]) > 0
    assert statements == []
    assert len(fake.requests) == 1
    assert reset_response.status_code == 200
    assert independent.status_code == 200


def test_openapi_documents_the_complete_checkout_transport_contract(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Expose both success statuses, headers, errors, and no request body."""
    application = _application(api_session_factory, stripe_client=FakeStripeClient())
    with TestClient(application) as client:
        document = client.get("/openapi.json").json()
    operation = document["paths"][
        "/api/v1/orders/{public_order_number}/checkout-session"
    ]["post"]
    parameters = {parameter["name"] for parameter in operation["parameters"]}
    response_schema = operation["responses"]["201"]["content"]["application/json"][
        "schema"
    ]
    assert operation["tags"] == ["payments"]
    assert operation["summary"] == "Create a checkout session"
    assert "requestBody" not in operation
    assert {"public_order_number", "X-Order-Access-Token", "Idempotency-Key"} <= (
        parameters
    )
    assert {"200", "201", "404", "409", "422", "429", "502", "503"} <= set(
        operation["responses"]
    )
    assert response_schema["$ref"].endswith("/CheckoutSessionResponse")
    schema_text = str(document["components"]["schemas"]["CheckoutSessionResponse"])
    assert all(
        internal not in schema_text
        for internal in (
            "payment_id",
            "order_id",
            "stripe_checkout_session_id",
            "request_idempotency_key",
            "stripe_idempotency_key",
        )
    )
