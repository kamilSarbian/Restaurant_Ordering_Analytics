"""PostgreSQL and HTTP tests for the private Stripe webhook runtime."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.main import create_app
from app.orders.access import generate_public_order_number
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.statuses import OrderStatus
from app.payments.models import Payment, StripeEvent
from app.payments.statuses import PaymentStatus
from app.payments.stripe_checkout import build_stripe_idempotency_key
from app.payments.stripe_webhook import (
    IgnoredStripeEvent,
    StripeWebhookEventType,
    StripeWebhookVerificationError,
    StripeWebhookVerifier,
    VerifiedStripeCheckoutEvent,
)

pytestmark = pytest.mark.integration

WEBHOOK_PATH = "/api/v1/stripe/webhook"
NOW = datetime(2026, 8, 8, 12, tzinfo=UTC)
TEST_SECRET = "synthetic-webhook-signing-value"


class StaticVerifier:
    """Return one predetermined verified event without provider access."""

    def __init__(
        self, verified_event: VerifiedStripeCheckoutEvent | IgnoredStripeEvent
    ):
        self.verified_event = verified_event
        self.calls: list[tuple[bytes, str]] = []

    def verify(
        self,
        payload: bytes,
        signature_header: str,
    ) -> VerifiedStripeCheckoutEvent | IgnoredStripeEvent:
        """Record untouched transport input and return the configured event."""
        self.calls.append((payload, signature_header))
        return self.verified_event


class RejectingVerifier:
    """Reject every request through the stable adapter exception."""

    def verify(
        self,
        payload: bytes,
        signature_header: str,
    ) -> VerifiedStripeCheckoutEvent | IgnoredStripeEvent:
        """Raise the public adapter boundary error without provider details."""
        raise StripeWebhookVerificationError("synthetic rejection")


@pytest.fixture(autouse=True)
def empty_order_tables(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep webhook API cases isolated in the approved PostgreSQL database."""
    _clear_order_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_order_tables(test_database_engine)


@pytest.fixture
def webhook_session_factory(test_database_engine: Engine) -> sessionmaker[Session]:
    """Provide request-scoped sessions backed by real PostgreSQL."""
    return sessionmaker[Session](
        bind=test_database_engine,
        expire_on_commit=False,
    )


def _clear_order_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(delete(StripeEvent))
        connection.execute(delete(Payment))
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))


def _store_order_and_payment(
    session_factory: sessionmaker[Session],
    *,
    payment_status: PaymentStatus = PaymentStatus.PENDING,
    stored_session_id: str | None = None,
) -> tuple[Order, Payment]:
    order = Order(
        id=uuid4(),
        public_order_number=generate_public_order_number(),
        order_access_token_hash="a" * 64,
        order_type="takeaway",
        table_id=None,
        table_number_snapshot=None,
        status=OrderStatus.CREATED.value,
        currency="NOK",
        subtotal_amount=53700,
        total_amount=53700,
    )
    payment_id = uuid4()
    payment = Payment(
        id=payment_id,
        order_id=order.id,
        status=payment_status.value,
        amount=53700,
        currency="NOK",
        request_idempotency_key=uuid4(),
        stripe_idempotency_key=build_stripe_idempotency_key(payment_id),
        stripe_checkout_session_id=stored_session_id,
        stripe_checkout_url=(
            "https://checkout.example.test/synthetic" if stored_session_id else None
        ),
        stripe_checkout_expires_at=(
            NOW + timedelta(hours=1) if stored_session_id else None
        ),
    )
    with session_factory.begin() as session:
        session.add_all([order, payment])
    return order, payment


def _verified_event(
    order: Order,
    payment: Payment,
    *,
    event_type: StripeWebhookEventType = StripeWebhookEventType.COMPLETED,
    stripe_event_id: str | None = None,
    session_status: str | None = "complete",
    payment_status: str | None = "paid",
    livemode: bool = False,
    **overrides: object,
) -> VerifiedStripeCheckoutEvent:
    values: dict[str, object] = {
        "stripe_event_id": stripe_event_id or f"evt_synthetic_{uuid4().hex}",
        "event_type": event_type,
        "livemode": livemode,
        "stripe_created_at": NOW,
        "stripe_checkout_session_id": "cs_synthetic_webhook",
        "session_status": session_status,
        "payment_status": payment_status,
        "mode": "payment",
        "amount_total": payment.amount,
        "currency": payment.currency.lower(),
        "metadata_payment_id": str(payment.id),
        "metadata_order_id": str(order.id),
        "metadata_public_order_number": order.public_order_number,
    }
    values.update(overrides)
    return VerifiedStripeCheckoutEvent(**values)  # type: ignore[arg-type]


