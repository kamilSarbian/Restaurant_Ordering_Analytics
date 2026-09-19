"""PostgreSQL integration tests for administrator analytics overview."""

from __future__ import annotations

import uuid
from collections.abc import Generator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.service import UserTokenService
from app.categories.models import Category
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app
from app.menu.models import MenuItem
from app.orders.access import generate_public_order_number
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.statuses import OrderStatus
from app.payments.models import Payment, StripeEvent
from app.payments.providers import PaymentProvider
from app.payments.statuses import PaymentStatus
from app.payments.stripe_webhook import StripeWebhookEventType
from app.payments.webhook import WebhookProcessingOutcome
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration

OVERVIEW_PATH = "/api/v1/admin/analytics/overview"
PRODUCTS_PATH = "/api/v1/admin/analytics/products"
CATEGORIES_PATH = "/api/v1/admin/analytics/categories"
ORDER_TYPES_PATH = "/api/v1/admin/analytics/order-types"
SYNTHETIC_SECRET = "a" * 32
FIXED_NOW = datetime(2026, 8, 11, 12, tzinfo=UTC)
RANGE_START = datetime(2026, 3, 1, tzinfo=UTC)
RANGE_END = datetime(2026, 4, 1, tzinfo=UTC)


@dataclass(frozen=True)
class ReceiptSpec:
    """Describe one synthetic durable Stripe receipt."""

    event_type: StripeWebhookEventType
    processing_result: WebhookProcessingOutcome
    stripe_created_at: datetime


@dataclass(frozen=True)
class LineSpec:
    """Describe one immutable synthetic OrderItem snapshot."""

    menu_item_id: uuid.UUID
    item_name: str
    category_name: str
    quantity: int
    unit_price_amount: int


@dataclass(frozen=True)
class AnalyticsClient:
    """Carry an authenticated client and its isolated session factory."""

    client: TestClient
    token: str
    session_factory: sessionmaker[Session]

    @property
    def headers(self) -> dict[str, str]:
        """Return the synthetic administrator Bearer header."""
        return {"Authorization": f"Bearer {self.token}"}