def _application(
    session_factory: sessionmaker[Session],
    verifier: object | None,
):
    return create_app(
        settings=Settings(_env_file=None),
        session_factory=session_factory,
        stripe_webhook_verifier=verifier,  # type: ignore[arg-type]
    )


def _post(client: TestClient, *, payload: bytes = b"synthetic-body"):
    return client.post(
        WEBHOOK_PATH,
        content=payload,
        headers={"Stripe-Signature": "synthetic-signature"},
    )


def _stored_state(
    session_factory: sessionmaker[Session],
) -> tuple[list[Payment], list[StripeEvent]]:
    with session_factory() as session:
        payments = list(session.scalars(select(Payment)).all())
        receipts = list(session.scalars(select(StripeEvent)).all())
    return payments, receipts


def test_missing_verifier_returns_503_without_sql(
    webhook_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Keep missing webhook configuration outside the database boundary."""
    statements: list[str] = []

    def capture_sql(*args: object) -> None:
        statements.append(str(args[2]))

    event.listen(test_database_engine, "before_cursor_execute", capture_sql)
    try:
        with TestClient(_application(webhook_session_factory, None)) as client:
            response = _post(client)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_sql)
    assert response.status_code == 503
    assert response.json() == {"detail": "Webhook service unavailable"}
    assert statements == []


def test_missing_signature_returns_generic_400_without_verifier_or_sql(
    webhook_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Handle an absent signature manually without FastAPI validation details."""
    verifier = StaticVerifier(
        IgnoredStripeEvent("evt_ignored", "customer.created", False, NOW)
    )
    statements: list[str] = []

    def capture_sql(*args: object) -> None:
        statements.append(str(args[2]))

    event.listen(test_database_engine, "before_cursor_execute", capture_sql)
    try:
        with TestClient(_application(webhook_session_factory, verifier)) as client:
            response = client.post(WEBHOOK_PATH, content=b"body")
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_sql)
    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid webhook request"}
    assert verifier.calls == []
    assert statements == []


def test_invalid_signature_returns_generic_400_without_database_work(
    webhook_session_factory: sessionmaker[Session],
) -> None:
    """Do not expose adapter failures or create a receipt for invalid input."""
    with TestClient(
        _application(webhook_session_factory, RejectingVerifier())
    ) as client:
        response = _post(client)
    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid webhook request"}
    assert _stored_state(webhook_session_factory) == ([], [])