@pytest.fixture(autouse=True)
def empty_analytics_tables(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep analytics tests isolated from all financial and identity rows."""
    _delete_analytics_rows(test_database_engine)
    try:
        yield
    finally:
        _delete_analytics_rows(test_database_engine)


@pytest.fixture
def analytics_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create sessions bound only to the isolated integration database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def token_service() -> UserTokenService:
    """Create a deterministic synthetic administrator token service."""
    return UserTokenService(SYNTHETIC_SECRET, now_provider=lambda: FIXED_NOW)


@pytest.fixture
def analytics_client(
    analytics_session_factory: sessionmaker[Session],
    token_service: UserTokenService,
) -> Generator[AnalyticsClient, None, None]:
    """Run the application with one active synthetic administrator."""
    admin_id = _store_admin(analytics_session_factory)
    application = _application(analytics_session_factory, token_service)
    with TestClient(application) as client:
        yield AnalyticsClient(
            client=client,
            token=token_service.create_access_token(admin_id),
            session_factory=analytics_session_factory,
        )


def _delete_analytics_rows(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(delete(StripeEvent))
        connection.execute(delete(Payment))
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))
        connection.execute(delete(RestaurantTable))
        connection.execute(delete(MenuItem))
        connection.execute(delete(Category))
        connection.execute(delete(User))


def _application(
    session_factory: sessionmaker[Session],
    token_service: UserTokenService | None,
):
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
        ),
        session_factory=session_factory,
        user_token_service=token_service,
    )


def _store_admin(
    session_factory: sessionmaker[Session],
    *,
    email: str = "analytics-admin@example.com",
    is_active: bool = True,
) -> uuid.UUID:
    with session_factory.begin() as session:
        admin = User(
            email=email,
            password_hash="synthetic-argon2id-hash",
            role=UserRole.SUPER_ADMIN,
            is_active=is_active,
        )
        session.add(admin)
        session.flush()
        return admin.id


def _store_payment(
    session_factory: sessionmaker[Session],
    *,
    amount: int,
    currency: str = "NOK",
    payment_status: PaymentStatus = PaymentStatus.SUCCEEDED,
    order_status: OrderStatus = OrderStatus.CREATED,
    receipts: tuple[ReceiptSpec, ...] = (),
    provider: PaymentProvider = PaymentProvider.STRIPE_TEST,
    succeeded_at: datetime | None = None,
    payment_updated_at: datetime | None = None,
    order_id: uuid.UUID | None = None,
) -> uuid.UUID:
    if payment_status is PaymentStatus.SUCCEEDED and succeeded_at is None:
        qualifying_times = tuple(
            receipt.stripe_created_at
            for receipt in receipts
            if receipt.processing_result is WebhookProcessingOutcome.TRANSITIONED
            and receipt.event_type
            in {
                StripeWebhookEventType.COMPLETED,
                StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED,
            }
        )
        if not qualifying_times:
            raise AssertionError("Succeeded analytics fixture requires succeeded_at")
        succeeded_at = min(qualifying_times)
    with session_factory.begin() as session:
        if order_id is None:
            order = _new_order(
                amount=amount,
                currency=currency,
                status=order_status,
            )
            session.add(order)
            session.flush()
        else:
            order = session.get(Order, order_id)
            if order is None:
                raise AssertionError("Synthetic analytics order does not exist")

        payment_id = uuid.uuid4()
        payment = Payment(
            id=payment_id,
            order_id=order.id,
            provider=provider.value,
            status=payment_status.value,
            amount=amount,
            currency=currency,
            request_idempotency_key=uuid.uuid4(),
            provider_idempotency_key=f"checkout-session:{payment_id}",
            succeeded_at=succeeded_at,
            created_at=RANGE_START - timedelta(days=20),
            updated_at=payment_updated_at or RANGE_START - timedelta(days=20),
        )
        session.add(payment)
        session.flush()

        for receipt in receipts:
            receipt_id = uuid.uuid4().hex
            session.add(
                StripeEvent(
                    stripe_event_id=f"evt_synthetic_{receipt_id}",
                    event_type=receipt.event_type.value,
                    livemode=False,
                    stripe_created_at=receipt.stripe_created_at,
                    stripe_checkout_session_id=f"cs_test_{receipt_id}",
                    payment_id=payment.id,
                    processing_result=receipt.processing_result.value,
                )
            )
        return order.id


def _store_unpaid_order(
    session_factory: sessionmaker[Session],
    *,
    amount: int = 100,
) -> uuid.UUID:
    with session_factory.begin() as session:
        order = _new_order(
            amount=amount,
            currency="NOK",
            status=OrderStatus.CREATED,
        )
        session.add(order)
        session.flush()
        return order.id


def _new_order(
    *,
    amount: int,
    currency: str,
    status: OrderStatus,
) -> Order:
    return Order(
        public_order_number=generate_public_order_number(),
        order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
        order_type="takeaway",
        status=status.value,
        currency=currency,
        subtotal_amount=amount,
        total_amount=amount,
        created_at=RANGE_START - timedelta(days=30),
        updated_at=RANGE_START - timedelta(days=30),
    )


def _params(
    *,
    start: datetime = RANGE_START,
    end: datetime = RANGE_END,
    currency: str | None = None,
) -> dict[str, str]:
    values = {"start": start.isoformat(), "end": end.isoformat()}
    if currency is not None:
        values["currency"] = currency
    return values


def _success_receipt(
    at: datetime,
    *,
    event_type: StripeWebhookEventType = StripeWebhookEventType.COMPLETED,
    outcome: WebhookProcessingOutcome = WebhookProcessingOutcome.TRANSITIONED,
) -> ReceiptSpec:
    return ReceiptSpec(event_type, outcome, at)


def _store_catalog_item(
    session_factory: sessionmaker[Session],
    *,
    item_name: str,
    category_name: str,
    price_amount: int = 100,
    item_id: uuid.UUID | None = None,
) -> tuple[uuid.UUID, uuid.UUID]:
    with session_factory.begin() as session:
        category = Category(name=category_name)
        item = MenuItem(
            id=item_id or uuid.uuid4(),
            category=category,
            name=item_name,
            price_amount=price_amount,
            currency="NOK",
        )
        session.add(item)
        session.flush()
        return item.id, category.id


def _store_paid_order_with_lines(
    session_factory: sessionmaker[Session],
    *,
    lines: tuple[LineSpec, ...],
    success_at: datetime,
    currency: str = "NOK",
    order_type: str = "takeaway",
    payment_amount: int | None = None,
    prior_attempts: bool = False,
    additional_receipt: bool = False,
    provider: PaymentProvider = PaymentProvider.STRIPE_TEST,
    persist_stripe_receipt: bool = True,
    order_status: OrderStatus = OrderStatus.CREATED,
) -> uuid.UUID:
    line_total = sum(line.quantity * line.unit_price_amount for line in lines)
    with session_factory.begin() as session:
        table = None
        if order_type == "dine_in":
            table = RestaurantTable(number=(uuid.uuid4().int % 1_000_000) + 1)
            session.add(table)
            session.flush()
        order = Order(
            public_order_number=generate_public_order_number(),
            order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
            order_type=order_type,
            table_id=table.id if table is not None else None,
            table_number_snapshot=table.number if table is not None else None,
            status=order_status.value,
            currency=currency,
            subtotal_amount=line_total,
            total_amount=line_total,
            created_at=RANGE_START - timedelta(days=100),
            updated_at=RANGE_START - timedelta(days=100),
        )
        session.add(order)
        session.flush()
        session.add_all(
            [
                OrderItem(
                    order_id=order.id,
                    menu_item_id=line.menu_item_id,
                    position=position,
                    category_name_snapshot=line.category_name,
                    name_snapshot=line.item_name,
                    quantity=line.quantity,
                    unit_price_amount=line.unit_price_amount,
                    unit_cost_amount=None,
                    tax_rate_bps_snapshot=None,
                    discount_amount_snapshot=0,
                    line_total_amount=line.quantity * line.unit_price_amount,
                )
                for position, line in enumerate(lines)
            ]
        )
        if prior_attempts:
            for status in (PaymentStatus.FAILED, PaymentStatus.EXPIRED):
                attempt_id = uuid.uuid4()
                session.add(
                    Payment(
                        id=attempt_id,
                        order_id=order.id,
                        provider=provider.value,
                        status=status.value,
                        amount=payment_amount or line_total,
                        currency=currency,
                        request_idempotency_key=uuid.uuid4(),
                        provider_idempotency_key=f"checkout-session:{attempt_id}",
                    )
                )
        payment_id = uuid.uuid4()
        session.add(
            Payment(
                id=payment_id,
                order_id=order.id,
                provider=provider.value,
                status=PaymentStatus.SUCCEEDED.value,
                amount=payment_amount or line_total,
                currency=currency,
                request_idempotency_key=uuid.uuid4(),
                provider_idempotency_key=f"checkout-session:{payment_id}",
                succeeded_at=success_at,
            )
        )
        session.flush()
        if persist_stripe_receipt:
            receipt_id = uuid.uuid4().hex
            session.add(
                StripeEvent(
                    stripe_event_id=f"evt_synthetic_{receipt_id}",
                    event_type=StripeWebhookEventType.COMPLETED.value,
                    livemode=False,
                    stripe_created_at=success_at,
                    stripe_checkout_session_id=f"cs_test_{receipt_id}",
                    payment_id=payment_id,
                    processing_result=WebhookProcessingOutcome.TRANSITIONED.value,
                )
            )
        if additional_receipt:
            extra_id = uuid.uuid4().hex
            session.add(
                StripeEvent(
                    stripe_event_id=f"evt_synthetic_{extra_id}",
                    event_type=StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED.value,
                    livemode=False,
                    stripe_created_at=success_at + timedelta(seconds=1),
                    stripe_checkout_session_id=f"cs_test_{extra_id}",
                    payment_id=payment_id,
                    processing_result=WebhookProcessingOutcome.ALREADY_APPLIED.value,
                )
            )
        return order.id


def test_overview_requires_active_admin_and_available_authentication(
    analytics_session_factory: sessionmaker[Session],
    token_service: UserTokenService,
) -> None:
    application = _application(analytics_session_factory, token_service)
    with TestClient(application) as client:
        missing = client.get(OVERVIEW_PATH, params=_params())
        malformed = client.get(
            OVERVIEW_PATH,
            params=_params(),
            headers={"Authorization": "Bearer malformed-token"},
        )
    for response in (missing, malformed):
        assert response.status_code == 401
        assert response.json() == {"detail": "Invalid authentication credentials"}
        assert response.headers["WWW-Authenticate"] == "Bearer"

    inactive_id = _store_admin(
        analytics_session_factory,
        email="inactive-analytics@example.com",
        is_active=False,
    )
    application = _application(analytics_session_factory, token_service)
    with TestClient(application) as client:
        inactive = client.get(
            OVERVIEW_PATH,
            params=_params(),
            headers={
                "Authorization": (
                    f"Bearer {token_service.create_access_token(inactive_id)}"
                )
            },
        )
    assert inactive.status_code == 401
    assert inactive.json() == {"detail": "Invalid authentication credentials"}

    application = _application(analytics_session_factory, None)
    with TestClient(application) as client:
        unavailable = client.get(
            OVERVIEW_PATH,
            params=_params(),
            headers={"Authorization": "Bearer synthetic-unavailable-token"},
        )
    assert unavailable.status_code == 503
    assert unavailable.json() == {"detail": "Authentication service unavailable"}


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"start": RANGE_START.isoformat()},
        {"end": RANGE_END.isoformat()},
        {"start": "2026-03-01T00:00:00", "end": RANGE_END.isoformat()},
        {"start": RANGE_START.isoformat(), "end": "2026-04-01T00:00:00"},
        _params(start=RANGE_END, end=RANGE_START),
        _params(start=RANGE_START, end=RANGE_START),
        _params(currency="nok"),
        _params(currency="NO"),
        _params(currency="NOKK"),
        _params(currency="NO!"),
        _params(currency="123"),
        {**_params(), "unexpected": "value"},
    ],
)
def test_overview_rejects_invalid_query_contract(
    analytics_client: AnalyticsClient,
    params: dict[str, str],
) -> None:
    response = analytics_client.client.get(
        OVERVIEW_PATH,
        params=params,
        headers=analytics_client.headers,
    )

    assert response.status_code == 422


def test_empty_overview_has_distinct_filtered_and_unfiltered_contracts(
    analytics_client: AnalyticsClient,
) -> None:
    unfiltered = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(),
        headers=analytics_client.headers,
    )
    filtered = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(currency="NOK"),
        headers=analytics_client.headers,
    )

    assert unfiltered.status_code == 200
    assert unfiltered.json()["range"] == {
        "start": "2026-03-01T01:00:00+01:00",
        "end": "2026-04-01T02:00:00+02:00",
        "timezone": "Europe/Oslo",
    }
    assert unfiltered.json()["currencies"] == []
    assert filtered.status_code == 200
    assert filtered.json()["currencies"] == [
        {
            "currency": "NOK",
            "collected_revenue_amount": 0,
            "succeeded_orders_count": 0,
            "average_order_value_amount": 0,
        }
    ]


def test_overview_groups_currencies_orders_them_and_rounds_half_up(
    analytics_client: AnalyticsClient,
) -> None:
    receipt_time = RANGE_START + timedelta(days=1)
    for amount, currency in ((2, "NOK"), (3, "NOK"), (7, "EUR")):
        _store_payment(
            analytics_client.session_factory,
            amount=amount,
            currency=currency,
            receipts=(_success_receipt(receipt_time),),
        )
    _store_unpaid_order(analytics_client.session_factory)
    for payment_status in (
        PaymentStatus.PENDING,
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
    ):
        _store_payment(
            analytics_client.session_factory,
            amount=101,
            payment_status=payment_status,
        )

    response = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(),
        headers=analytics_client.headers,
    )

    assert response.status_code == 200
    assert response.json()["currencies"] == [
        {
            "currency": "EUR",
            "collected_revenue_amount": 7,
            "succeeded_orders_count": 1,
            "average_order_value_amount": 7,
        },
        {
            "currency": "NOK",
            "collected_revenue_amount": 5,
            "succeeded_orders_count": 2,
            "average_order_value_amount": 3,
        },
    ]


def test_overview_counts_only_final_succeeded_attempt_for_one_order(
    analytics_client: AnalyticsClient,
) -> None:
    order_id = _store_payment(
        analytics_client.session_factory,
        amount=50,
        payment_status=PaymentStatus.FAILED,
    )
    _store_payment(
        analytics_client.session_factory,
        order_id=order_id,
        amount=50,
        payment_status=PaymentStatus.EXPIRED,
    )
    _store_payment(
        analytics_client.session_factory,
        order_id=order_id,
        amount=50,
        receipts=(_success_receipt(RANGE_START + timedelta(days=1)),),
    )

    response = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(currency="NOK"),
        headers=analytics_client.headers,
    )

    assert response.status_code == 200
    assert response.json()["currencies"] == [
        {
            "currency": "NOK",
            "collected_revenue_amount": 50,
            "succeeded_orders_count": 1,
            "average_order_value_amount": 50,
        }
    ]


def test_overview_counts_payment_once_with_additional_receipts(
    analytics_client: AnalyticsClient,
) -> None:
    at = RANGE_START + timedelta(days=1)
    _store_payment(
        analytics_client.session_factory,
        amount=41,
        receipts=(
            _success_receipt(at),
            _success_receipt(
                at + timedelta(seconds=1),
                event_type=StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED,
                outcome=WebhookProcessingOutcome.ALREADY_APPLIED,
            ),
        ),
    )

    response = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(currency="NOK"),
        headers=analytics_client.headers,
    )

    assert response.status_code == 200
    assert response.json()["currencies"] == [
        {
            "currency": "NOK",
            "collected_revenue_amount": 41,
            "succeeded_orders_count": 1,
            "average_order_value_amount": 41,
        }
    ]


def test_overview_uses_persisted_success_state_not_stripe_receipt_shape(
    analytics_client: AnalyticsClient,
) -> None:
    at = RANGE_START + timedelta(days=2)
    _store_payment(
        analytics_client.session_factory,
        amount=11,
        succeeded_at=at,
        receipts=(_success_receipt(at),),
    )
    _store_payment(
        analytics_client.session_factory,
        amount=13,
        succeeded_at=at,
        receipts=(
            _success_receipt(
                at,
                event_type=StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED,
            ),
        ),
    )
    _store_payment(analytics_client.session_factory, amount=17, succeeded_at=at)
    _store_payment(
        analytics_client.session_factory,
        amount=19,
        succeeded_at=at,
        receipts=(
            _success_receipt(
                at,
                outcome=WebhookProcessingOutcome.ALREADY_APPLIED,
            ),
        ),
    )
    _store_payment(
        analytics_client.session_factory,
        amount=23,
        succeeded_at=at,
        receipts=(
            _success_receipt(
                at,
                outcome=WebhookProcessingOutcome.AWAITING_ASYNC_PAYMENT,
            ),
        ),
    )
    _store_payment(
        analytics_client.session_factory,
        amount=29,
        succeeded_at=at,
        receipts=(
            _success_receipt(
                at,
                event_type=StripeWebhookEventType.ASYNC_PAYMENT_FAILED,
            ),
        ),
    )
    _store_payment(
        analytics_client.session_factory,
        amount=31,
        payment_status=PaymentStatus.FAILED,
        receipts=(_success_receipt(at),),
    )

    response = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(currency="NOK"),
        headers=analytics_client.headers,
    )

    assert response.status_code == 200
    assert response.json()["currencies"] == [
        {
            "currency": "NOK",
            "collected_revenue_amount": 112,
            "succeeded_orders_count": 6,
            "average_order_value_amount": 19,
        }
    ]


def test_overview_uses_persisted_success_time_and_half_open_boundaries(
    analytics_client: AnalyticsClient,
) -> None:
    _store_payment(
        analytics_client.session_factory,
        amount=10,
        succeeded_at=RANGE_START - timedelta(seconds=1),
        receipts=(
            _success_receipt(RANGE_START - timedelta(seconds=1)),
            _success_receipt(
                RANGE_START + timedelta(days=1),
                event_type=StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED,
            ),
        ),
    )
    _store_payment(
        analytics_client.session_factory,
        amount=20,
        succeeded_at=RANGE_START,
        receipts=(_success_receipt(RANGE_START),),
        payment_updated_at=RANGE_END + timedelta(days=100),
    )
    _store_payment(
        analytics_client.session_factory,
        amount=30,
        succeeded_at=RANGE_END - timedelta(microseconds=1),
        receipts=(_success_receipt(RANGE_END - timedelta(microseconds=1)),),
    )
    _store_payment(
        analytics_client.session_factory,
        amount=40,
        succeeded_at=RANGE_END,
        receipts=(_success_receipt(RANGE_END),),
    )

    response = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(currency="NOK"),
        headers=analytics_client.headers,
    )

    assert response.status_code == 200
    assert response.json()["currencies"] == [
        {
            "currency": "NOK",
            "collected_revenue_amount": 50,
            "succeeded_orders_count": 2,
            "average_order_value_amount": 25,
        }
    ]


def test_overview_counts_all_paid_fulfilment_statuses_without_order_filter(
    analytics_client: AnalyticsClient,
) -> None:
    statuses = (
        OrderStatus.CREATED,
        OrderStatus.ACCEPTED,
        OrderStatus.PREPARING,
        OrderStatus.READY,
        OrderStatus.COMPLETED,
    )
    for status in statuses:
        _store_payment(
            analytics_client.session_factory,
            amount=10,
            order_status=status,
            receipts=(_success_receipt(RANGE_START + timedelta(days=3)),),
        )

    response = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(currency="NOK"),
        headers=analytics_client.headers,
    )

    assert response.status_code == 200
    assert response.json()["currencies"][0] == {
        "currency": "NOK",
        "collected_revenue_amount": 50,
        "succeeded_orders_count": 5,
        "average_order_value_amount": 10,
    }


def test_overview_filters_one_currency_without_combined_total(
    analytics_client: AnalyticsClient,
) -> None:
    at = RANGE_START + timedelta(days=4)
    _store_payment(
        analytics_client.session_factory,
        amount=100,
        currency="NOK",
        receipts=(_success_receipt(at),),
    )
    _store_payment(
        analytics_client.session_factory,
        amount=200,
        currency="EUR",
        receipts=(_success_receipt(at),),
    )

    response = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(currency="NOK"),
        headers=analytics_client.headers,
    )
    eur_response = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(currency="EUR"),
        headers=analytics_client.headers,
    )

    assert response.status_code == 200
    assert response.json()["currencies"] == [
        {
            "currency": "NOK",
            "collected_revenue_amount": 100,
            "succeeded_orders_count": 1,
            "average_order_value_amount": 100,
        }
    ]
    assert eur_response.status_code == 200
    assert eur_response.json()["currencies"] == [
        {
            "currency": "EUR",
            "collected_revenue_amount": 200,
            "succeeded_orders_count": 1,
            "average_order_value_amount": 200,
        }
    ]


def test_overview_converts_range_to_oslo_with_dst_aware_offsets(
    analytics_client: AnalyticsClient,
) -> None:
    response = analytics_client.client.get(
        OVERVIEW_PATH,
        params=_params(
            start=datetime(2026, 1, 1, tzinfo=UTC),
            end=datetime(2026, 7, 1, tzinfo=UTC),
        ),
        headers=analytics_client.headers,
    )

    assert response.status_code == 200
    assert response.json()["range"] == {
        "start": "2026-01-01T01:00:00+01:00",
        "end": "2026-07-01T02:00:00+02:00",
        "timezone": "Europe/Oslo",
    }


def test_valid_http_request_executes_one_analytics_select_and_no_dml(
    analytics_client: AnalyticsClient,
    test_database_engine: Engine,
) -> None:
    _store_payment(
        analytics_client.session_factory,
        amount=100,
        receipts=(_success_receipt(RANGE_START + timedelta(days=5)),),
    )
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
        response = analytics_client.client.get(
            OVERVIEW_PATH,
            params=_params(),
            headers=analytics_client.headers,
        )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    assert response.status_code == 200
    analytics_selects = [
        statement
        for statement in statements
        if "qualified_succeeded_payments" in statement
    ]
    assert len(analytics_selects) == 1
    normalized = [statement.lstrip().lower() for statement in statements]
    assert all(
        not statement.startswith(("insert", "update", "delete"))
        for statement in normalized
    )
    assert " join orders " not in analytics_selects[0].lower()
    assert "stripe_events" not in analytics_selects[0].lower()
    assert "payments.succeeded_at" in analytics_selects[0].lower()


def test_breakdown_routes_require_admin_and_validate_shared_queries(
    analytics_client: AnalyticsClient,
) -> None:
    for path in (PRODUCTS_PATH, CATEGORIES_PATH, ORDER_TYPES_PATH):
        missing = analytics_client.client.get(path, params=_params())
        assert missing.status_code == 401
        valid = analytics_client.client.get(
            path,
            params=_params(),
            headers=analytics_client.headers,
        )
        assert valid.status_code == 200
        assert valid.json()["items"] == []

        invalid_currency = analytics_client.client.get(
            path,
            params=_params(currency="nok"),
            headers=analytics_client.headers,
        )
        assert invalid_currency.status_code == 422

    for path in (PRODUCTS_PATH, CATEGORIES_PATH):
        for limit in (0, 101):
            response = analytics_client.client.get(
                path,
                params={**_params(), "limit": str(limit)},
                headers=analytics_client.headers,
            )
            assert response.status_code == 422
    assert (
        analytics_client.client.get(
            ORDER_TYPES_PATH,
            params={**_params(), "limit": "2"},
            headers=analytics_client.headers,
        ).status_code
        == 422
    )


def test_breakdown_routes_share_representative_auth_failures(
    analytics_session_factory: sessionmaker[Session],
    token_service: UserTokenService,
) -> None:
    application = _application(analytics_session_factory, token_service)
    with TestClient(application) as client:
        malformed = client.get(
            PRODUCTS_PATH,
            params=_params(),
            headers={"Authorization": "Bearer malformed-token"},
        )
    assert malformed.status_code == 401

    inactive_id = _store_admin(
        analytics_session_factory,
        email="inactive-breakdown@example.com",
        is_active=False,
    )
    with TestClient(application) as client:
        inactive = client.get(
            CATEGORIES_PATH,
            params=_params(),
            headers={
                "Authorization": (
                    f"Bearer {token_service.create_access_token(inactive_id)}"
                )
            },
        )
    assert inactive.status_code == 401

    with TestClient(_application(analytics_session_factory, None)) as client:
        unavailable = client.get(
            ORDER_TYPES_PATH,
            params=_params(),
            headers={"Authorization": "Bearer synthetic-unavailable-token"},
        )
    assert unavailable.status_code == 503


def test_product_and_category_analytics_use_immutable_snapshots(
    analytics_client: AnalyticsClient,
) -> None:
    item_id, category_id = _store_catalog_item(
        analytics_client.session_factory,
        item_name="Original Item",
        category_name="Original Category",
        price_amount=100,
    )
    original_line = LineSpec(item_id, "Original Item", "Original Category", 2, 100)
    _store_paid_order_with_lines(
        analytics_client.session_factory,
        lines=(original_line,),
        success_at=RANGE_START + timedelta(days=1),
    )
    _store_paid_order_with_lines(
        analytics_client.session_factory,
        lines=(LineSpec(item_id, "Original Item", "Original Category", 1, 100),),
        success_at=RANGE_START + timedelta(days=2),
    )
    with analytics_client.session_factory.begin() as session:
        item = session.get(MenuItem, item_id)
        category = session.get(Category, category_id)
        assert item is not None and category is not None
        item.name = "Renamed Item"
        item.price_amount = 999
        item.cost_amount = 777
        item.is_active = False
        item.is_available = False
        category.name = "Renamed Category"
        category.is_active = False
    _store_paid_order_with_lines(
        analytics_client.session_factory,
        lines=(LineSpec(item_id, "Renamed Item", "Renamed Category", 1, 150),),
        success_at=RANGE_START + timedelta(days=3),
    )
    with analytics_client.session_factory.begin() as session:
        moved_category = Category(name="Current Moved Category")
        session.add(moved_category)
        session.flush()
        item = session.get(MenuItem, item_id)
        assert item is not None
        item.category_id = moved_category.id

    products = analytics_client.client.get(
        PRODUCTS_PATH, params=_params(), headers=analytics_client.headers
    ).json()
    categories = analytics_client.client.get(
        CATEGORIES_PATH, params=_params(), headers=analytics_client.headers
    ).json()

    assert products["items"] == [
        {
            "menu_item_id": str(item_id),
            "item_name": "Original Item",
            "currency": "NOK",
            "quantity_sold": 3,
            "sales_amount": 300,
        },
        {
            "menu_item_id": str(item_id),
            "item_name": "Renamed Item",
            "currency": "NOK",
            "quantity_sold": 1,
            "sales_amount": 150,
        },
    ]
    assert categories["items"] == [
        {
            "category_name": "Original Category",
            "currency": "NOK",
            "quantity_sold": 3,
            "sales_amount": 300,
        },
        {
            "category_name": "Renamed Category",
            "currency": "NOK",
            "quantity_sold": 1,
            "sales_amount": 150,
        },
    ]


def test_order_type_analytics_use_payment_amount_and_ignore_attempts_receipts_status(
    analytics_client: AnalyticsClient,
) -> None:
    item_id, _ = _store_catalog_item(
        analytics_client.session_factory,
        item_name="Order Type Item",
        category_name="Order Type Category",
    )
    line = (LineSpec(item_id, "Order Type Item", "Order Type Category", 1, 100),)
    cases = (
        ("dine_in", "NOK", 150, True, True, OrderStatus.CREATED),
        ("dine_in", "NOK", 250, False, False, OrderStatus.COMPLETED),
        ("takeaway", "NOK", 300, False, False, OrderStatus.READY),
        ("takeaway", "EUR", 75, False, False, OrderStatus.ACCEPTED),
    )
    for order_type, currency, amount, attempts, receipt, status in cases:
        _store_paid_order_with_lines(
            analytics_client.session_factory,
            lines=line,
            success_at=RANGE_START + timedelta(days=4),
            currency=currency,
            order_type=order_type,
            payment_amount=amount,
            prior_attempts=attempts,
            additional_receipt=receipt,
            order_status=status,
        )

    response = analytics_client.client.get(
        ORDER_TYPES_PATH, params=_params(), headers=analytics_client.headers
    )

    assert response.status_code == 200
    assert response.json()["items"] == [
        {
            "order_type": "takeaway",
            "currency": "EUR",
            "succeeded_orders_count": 1,
            "collected_revenue_amount": 75,
        },
        {
            "order_type": "dine_in",
            "currency": "NOK",
            "succeeded_orders_count": 2,
            "collected_revenue_amount": 400,
        },
        {
            "order_type": "takeaway",
            "currency": "NOK",
            "succeeded_orders_count": 1,
            "collected_revenue_amount": 300,
        },
    ]
    products = analytics_client.client.get(
        PRODUCTS_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]
    categories = analytics_client.client.get(
        CATEGORIES_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]
    assert [
        (item["currency"], item["quantity_sold"], item["sales_amount"])
        for item in products
    ] == [
        ("EUR", 1, 100),
        ("NOK", 3, 300),
    ]
    assert [
        (item["currency"], item["quantity_sold"], item["sales_amount"])
        for item in categories
    ] == [
        ("EUR", 1, 100),
        ("NOK", 3, 300),
    ]


def test_breakdowns_share_half_open_success_range_not_order_creation_time(
    analytics_client: AnalyticsClient,
) -> None:
    item_id, _ = _store_catalog_item(
        analytics_client.session_factory,
        item_name="Boundary Item",
        category_name="Boundary Category",
        price_amount=10,
    )
    line = (LineSpec(item_id, "Boundary Item", "Boundary Category", 1, 10),)
    for success_at in (
        RANGE_START - timedelta(microseconds=1),
        RANGE_START,
        RANGE_START + timedelta(days=1),
        RANGE_END - timedelta(microseconds=1),
        RANGE_END,
    ):
        _store_paid_order_with_lines(
            analytics_client.session_factory,
            lines=line,
            success_at=success_at,
            payment_amount=10,
        )

    products = analytics_client.client.get(
        PRODUCTS_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]
    categories = analytics_client.client.get(
        CATEGORIES_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]
    order_types = analytics_client.client.get(
        ORDER_TYPES_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]

    assert products[0]["quantity_sold"] == 3
    assert products[0]["sales_amount"] == 30
    assert categories[0]["quantity_sold"] == 3
    assert categories[0]["sales_amount"] == 30
    assert order_types[0]["succeeded_orders_count"] == 3
    assert order_types[0]["collected_revenue_amount"] == 30


def test_breakdown_currency_filters_keep_nok_and_eur_separate(
    analytics_client: AnalyticsClient,
) -> None:
    item_id, _ = _store_catalog_item(
        analytics_client.session_factory,
        item_name="Currency Item",
        category_name="Currency Category",
    )
    line = (LineSpec(item_id, "Currency Item", "Currency Category", 1, 100),)
    for currency in ("NOK", "EUR"):
        _store_paid_order_with_lines(
            analytics_client.session_factory,
            lines=line,
            success_at=RANGE_START + timedelta(days=5),
            currency=currency,
        )

    for path in (PRODUCTS_PATH, CATEGORIES_PATH, ORDER_TYPES_PATH):
        unfiltered = analytics_client.client.get(
            path, params=_params(), headers=analytics_client.headers
        ).json()["items"]
        assert [item["currency"] for item in unfiltered] == ["EUR", "NOK"]
        for currency in ("NOK", "EUR"):
            filtered = analytics_client.client.get(
                path,
                params=_params(currency=currency),
                headers=analytics_client.headers,
            ).json()["items"]
            assert filtered
            assert {item["currency"] for item in filtered} == {currency}


def test_product_and_category_top_n_is_per_currency_with_deterministic_ties(
    analytics_client: AnalyticsClient,
) -> None:
    identifiers = [uuid.UUID(int=value) for value in range(1, 7)]
    for index, item_id in enumerate(identifiers):
        currency = "NOK" if index < 3 else "EUR"
        local_index = index % 3
        category_name = ("C", "A", "B")[local_index] + f"-{currency}"
        _store_catalog_item(
            analytics_client.session_factory,
            item_id=item_id,
            item_name=f"Item {index}",
            category_name=category_name,
            price_amount=100,
        )
        quantity = (1, 2, 2)[local_index]
        unit_price = (300, 100, 100)[local_index]
        _store_paid_order_with_lines(
            analytics_client.session_factory,
            lines=(
                LineSpec(item_id, f"Item {index}", category_name, quantity, unit_price),
            ),
            success_at=RANGE_START + timedelta(days=6),
            currency=currency,
        )

    products = analytics_client.client.get(
        PRODUCTS_PATH,
        params={**_params(), "limit": "2"},
        headers=analytics_client.headers,
    ).json()
    categories = analytics_client.client.get(
        CATEGORIES_PATH,
        params={**_params(), "limit": "2"},
        headers=analytics_client.headers,
    ).json()
    repeated_products = analytics_client.client.get(
        PRODUCTS_PATH,
        params={**_params(), "limit": "2"},
        headers=analytics_client.headers,
    ).json()
    repeated_categories = analytics_client.client.get(
        CATEGORIES_PATH,
        params={**_params(), "limit": "2"},
        headers=analytics_client.headers,
    ).json()

    assert products["limit_per_currency"] == 2
    assert [item["currency"] for item in products["items"]] == [
        "EUR",
        "EUR",
        "NOK",
        "NOK",
    ]
    assert [item["menu_item_id"] for item in products["items"]] == [
        str(identifiers[3]),
        str(identifiers[4]),
        str(identifiers[0]),
        str(identifiers[1]),
    ]
    assert [item["category_name"] for item in categories["items"]] == [
        "C-EUR",
        "A-EUR",
        "C-NOK",
        "A-NOK",
    ]
    assert repeated_products == products
    assert repeated_categories == categories

    limited_products = analytics_client.client.get(
        PRODUCTS_PATH,
        params={**_params(), "limit": "1"},
        headers=analytics_client.headers,
    ).json()["items"]
    all_categories = analytics_client.client.get(
        CATEGORIES_PATH,
        params={**_params(), "limit": "100"},
        headers=analytics_client.headers,
    ).json()["items"]
    assert [item["currency"] for item in limited_products] == ["EUR", "NOK"]
    assert len(all_categories) == 6


def test_product_tie_breaks_by_snapshot_name_after_same_menu_item_id(
    analytics_client: AnalyticsClient,
) -> None:
    item_id, _ = _store_catalog_item(
        analytics_client.session_factory,
        item_name="Current Tie Item",
        category_name="Tie Category",
    )
    for snapshot_name in ("Zulu Snapshot", "Alpha Snapshot"):
        _store_paid_order_with_lines(
            analytics_client.session_factory,
            lines=(LineSpec(item_id, snapshot_name, "Tie Category", 1, 100),),
            success_at=RANGE_START + timedelta(days=6),
        )

    response = analytics_client.client.get(
        PRODUCTS_PATH, params=_params(), headers=analytics_client.headers
    )

    assert response.status_code == 200
    assert [item["item_name"] for item in response.json()["items"]] == [
        "Alpha Snapshot",
        "Zulu Snapshot",
    ]


@pytest.mark.parametrize("path", [PRODUCTS_PATH, CATEGORIES_PATH, ORDER_TYPES_PATH])
def test_each_breakdown_executes_one_analytics_select_and_zero_dml(
    analytics_client: AnalyticsClient,
    test_database_engine: Engine,
    path: str,
) -> None:
    item_id, _ = _store_catalog_item(
        analytics_client.session_factory,
        item_name=f"Query Item {path.rsplit('/', 1)[-1]}",
        category_name=f"Query Category {path.rsplit('/', 1)[-1]}",
    )
    _store_paid_order_with_lines(
        analytics_client.session_factory,
        lines=(LineSpec(item_id, "Query Snapshot", "Query Category", 1, 100),),
        success_at=RANGE_START + timedelta(days=7),
    )
    statements: list[str] = []
    parameter_sets: list[object] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)
        parameter_sets.append(_parameters)

    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        response = analytics_client.client.get(
            path, params=_params(), headers=analytics_client.headers
        )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    assert response.status_code == 200
    analytics_selects = [
        statement
        for statement in statements
        if "qualified_succeeded_payments" in statement
    ]
    assert len(analytics_selects) == 1
    assert all(
        not statement.lstrip().lower().startswith(("insert", "update", "delete"))
        for statement in statements
    )
    if path == PRODUCTS_PATH:
        assert " menu_items " not in analytics_selects[0].lower()
    if path == CATEGORIES_PATH:
        assert " categories " not in analytics_selects[0].lower()
    analytics_index = statements.index(analytics_selects[0])
    with test_database_engine.connect() as connection:
        plan = (
            connection.exec_driver_sql(
                f"EXPLAIN {analytics_selects[0]}",
                parameter_sets[analytics_index],
            )
            .scalars()
            .all()
        )
    assert plan
    assert not any("SubPlan" in line for line in plan)
    if path in (PRODUCTS_PATH, CATEGORIES_PATH):
        assert any("WindowAgg" in line for line in plan)


def test_cross_endpoint_financial_and_snapshot_consistency(
    analytics_client: AnalyticsClient,
) -> None:
    item_id, _ = _store_catalog_item(
        analytics_client.session_factory,
        item_name="Consistency Item",
        category_name="Consistency Category",
    )
    for currency, payment_amount, quantity in (
        ("NOK", 175, 1),
        ("NOK", 225, 2),
        ("EUR", 90, 3),
    ):
        _store_paid_order_with_lines(
            analytics_client.session_factory,
            lines=(
                LineSpec(
                    item_id,
                    "Consistency Item",
                    "Consistency Category",
                    quantity,
                    100,
                ),
            ),
            success_at=RANGE_START + timedelta(days=8),
            currency=currency,
            payment_amount=payment_amount,
        )

    overview = analytics_client.client.get(
        OVERVIEW_PATH, params=_params(), headers=analytics_client.headers
    ).json()["currencies"]
    order_types = analytics_client.client.get(
        ORDER_TYPES_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]
    products = analytics_client.client.get(
        PRODUCTS_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]
    categories = analytics_client.client.get(
        CATEGORIES_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]
    for currency in ("EUR", "NOK"):
        overview_row = next(row for row in overview if row["currency"] == currency)
        typed = [row for row in order_types if row["currency"] == currency]
        assert overview_row["collected_revenue_amount"] == sum(
            row["collected_revenue_amount"] for row in typed
        )
        assert overview_row["succeeded_orders_count"] == sum(
            row["succeeded_orders_count"] for row in typed
        )
        product_rows = [row for row in products if row["currency"] == currency]
        category_rows = [row for row in categories if row["currency"] == currency]
        assert sum(row["quantity_sold"] for row in product_rows) == sum(
            row["quantity_sold"] for row in category_rows
        )
        assert sum(row["sales_amount"] for row in product_rows) == sum(
            row["sales_amount"] for row in category_rows
        )


def test_corrupted_payment_currency_keeps_finance_and_snapshots_isolated(
    analytics_client: AnalyticsClient,
) -> None:
    item_id, _ = _store_catalog_item(
        analytics_client.session_factory,
        item_name="Corrupt Currency Item",
        category_name="Corrupt Currency Category",
    )
    order_id = _store_paid_order_with_lines(
        analytics_client.session_factory,
        lines=(
            LineSpec(
                item_id, "Corrupt Currency Item", "Corrupt Currency Category", 1, 100
            ),
        ),
        success_at=RANGE_START + timedelta(days=9),
        currency="NOK",
        payment_amount=125,
    )
    with analytics_client.session_factory.begin() as session:
        payment = session.scalar(
            select(Payment).where(
                Payment.order_id == order_id,
                Payment.status == PaymentStatus.SUCCEEDED.value,
            )
        )
        assert payment is not None
        payment.currency = "EUR"

    overview = analytics_client.client.get(
        OVERVIEW_PATH, params=_params(), headers=analytics_client.headers
    ).json()["currencies"]
    order_types = analytics_client.client.get(
        ORDER_TYPES_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]
    products = analytics_client.client.get(
        PRODUCTS_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]
    categories = analytics_client.client.get(
        CATEGORIES_PATH, params=_params(), headers=analytics_client.headers
    ).json()["items"]
    assert [row["currency"] for row in overview] == ["EUR"]
    assert [row["currency"] for row in order_types] == ["EUR"]
    assert [row["currency"] for row in products] == ["NOK"]
    assert [row["currency"] for row in categories] == ["NOK"]
    for path in (PRODUCTS_PATH, CATEGORIES_PATH):
        for currency in ("NOK", "EUR"):
            assert (
                analytics_client.client.get(
                    path,
                    params=_params(currency=currency),
                    headers=analytics_client.headers,
                ).json()["items"]
                == []
            )


@pytest.mark.parametrize(
    ("event_type", "outcome"),
    [
        (StripeWebhookEventType.COMPLETED, WebhookProcessingOutcome.ALREADY_APPLIED),
        (
            StripeWebhookEventType.COMPLETED,
            WebhookProcessingOutcome.AWAITING_ASYNC_PAYMENT,
        ),
        (
            StripeWebhookEventType.COMPLETED,
            WebhookProcessingOutcome.RECONCILIATION_REQUIRED,
        ),
        (
            StripeWebhookEventType.ASYNC_PAYMENT_FAILED,
            WebhookProcessingOutcome.TRANSITIONED,
        ),
        (StripeWebhookEventType.EXPIRED, WebhookProcessingOutcome.TRANSITIONED),
    ],
)
def test_stripe_receipt_shape_does_not_override_persisted_success_time(
    analytics_client: AnalyticsClient,
    event_type: StripeWebhookEventType,
    outcome: WebhookProcessingOutcome,
) -> None:
    item_id, _ = _store_catalog_item(
        analytics_client.session_factory,
        item_name="Receipt Item",
        category_name="Receipt Category",
    )
    order_id = _store_paid_order_with_lines(
        analytics_client.session_factory,
        lines=(LineSpec(item_id, "Receipt Item", "Receipt Category", 1, 100),),
        success_at=RANGE_START + timedelta(days=10),
    )
    with analytics_client.session_factory.begin() as session:
        payment_id = session.scalar(
            select(Payment.id).where(Payment.order_id == order_id)
        )
        receipt = session.scalar(
            select(StripeEvent).where(StripeEvent.payment_id == payment_id)
        )
        assert receipt is not None
        receipt.event_type = event_type.value
        receipt.processing_result = outcome.value

    for path in (OVERVIEW_PATH, PRODUCTS_PATH, CATEGORIES_PATH, ORDER_TYPES_PATH):
        body = analytics_client.client.get(
            path, params=_params(), headers=analytics_client.headers
        ).json()
        assert body.get("currencies", body.get("items"))


def test_demo_payment_with_no_stripe_receipt_qualifies_for_every_endpoint(
    analytics_client: AnalyticsClient,
) -> None:
    item_id, _ = _store_catalog_item(
        analytics_client.session_factory,
        item_name="Demo Item",
        category_name="Demo Category",
    )
    _store_paid_order_with_lines(
        analytics_client.session_factory,
        lines=(LineSpec(item_id, "Demo Item", "Demo Category", 1, 100),),
        success_at=RANGE_START + timedelta(days=11),
        provider=PaymentProvider.DEMO,
        persist_stripe_receipt=False,
    )
    with analytics_client.session_factory() as session:
        assert session.scalar(select(Payment.provider)) == PaymentProvider.DEMO.value
        assert session.scalars(select(StripeEvent.id)).all() == []
    for path in (OVERVIEW_PATH, PRODUCTS_PATH, CATEGORIES_PATH, ORDER_TYPES_PATH):
        body = analytics_client.client.get(
            path, params=_params(), headers=analytics_client.headers
        ).json()
        assert body.get("currencies", body.get("items"))


def test_persisted_success_time_controls_every_endpoint(
    analytics_client: AnalyticsClient,
) -> None:
    item_id, _ = _store_catalog_item(
        analytics_client.session_factory,
        item_name="Minimum Time Item",
        category_name="Minimum Time Category",
    )
    first = RANGE_START + timedelta(days=12)
    order_id = _store_paid_order_with_lines(
        analytics_client.session_factory,
        lines=(
            LineSpec(item_id, "Minimum Time Item", "Minimum Time Category", 1, 100),
        ),
        success_at=first,
        additional_receipt=True,
    )
    with analytics_client.session_factory.begin() as session:
        payment_id = session.scalar(
            select(Payment.id).where(Payment.order_id == order_id)
        )
        extra_id = uuid.uuid4().hex
        session.add(
            StripeEvent(
                stripe_event_id=f"evt_synthetic_{extra_id}",
                event_type=StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED.value,
                livemode=False,
                stripe_created_at=first - timedelta(days=1),
                stripe_checkout_session_id=f"cs_test_{extra_id}",
                payment_id=payment_id,
                processing_result=WebhookProcessingOutcome.TRANSITIONED.value,
            )
        )
    for path in (OVERVIEW_PATH, PRODUCTS_PATH, CATEGORIES_PATH, ORDER_TYPES_PATH):
        included = analytics_client.client.get(
            path,
            params=_params(start=first, end=first + timedelta(hours=1)),
            headers=analytics_client.headers,
        ).json()
        excluded = analytics_client.client.get(
            path,
            params=_params(
                start=first - timedelta(days=2),
                end=first,
            ),
            headers=analytics_client.headers,
        ).json()
        assert included.get("currencies", included.get("items"))
        assert excluded.get("currencies", excluded.get("items")) == []


@pytest.mark.parametrize(
    ("start", "end", "expected_start_offset", "expected_end_offset"),
    [
        (
            datetime(2026, 3, 29, 0, tzinfo=UTC),
            datetime(2026, 3, 29, 2, tzinfo=UTC),
            "+01:00",
            "+02:00",
        ),
        (
            datetime(2026, 10, 25, 0, tzinfo=UTC),
            datetime(2026, 10, 25, 2, tzinfo=UTC),
            "+02:00",
            "+01:00",
        ),
    ],
)
def test_equivalent_instants_and_oslo_dst_are_consistent_across_all_routes(
    analytics_client: AnalyticsClient,
    start: datetime,
    end: datetime,
    expected_start_offset: str,
    expected_end_offset: str,
) -> None:
    utc_params = _params(start=start, end=end)
    offset_params = _params(
        start=start.astimezone(ZoneInfo("Europe/Oslo")),
        end=end.astimezone(ZoneInfo("Europe/Oslo")),
    )
    for path in (OVERVIEW_PATH, PRODUCTS_PATH, CATEGORIES_PATH, ORDER_TYPES_PATH):
        utc_body = analytics_client.client.get(
            path, params=utc_params, headers=analytics_client.headers
        ).json()
        offset_body = analytics_client.client.get(
            path, params=offset_params, headers=analytics_client.headers
        ).json()
        assert utc_body == offset_body
        assert utc_body["range"]["start"].endswith(expected_start_offset)
        assert utc_body["range"]["end"].endswith(expected_end_offset)


@pytest.mark.parametrize(
    "currency", ["nok", "NoK", "N0K", "NO", "NOKK", " NOK", "NOK ", "NØK"]
)
@pytest.mark.parametrize(
    "path", [OVERVIEW_PATH, PRODUCTS_PATH, CATEGORIES_PATH, ORDER_TYPES_PATH]
)
def test_all_analytics_routes_reject_noncanonical_currency(
    analytics_client: AnalyticsClient,
    path: str,
    currency: str,
) -> None:
    assert (
        analytics_client.client.get(
            path,
            params=_params(currency=currency),
            headers=analytics_client.headers,
        ).status_code
        == 422
    )