def _signature(payload: bytes, timestamp: int) -> str:
    signed = f"{timestamp}.{payload.decode('utf-8')}".encode()
    digest = hmac.new(TEST_SECRET.encode(), signed, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


def test_real_sdk_signed_out_of_scope_event_is_acknowledged_without_receipt(
    webhook_session_factory: sessionmaker[Session],
) -> None:
    """Exercise the installed signature verifier through the raw HTTP route."""
    payload = json.dumps(
        {
            "id": "evt_synthetic_out_of_scope",
            "object": "event",
            "created": int(NOW.timestamp()),
            "livemode": False,
            "type": "customer.created",
        },
        separators=(",", ":"),
    ).encode()
    timestamp = int(time.time())
    application = _application(
        webhook_session_factory,
        StripeWebhookVerifier(TEST_SECRET),
    )
    with TestClient(application) as client:
        response = client.post(
            WEBHOOK_PATH,
            content=payload,
            headers={"Stripe-Signature": _signature(payload, timestamp)},
        )
    assert response.status_code == 200
    assert response.json() == {"received": True}
    assert _stored_state(webhook_session_factory) == ([], [])


def test_route_forwards_exact_raw_body_and_signature(
    webhook_session_factory: sessionmaker[Session],
) -> None:
    """Pass request bytes directly to the injected verifier without JSON parsing."""
    payload = b'{ "spacing": "must remain exact" }'
    header = "t=123,v1=synthetic"
    verifier = StaticVerifier(
        IgnoredStripeEvent("evt_ignored", "customer.created", False, NOW)
    )
    with TestClient(_application(webhook_session_factory, verifier)) as client:
        response = client.post(
            WEBHOOK_PATH,
            content=payload,
            headers={"Stripe-Signature": header},
        )
    assert response.status_code == 200
    assert verifier.calls == [(payload, header)]


@pytest.mark.parametrize(
    (
        "initial_status",
        "event_type",
        "session_status",
        "provider_payment_status",
        "expected_status",
        "expected_result",
    ),
    [
        (
            PaymentStatus.PENDING,
            StripeWebhookEventType.COMPLETED,
            "complete",
            "paid",
            PaymentStatus.SUCCEEDED,
            "transitioned",
        ),
        (
            PaymentStatus.PENDING,
            StripeWebhookEventType.COMPLETED,
            "complete",
            "unpaid",
            PaymentStatus.PENDING,
            "awaiting_async_payment",
        ),
        (
            PaymentStatus.PENDING,
            StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED,
            "complete",
            "paid",
            PaymentStatus.SUCCEEDED,
            "transitioned",
        ),
        (
            PaymentStatus.PENDING,
            StripeWebhookEventType.ASYNC_PAYMENT_FAILED,
            "complete",
            "unpaid",
            PaymentStatus.FAILED,
            "transitioned",
        ),
        (
            PaymentStatus.PENDING,
            StripeWebhookEventType.EXPIRED,
            "expired",
            "unpaid",
            PaymentStatus.EXPIRED,
            "transitioned",
        ),
        (
            PaymentStatus.SUCCEEDED,
            StripeWebhookEventType.COMPLETED,
            "complete",
            "paid",
            PaymentStatus.SUCCEEDED,
            "already_applied",
        ),
        (
            PaymentStatus.FAILED,
            StripeWebhookEventType.ASYNC_PAYMENT_FAILED,
            "complete",
            "unpaid",
            PaymentStatus.FAILED,
            "already_applied",
        ),
        (
            PaymentStatus.EXPIRED,
            StripeWebhookEventType.EXPIRED,
            "expired",
            "unpaid",
            PaymentStatus.EXPIRED,
            "already_applied",
        ),
        (
            PaymentStatus.SUCCEEDED,
            StripeWebhookEventType.EXPIRED,
            "expired",
            "unpaid",
            PaymentStatus.SUCCEEDED,
            "reconciliation_required",
        ),
        (
            PaymentStatus.SUCCEEDED,
            StripeWebhookEventType.ASYNC_PAYMENT_FAILED,
            "complete",
            "unpaid",
            PaymentStatus.SUCCEEDED,
            "reconciliation_required",
        ),
        (
            PaymentStatus.FAILED,
            StripeWebhookEventType.COMPLETED,
            "complete",
            "paid",
            PaymentStatus.FAILED,
            "reconciliation_required",
        ),
        (
            PaymentStatus.FAILED,
            StripeWebhookEventType.EXPIRED,
            "expired",
            "unpaid",
            PaymentStatus.FAILED,
            "reconciliation_required",
        ),
        (
            PaymentStatus.EXPIRED,
            StripeWebhookEventType.COMPLETED,
            "complete",
            "paid",
            PaymentStatus.EXPIRED,
            "reconciliation_required",
        ),
        (
            PaymentStatus.EXPIRED,
            StripeWebhookEventType.ASYNC_PAYMENT_FAILED,
            "complete",
            "unpaid",
            PaymentStatus.EXPIRED,
            "reconciliation_required",
        ),
    ],
)
def test_transition_matrix_is_durable_and_never_overwrites_terminal_state(
    webhook_session_factory: sessionmaker[Session],
    initial_status: PaymentStatus,
    event_type: StripeWebhookEventType,
    session_status: str,
    provider_payment_status: str,
    expected_status: PaymentStatus,
    expected_result: str,
) -> None:
    """Apply the complete approved terminal-state matrix through HTTP."""
    order, payment = _store_order_and_payment(
        webhook_session_factory,
        payment_status=initial_status,
    )
    verified = _verified_event(
        order,
        payment,
        event_type=event_type,
        session_status=session_status,
        payment_status=provider_payment_status,
    )
    with TestClient(
        _application(webhook_session_factory, StaticVerifier(verified))
    ) as client:
        response = _post(client)
    payments, receipts = _stored_state(webhook_session_factory)
    assert response.status_code == 200
    assert response.json() == {"received": True}
    assert payments[0].status == expected_status.value
    assert len(receipts) == 1
    assert receipts[0].processing_result == expected_result
    assert receipts[0].payment_id == payment.id


@pytest.mark.parametrize(
    ("session_status", "provider_payment_status"),
    [
        ("complete", "no_payment_required"),
        ("complete", None),
        ("open", "paid"),
        (None, "paid"),
    ],
)
def test_completed_unexpected_provider_state_requires_reconciliation(
    webhook_session_factory: sessionmaker[Session],
    session_status: str | None,
    provider_payment_status: str | None,
) -> None:
    """Treat non-project completed states as durable reconciliation facts."""
    order, payment = _store_order_and_payment(webhook_session_factory)
    verified = _verified_event(
        order,
        payment,
        session_status=session_status,
        payment_status=provider_payment_status,
    )
    with TestClient(
        _application(webhook_session_factory, StaticVerifier(verified))
    ) as client:
        assert _post(client).status_code == 200
    payments, receipts = _stored_state(webhook_session_factory)
    assert payments[0].status == PaymentStatus.PENDING.value
    assert receipts[0].processing_result == "reconciliation_required"


@pytest.mark.parametrize(
    ("case", "expected_payment_link"),
    [
        ("missing_payment_id", False),
        ("malformed_payment_id", False),
        ("unknown_payment_id", False),
        ("missing_order_id", False),
        ("malformed_order_id", False),
        ("unknown_order_id", False),
        ("public_number_mismatch", True),
        ("missing_public_number", True),
        ("session_id_mismatch", True),
        ("missing_mode", True),
        ("mode_mismatch", True),
        ("missing_amount", True),
        ("amount_mismatch", True),
        ("missing_currency", True),
        ("currency_mismatch", True),
    ],
)
def test_correlation_and_integrity_failures_create_reconciliation_receipts(
    webhook_session_factory: sessionmaker[Session],
    case: str,
    expected_payment_link: bool,
) -> None:
    """Persist signed business inconsistencies without changing Payment."""
    stored_session_id = "cs_stored" if case == "session_id_mismatch" else None
    order, payment = _store_order_and_payment(
        webhook_session_factory,
        stored_session_id=stored_session_id,
    )
    overrides: dict[str, object] = {}
    if case == "missing_payment_id":
        overrides["metadata_payment_id"] = None
    elif case == "malformed_payment_id":
        overrides["metadata_payment_id"] = "not-a-uuid"
    elif case == "unknown_payment_id":
        overrides["metadata_payment_id"] = str(uuid4())
    elif case == "missing_order_id":
        overrides["metadata_order_id"] = None
    elif case == "malformed_order_id":
        overrides["metadata_order_id"] = "not-a-uuid"
    elif case == "unknown_order_id":
        overrides["metadata_order_id"] = str(uuid4())
    elif case == "public_number_mismatch":
        overrides["metadata_public_order_number"] = "ROA-23456789ABCD"
    elif case == "missing_public_number":
        overrides["metadata_public_order_number"] = None
    elif case == "session_id_mismatch":
        overrides["stripe_checkout_session_id"] = "cs_different"
    elif case == "missing_mode":
        overrides["mode"] = None
    elif case == "mode_mismatch":
        overrides["mode"] = "subscription"
    elif case == "missing_amount":
        overrides["amount_total"] = None
    elif case == "amount_mismatch":
        overrides["amount_total"] = payment.amount + 1
    elif case == "missing_currency":
        overrides["currency"] = None
    elif case == "currency_mismatch":
        overrides["currency"] = "sek"

    verified = _verified_event(order, payment, **overrides)
    with TestClient(
        _application(webhook_session_factory, StaticVerifier(verified))
    ) as client:
        response = _post(client)
    payments, receipts = _stored_state(webhook_session_factory)
    assert response.status_code == 200
    assert payments[0].status == PaymentStatus.PENDING.value
    assert len(receipts) == 1
    assert receipts[0].processing_result == "reconciliation_required"
    assert (receipts[0].payment_id == payment.id) is expected_payment_link


def test_null_stored_session_correlates_through_verified_metadata(
    webhook_session_factory: sessionmaker[Session],
) -> None:
    """Permit a webhook to win before Checkout Phase 3 stores session fields."""
    order, payment = _store_order_and_payment(webhook_session_factory)
    verified = _verified_event(order, payment)
    with TestClient(
        _application(webhook_session_factory, StaticVerifier(verified))
    ) as client:
        assert _post(client).status_code == 200
    payments, receipts = _stored_state(webhook_session_factory)
    assert payments[0].status == PaymentStatus.SUCCEEDED.value
    assert payments[0].stripe_checkout_session_id is None
    assert receipts[0].processing_result == "transitioned"


def test_second_succeeded_attempt_is_reconciled_without_constraint_failure(
    webhook_session_factory: sessionmaker[Session],
) -> None:
    """Respect the one-succeeded-attempt invariant as a business conflict."""
    order, pending_payment = _store_order_and_payment(webhook_session_factory)
    succeeded_id = uuid4()
    with webhook_session_factory.begin() as session:
        session.add(
            Payment(
                id=succeeded_id,
                order_id=order.id,
                status=PaymentStatus.SUCCEEDED.value,
                amount=order.total_amount,
                currency=order.currency,
                request_idempotency_key=uuid4(),
                stripe_idempotency_key=build_stripe_idempotency_key(succeeded_id),
            )
        )
    verified = _verified_event(order, pending_payment)
    with TestClient(
        _application(webhook_session_factory, StaticVerifier(verified))
    ) as client:
        response = _post(client)
    payments, receipts = _stored_state(webhook_session_factory)
    statuses = {payment.id: payment.status for payment in payments}
    assert response.status_code == 200
    assert statuses[pending_payment.id] == PaymentStatus.PENDING.value
    assert statuses[succeeded_id] == PaymentStatus.SUCCEEDED.value
    assert receipts[0].processing_result == "reconciliation_required"


def test_sequential_duplicate_is_acknowledged_once(
    webhook_session_factory: sessionmaker[Session],
) -> None:
    """Make a repeated provider event a successful no-op after one receipt."""
    order, payment = _store_order_and_payment(webhook_session_factory)
    verified = _verified_event(order, payment, stripe_event_id="evt_sequential")
    application = _application(webhook_session_factory, StaticVerifier(verified))
    with TestClient(application) as client:
        first = _post(client)
        second = _post(client)
    payments, receipts = _stored_state(webhook_session_factory)
    assert first.status_code == second.status_code == 200
    assert payments[0].status == PaymentStatus.SUCCEEDED.value
    assert len(receipts) == 1


def test_livemode_is_persisted_without_environment_rejection(
    webhook_session_factory: sessionmaker[Session],
) -> None:
    """Preserve provider livemode without introducing deployment policy."""
    order, payment = _store_order_and_payment(webhook_session_factory)
    verified = _verified_event(order, payment, livemode=True)
    with TestClient(
        _application(webhook_session_factory, StaticVerifier(verified))
    ) as client:
        assert _post(client).status_code == 200
    _, receipts = _stored_state(webhook_session_factory)
    assert receipts[0].livemode is True


def test_database_failure_returns_500_and_rolls_back_transition_and_receipt(
    webhook_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Leave Stripe free to retry after an expected persistence failure."""
    order, payment = _store_order_and_payment(webhook_session_factory)
    verified = _verified_event(order, payment)

    def reject_receipt_insert(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().upper().startswith("INSERT INTO STRIPE_EVENTS"):
            raise SQLAlchemyError("synthetic persistence failure")

    event.listen(test_database_engine, "before_cursor_execute", reject_receipt_insert)
    try:
        with TestClient(
            _application(webhook_session_factory, StaticVerifier(verified))
        ) as client:
            response = _post(client)
    finally:
        event.remove(
            test_database_engine,
            "before_cursor_execute",
            reject_receipt_insert,
        )
    payments, receipts = _stored_state(webhook_session_factory)
    assert response.status_code == 500
    assert response.json() == {"detail": "Webhook processing failed"}
    assert payments[0].status == PaymentStatus.PENDING.value
    assert receipts == []


def test_webhook_route_is_hidden_while_existing_routes_remain_documented(
    webhook_session_factory: sessionmaker[Session],
) -> None:
    """Keep the machine endpoint out of the public OpenAPI contract."""
    with TestClient(_application(webhook_session_factory, None)) as client:
        document = client.get("/openapi.json").json()
    paths = document["paths"]
    assert WEBHOOK_PATH not in paths
    assert "/health" in paths
    assert "/api/v1/menu" in paths
    assert "/api/v1/orders/quote" in paths
    assert "/api/v1/orders" in paths
    assert "/api/v1/orders/{public_order_number}" in paths
    assert "/api/v1/orders/{public_order_number}/checkout-session" in paths
