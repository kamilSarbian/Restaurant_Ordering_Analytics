"""Integration tests for authenticated administrator CSV exports."""

from __future__ import annotations

import codecs
import csv
import io
import uuid
from collections.abc import Generator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

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
from app.orders.schemas import OrderType
from app.orders.statuses import OrderStatus
from app.payments.models import Payment, StripeEvent
from app.payments.providers import PaymentProvider
from app.payments.statuses import PaymentStatus
from app.payments.stripe_webhook import StripeWebhookEventType
from app.payments.webhook import WebhookProcessingOutcome
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration

EXPORT_PATH = "/api/v1/admin/exports/orders.csv"
PRODUCT_SALES_EXPORT_PATH = "/api/v1/admin/exports/product-sales.csv"
PAYMENTS_EXPORT_PATH = "/api/v1/admin/exports/payments.csv"
SYNTHETIC_SECRET = "e" * 32
FIXED_NOW = datetime(2026, 8, 11, 12, tzinfo=UTC)
RANGE_START = datetime(2026, 8, 11, 10, tzinfo=UTC)
RANGE_END = datetime(2026, 8, 11, 14, tzinfo=UTC)
EXPECTED_HEADERS = [
    "range_start",
    "range_end",
    "timezone",
    "public_order_number",
    "created_at",
    "updated_at",
    "order_status",
    "order_type",
    "table_number",
    "currency",
    "subtotal_amount",
    "total_amount",
]
PRODUCT_SALES_HEADERS = [
    "range_start",
    "range_end",
    "timezone",
    "menu_item_id",
    "item_name",
    "currency",
    "quantity_sold",
    "sales_amount",
]
PAYMENTS_HEADERS = [
    "range_start",
    "range_end",
    "timezone",
    "public_order_number",
    "payment_status",
    "success_at",
    "currency",
    "amount",
]


@dataclass(frozen=True)
class SnapshotLine:
    """Describe one immutable product snapshot for a report fixture."""

    menu_item_id: UUID
    item_name: str
    quantity: int
    unit_price_amount: int
    category_name: str = "Historical Category"


@dataclass(frozen=True)
class ReceiptFixture:
    """Describe one durable synthetic Stripe event receipt."""

    event_type: StripeWebhookEventType
    processing_result: WebhookProcessingOutcome
    success_at: datetime


@dataclass(frozen=True)
class StoredFinancialOrder:
    """Carry safe identifiers for a financial report fixture."""

    order_id: UUID
    payment_id: UUID
    public_order_number: str


@dataclass(frozen=True)
class ExportClient:
    """Hold an authenticated client and isolated persistence boundary."""

    client: TestClient
    token: str
    session_factory: sessionmaker[Session]

    @property
    def headers(self) -> dict[str, str]:
        """Return the synthetic administrator request header."""
        return {"Authorization": f"Bearer {self.token}"}


@pytest.fixture(autouse=True)
def empty_export_tables(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep export tests isolated from every persisted domain record."""

    def clear() -> None:
        with test_database_engine.begin() as connection:
            connection.execute(delete(StripeEvent))
            connection.execute(delete(Payment))
            connection.execute(delete(OrderStatusHistory))
            connection.execute(delete(OrderItem))
            connection.execute(delete(Order))
            connection.execute(delete(RestaurantTable))
            connection.execute(delete(MenuItem))
            connection.execute(delete(Category))
            connection.execute(delete(User))

    clear()
    try:
        yield
    finally:
        clear()


@pytest.fixture
def export_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create sessions bound only to the isolated integration database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def token_service() -> UserTokenService:
    """Create a deterministic synthetic administrator token service."""
    return UserTokenService(SYNTHETIC_SECRET, now_provider=lambda: FIXED_NOW)


@pytest.fixture
def export_client(
    export_session_factory: sessionmaker[Session],
    token_service: UserTokenService,
) -> Generator[ExportClient, None, None]:
    """Run the export route with one active synthetic administrator."""
    admin_id = _store_admin(export_session_factory)
    application = _application(export_session_factory, token_service)
    with TestClient(application) as client:
        yield ExportClient(
            client=client,
            token=token_service.create_access_token(admin_id),
            session_factory=export_session_factory,
        )


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
    is_active: bool = True,
) -> UUID:
    with session_factory.begin() as session:
        admin = User(
            email=f"export-{uuid.uuid4().hex}@example.com",
            password_hash="synthetic-password-hash",
            role=UserRole.SUPER_ADMIN,
            is_active=is_active,
        )
        session.add(admin)
        session.flush()
        return admin.id


def _store_order(
    session_factory: sessionmaker[Session],
    *,
    created_at: datetime,
    updated_at: datetime | None = None,
    status: OrderStatus = OrderStatus.CREATED,
    order_type: OrderType = OrderType.TAKEAWAY,
    currency: str = "NOK",
    subtotal_amount: int = 12345,
    total_amount: int = 12789,
    table_number: int | None = None,
) -> str:
    with session_factory.begin() as session:
        table = None
        if order_type is OrderType.DINE_IN:
            assert table_number is not None
            table = RestaurantTable(number=table_number)
            session.add(table)
            session.flush()
        order = Order(
            public_order_number=generate_public_order_number(),
            order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
            order_type=order_type.value,
            table_id=table.id if table is not None else None,
            table_number_snapshot=table_number,
            status=status.value,
            currency=currency,
            subtotal_amount=subtotal_amount,
            total_amount=total_amount,
            created_at=created_at,
            updated_at=updated_at or created_at,
        )
        session.add(order)
        session.flush()
        return order.public_order_number


def _store_catalog_item(
    session_factory: sessionmaker[Session],
    *,
    item_name: str,
    category_name: str,
    item_id: UUID | None = None,
) -> tuple[UUID, UUID]:
    with session_factory.begin() as session:
        category = Category(name=category_name)
        item = MenuItem(
            id=item_id or uuid.uuid4(),
            category=category,
            name=item_name,
            price_amount=100,
            cost_amount=50,
            currency="NOK",
        )
        session.add(item)
        session.flush()
        return item.id, category.id


def _store_financial_order(
    session_factory: sessionmaker[Session],
    *,
    payment_status: PaymentStatus = PaymentStatus.SUCCEEDED,
    payment_currency: str = "NOK",
    order_currency: str | None = None,
    amount: int = 100,
    receipts: tuple[ReceiptFixture, ...] = (),
    provider: PaymentProvider = PaymentProvider.STRIPE_TEST,
    succeeded_at: datetime | None = None,
    lines: tuple[SnapshotLine, ...] = (),
    order_created_at: datetime | None = None,
    payment_updated_at: datetime | None = None,
    public_order_number: str | None = None,
) -> StoredFinancialOrder:
    resolved_order_currency = order_currency or payment_currency
    line_total = sum(line.quantity * line.unit_price_amount for line in lines) or amount
    with session_factory.begin() as session:
        order = Order(
            public_order_number=public_order_number or generate_public_order_number(),
            order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
            order_type=OrderType.TAKEAWAY.value,
            status=OrderStatus.CREATED.value,
            currency=resolved_order_currency,
            subtotal_amount=line_total,
            total_amount=line_total,
            created_at=order_created_at or RANGE_START - timedelta(days=30),
            updated_at=order_created_at or RANGE_START - timedelta(days=30),
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
        payment_id = _add_payment_to_session(
            session,
            order_id=order.id,
            status=payment_status,
            currency=payment_currency,
            amount=amount,
            receipts=receipts,
            provider=provider,
            succeeded_at=succeeded_at,
            updated_at=payment_updated_at,
        )
        return StoredFinancialOrder(
            order_id=order.id,
            payment_id=payment_id,
            public_order_number=order.public_order_number,
        )


def _add_payment(
    session_factory: sessionmaker[Session],
    *,
    order_id: UUID,
    status: PaymentStatus,
    currency: str,
    amount: int,
    receipts: tuple[ReceiptFixture, ...] = (),
    provider: PaymentProvider = PaymentProvider.STRIPE_TEST,
    succeeded_at: datetime | None = None,
    updated_at: datetime | None = None,
) -> UUID:
    with session_factory.begin() as session:
        return _add_payment_to_session(
            session,
            order_id=order_id,
            status=status,
            currency=currency,
            amount=amount,
            receipts=receipts,
            provider=provider,
            succeeded_at=succeeded_at,
            updated_at=updated_at,
        )


def _add_payment_to_session(
    session: Session,
    *,
    order_id: UUID,
    status: PaymentStatus,
    currency: str,
    amount: int,
    receipts: tuple[ReceiptFixture, ...],
    provider: PaymentProvider,
    succeeded_at: datetime | None,
    updated_at: datetime | None,
) -> UUID:
    if status is PaymentStatus.SUCCEEDED and succeeded_at is None:
        qualifying_times = tuple(
            receipt.success_at
            for receipt in receipts
            if receipt.processing_result is WebhookProcessingOutcome.TRANSITIONED
            and receipt.event_type
            in {
                StripeWebhookEventType.COMPLETED,
                StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED,
            }
        )
        if not qualifying_times:
            raise AssertionError("Succeeded export fixture requires succeeded_at")
        succeeded_at = min(qualifying_times)
    payment_id = uuid.uuid4()
    payment = Payment(
        id=payment_id,
        order_id=order_id,
        provider=provider.value,
        status=status.value,
        amount=amount,
        currency=currency,
        request_idempotency_key=uuid.uuid4(),
        provider_idempotency_key=f"checkout-session:{payment_id}",
        succeeded_at=succeeded_at,
        created_at=RANGE_START - timedelta(days=20),
        updated_at=updated_at or RANGE_START - timedelta(days=20),
    )
    session.add(payment)
    session.flush()
    for receipt in receipts:
        receipt_token = uuid.uuid4().hex
        session.add(
            StripeEvent(
                stripe_event_id=f"evt_synthetic_{receipt_token}",
                event_type=receipt.event_type.value,
                livemode=False,
                stripe_created_at=receipt.success_at,
                stripe_checkout_session_id=f"cs_synthetic_{receipt_token}",
                payment_id=payment_id,
                processing_result=receipt.processing_result.value,
            )
        )
    return payment_id


def _transitioned_receipt(
    at: datetime,
    *,
    event_type: StripeWebhookEventType = StripeWebhookEventType.COMPLETED,
) -> ReceiptFixture:
    return ReceiptFixture(
        event_type=event_type,
        processing_result=WebhookProcessingOutcome.TRANSITIONED,
        success_at=at,
    )


def _params(
    *,
    start: datetime = RANGE_START,
    end: datetime = RANGE_END,
    **filters: str,
) -> dict[str, str]:
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        **filters,
    }


def _rows(response) -> list[dict[str, str]]:
    decoded = response.content.decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(decoded, newline="")))


def _assert_auth_failure(response) -> None:
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication credentials"}
    assert response.headers["WWW-Authenticate"] == "Bearer"


@pytest.mark.parametrize("authorization", [None, "Bearer malformed-token"])
def test_orders_export_rejects_missing_or_malformed_token(
    export_session_factory: sessionmaker[Session],
    token_service: UserTokenService,
    authorization: str | None,
) -> None:
    application = _application(export_session_factory, token_service)
    headers = {} if authorization is None else {"Authorization": authorization}
    with TestClient(application) as client:
        response = client.get(EXPORT_PATH, params=_params(), headers=headers)
    _assert_auth_failure(response)


def test_orders_export_rejects_inactive_admin(
    export_session_factory: sessionmaker[Session],
    token_service: UserTokenService,
) -> None:
    admin_id = _store_admin(export_session_factory, is_active=False)
    token = token_service.create_access_token(admin_id)
    application = _application(export_session_factory, token_service)
    with TestClient(application) as client:
        response = client.get(
            EXPORT_PATH,
            params=_params(),
            headers={"Authorization": f"Bearer {token}"},
        )
    _assert_auth_failure(response)


def test_orders_export_reports_unavailable_authentication(
    export_session_factory: sessionmaker[Session],
) -> None:
    application = _application(export_session_factory, None)
    with TestClient(application) as client:
        response = client.get(EXPORT_PATH, params=_params())
    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}


@pytest.mark.parametrize(
    "params",
    [
        {"end": RANGE_END.isoformat()},
        {"start": RANGE_START.isoformat()},
        {"start": "2026-08-11T10:00:00", "end": RANGE_END.isoformat()},
        {"start": RANGE_START.isoformat(), "end": "2026-08-11T14:00:00"},
        _params(end=RANGE_START),
        _params(start=RANGE_END),
        _params(currency="nok"),
        _params(currency="NO"),
        _params(status="unknown"),
        _params(order_type="delivery"),
        _params(limit="1"),
        _params(offset="1"),
        _params(filename="custom.csv"),
        _params(format="csv"),
        _params(timezone="Europe/Oslo"),
        _params(download="true"),
        _params(unknown="value"),
    ],
)
def test_orders_export_rejects_invalid_query_contract(
    export_client: ExportClient,
    params: dict[str, str],
) -> None:
    response = export_client.client.get(
        EXPORT_PATH,
        params=params,
        headers=export_client.headers,
    )
    assert response.status_code == 422


def test_orders_export_returns_exact_buffered_csv_contract(
    export_client: ExportClient,
) -> None:
    later = _store_order(
        export_client.session_factory,
        created_at=RANGE_START + timedelta(hours=2),
        order_type=OrderType.DINE_IN,
        table_number=17,
        subtotal_amount=20301,
        total_amount=20405,
    )
    earlier = _store_order(
        export_client.session_factory,
        created_at=RANGE_START + timedelta(hours=1),
        currency="EUR",
        subtotal_amount=101,
        total_amount=205,
    )

    response = export_client.client.get(
        EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == (
        'attachment; filename="orders_20260811T100000Z_'
        '20260811T140000Z_all_all_all.csv"'
    )
    assert response.content.startswith(codecs.BOM_UTF8)
    assert not response.content.startswith(codecs.BOM_UTF8 * 2)
    assert response.content.count(codecs.BOM_UTF8) == 1
    decoded = response.content.decode("utf-8-sig")
    assert decoded.endswith("\r\n")
    reader = csv.reader(io.StringIO(decoded, newline=""))
    assert next(reader) == EXPECTED_HEADERS

    rows = _rows(response)
    assert [row["public_order_number"] for row in rows] == [earlier, later]
    assert rows[0] == {
        "range_start": "2026-08-11T12:00:00+02:00",
        "range_end": "2026-08-11T16:00:00+02:00",
        "timezone": "Europe/Oslo",
        "public_order_number": earlier,
        "created_at": "2026-08-11T13:00:00+02:00",
        "updated_at": "2026-08-11T13:00:00+02:00",
        "order_status": "created",
        "order_type": "takeaway",
        "table_number": "",
        "currency": "EUR",
        "subtotal_amount": "101",
        "total_amount": "205",
    }
    assert rows[1]["table_number"] == "17"
    assert rows[1]["subtotal_amount"] == "20301"
    assert rows[1]["total_amount"] == "20405"


def test_empty_orders_export_returns_only_bom_header_and_crlf(
    export_client: ExportClient,
) -> None:
    response = export_client.client.get(
        EXPORT_PATH,
        params=_params(currency="NOK", status="completed", order_type="takeaway"),
        headers=export_client.headers,
    )
    expected = (",".join(EXPECTED_HEADERS) + "\r\n").encode("utf-8-sig")
    assert response.status_code == 200
    assert response.content == expected
    assert _rows(response) == []
    assert response.headers["content-disposition"].endswith(
        'NOK_completed_takeaway.csv"'
    )


def test_orders_export_uses_created_at_half_open_range_and_not_updated_at(
    export_client: ExportClient,
) -> None:
    at_start = _store_order(export_client.session_factory, created_at=RANGE_START)
    inside = _store_order(
        export_client.session_factory,
        created_at=RANGE_START + timedelta(microseconds=1),
        updated_at=RANGE_END + timedelta(days=3),
    )
    _store_order(
        export_client.session_factory,
        created_at=RANGE_END,
        updated_at=RANGE_START + timedelta(hours=1),
    )
    _store_order(
        export_client.session_factory,
        created_at=RANGE_START - timedelta(microseconds=1),
        updated_at=RANGE_START + timedelta(hours=1),
    )

    response = export_client.client.get(
        EXPORT_PATH, params=_params(), headers=export_client.headers
    )
    assert [row["public_order_number"] for row in _rows(response)] == [at_start, inside]


@pytest.mark.parametrize("status", [OrderStatus.CREATED, OrderStatus.COMPLETED])
def test_orders_export_filters_each_status_without_payment_restrictions(
    export_client: ExportClient,
    status: OrderStatus,
) -> None:
    expected = _store_order(
        export_client.session_factory,
        created_at=RANGE_START + timedelta(hours=1),
        status=status,
    )
    other = (
        OrderStatus.COMPLETED if status is OrderStatus.CREATED else OrderStatus.CREATED
    )
    _store_order(
        export_client.session_factory,
        created_at=RANGE_START + timedelta(hours=2),
        status=other,
    )
    response = export_client.client.get(
        EXPORT_PATH,
        params=_params(status=status.value),
        headers=export_client.headers,
    )
    assert [row["public_order_number"] for row in _rows(response)] == [expected]


def test_orders_export_filters_currency_order_type_and_combined_values(
    export_client: ExportClient,
) -> None:
    nok_takeaway = _store_order(
        export_client.session_factory,
        created_at=RANGE_START + timedelta(minutes=10),
        currency="NOK",
    )
    eur_takeaway = _store_order(
        export_client.session_factory,
        created_at=RANGE_START + timedelta(minutes=20),
        currency="EUR",
    )
    nok_dine_in = _store_order(
        export_client.session_factory,
        created_at=RANGE_START + timedelta(minutes=30),
        currency="NOK",
        status=OrderStatus.COMPLETED,
        order_type=OrderType.DINE_IN,
        table_number=31,
    )

    def numbers(**filters: str) -> list[str]:
        response = export_client.client.get(
            EXPORT_PATH,
            params=_params(**filters),
            headers=export_client.headers,
        )
        return [row["public_order_number"] for row in _rows(response)]

    assert numbers() == [nok_takeaway, eur_takeaway, nok_dine_in]
    assert numbers(currency="NOK") == [nok_takeaway, nok_dine_in]
    assert numbers(currency="EUR") == [eur_takeaway]
    assert numbers(order_type="takeaway") == [nok_takeaway, eur_takeaway]
    assert numbers(order_type="dine_in") == [nok_dine_in]
    assert numbers(currency="NOK", status="completed", order_type="dine_in") == [
        nok_dine_in
    ]


@pytest.mark.parametrize(
    ("start", "end", "expected_start_offset", "expected_end_offset"),
    [
        (
            datetime(2026, 1, 15, 10, tzinfo=UTC),
            datetime(2026, 1, 15, 12, tzinfo=UTC),
            "+01:00",
            "+01:00",
        ),
        (
            datetime(2026, 7, 15, 10, tzinfo=UTC),
            datetime(2026, 7, 15, 12, tzinfo=UTC),
            "+02:00",
            "+02:00",
        ),
        (
            datetime(2026, 3, 29, 0, tzinfo=UTC),
            datetime(2026, 3, 29, 2, tzinfo=UTC),
            "+01:00",
            "+02:00",
        ),
    ],
)
def test_orders_export_formats_oslo_winter_summer_and_dst(
    export_client: ExportClient,
    start: datetime,
    end: datetime,
    expected_start_offset: str,
    expected_end_offset: str,
) -> None:
    _store_order(
        export_client.session_factory,
        created_at=start + timedelta(minutes=30),
        updated_at=end - timedelta(minutes=30),
    )
    response = export_client.client.get(
        EXPORT_PATH,
        params=_params(start=start, end=end),
        headers=export_client.headers,
    )
    row = _rows(response)[0]
    assert row["range_start"].endswith(expected_start_offset)
    assert row["range_end"].endswith(expected_end_offset)
    assert row["created_at"].endswith(expected_start_offset)
    assert row["updated_at"].endswith(expected_end_offset)


def test_orders_export_executes_one_order_select_and_zero_dml_after_auth(
    export_client: ExportClient,
    test_database_engine: Engine,
) -> None:
    _store_order(
        export_client.session_factory,
        created_at=RANGE_START + timedelta(hours=1),
    )
    statements: list[str] = []

    def capture(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture)
    try:
        response = export_client.client.get(
            EXPORT_PATH,
            params=_params(),
            headers=export_client.headers,
        )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    assert response.status_code == 200
    report_selects = [
        statement
        for statement in statements
        if statement.lstrip().upper().startswith("SELECT")
        and "FROM orders" in statement
    ]
    assert len(report_selects) == 1
    assert " JOIN " not in report_selects[0].upper()
    assert "ORDER BY orders.created_at ASC, orders.id ASC" in report_selects[0]
    verbs = [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ]
    assert verbs == ["SELECT", "SELECT"]
    assert not {"INSERT", "UPDATE", "DELETE"}.intersection(verbs)


@pytest.mark.parametrize("path", [PRODUCT_SALES_EXPORT_PATH, PAYMENTS_EXPORT_PATH])
def test_analytics_exports_require_admin_and_accept_valid_admin(
    export_client: ExportClient,
    path: str,
) -> None:
    missing = export_client.client.get(path, params=_params())
    _assert_auth_failure(missing)
    valid = export_client.client.get(
        path,
        params=_params(),
        headers=export_client.headers,
    )
    assert valid.status_code == 200
    assert valid.headers["content-type"] == "text/csv; charset=utf-8"


def test_analytics_exports_share_representative_auth_failures(
    export_session_factory: sessionmaker[Session],
    token_service: UserTokenService,
) -> None:
    application = _application(export_session_factory, token_service)
    with TestClient(application) as client:
        malformed = client.get(
            PRODUCT_SALES_EXPORT_PATH,
            params=_params(),
            headers={"Authorization": "Bearer malformed-token"},
        )
    _assert_auth_failure(malformed)

    inactive_id = _store_admin(export_session_factory, is_active=False)
    inactive_token = token_service.create_access_token(inactive_id)
    with TestClient(application) as client:
        inactive = client.get(
            PAYMENTS_EXPORT_PATH,
            params=_params(),
            headers={"Authorization": f"Bearer {inactive_token}"},
        )
    _assert_auth_failure(inactive)

    with TestClient(_application(export_session_factory, None)) as client:
        unavailable = client.get(PRODUCT_SALES_EXPORT_PATH, params=_params())
    assert unavailable.status_code == 503
    assert unavailable.json() == {"detail": "Authentication service unavailable"}


@pytest.mark.parametrize("path", [PRODUCT_SALES_EXPORT_PATH, PAYMENTS_EXPORT_PATH])
@pytest.mark.parametrize(
    "params",
    [
        {"end": RANGE_END.isoformat()},
        {"start": RANGE_START.isoformat()},
        {"start": "2026-08-11T10:00:00", "end": RANGE_END.isoformat()},
        {"start": RANGE_START.isoformat(), "end": "2026-08-11T14:00:00"},
        _params(end=RANGE_START),
        _params(start=RANGE_END),
        _params(currency="nok"),
        _params(currency="NO"),
        _params(limit="2"),
        _params(offset="1"),
        _params(filename="custom.csv"),
        _params(format="csv"),
        _params(timezone="Europe/Oslo"),
        _params(download="true"),
        _params(arbitrary="value"),
    ],
)
def test_analytics_exports_reject_invalid_or_unknown_query_values(
    export_client: ExportClient,
    path: str,
    params: dict[str, str],
) -> None:
    response = export_client.client.get(
        path,
        params=params,
        headers=export_client.headers,
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    ("path", "headers", "prefix"),
    [
        (PRODUCT_SALES_EXPORT_PATH, PRODUCT_SALES_HEADERS, "product-sales"),
        (PAYMENTS_EXPORT_PATH, PAYMENTS_HEADERS, "payments"),
    ],
)
def test_empty_analytics_exports_return_only_bom_header_and_crlf(
    export_client: ExportClient,
    path: str,
    headers: list[str],
    prefix: str,
) -> None:
    response = export_client.client.get(
        path,
        params=_params(currency="NOK"),
        headers=export_client.headers,
    )
    assert response.status_code == 200
    assert response.content == (",".join(headers) + "\r\n").encode("utf-8-sig")
    assert response.content.count(codecs.BOM_UTF8) == 1
    assert _rows(response) == []
    assert response.headers["content-disposition"] == (
        f'attachment; filename="{prefix}_20260811T100000Z_' '20260811T140000Z_NOK.csv"'
    )


def test_product_sales_csv_sanitizes_formulae_and_round_trips_complex_unicode(
    export_client: ExportClient,
) -> None:
    names = [
        "=SUM(A1:A2)",
        "+cmd",
        "-10+20",
        '@HYPERLINK("http://example.com")',
        "Kjøtt",
        "Grønnsaker Å Ø Æ",
        'Chef\'s "Special", seasonal\nmenu',
    ]
    lines: list[SnapshotLine] = []
    for index, name in enumerate(names, start=1):
        item_id, _ = _store_catalog_item(
            export_client.session_factory,
            item_name=f"Current Item {index}",
            category_name=f"Current Category {index}",
        )
        lines.append(
            SnapshotLine(
                menu_item_id=item_id,
                item_name=name,
                quantity=index,
                unit_price_amount=100,
                category_name=f"Historical Category {index}",
            )
        )
    _store_financial_order(
        export_client.session_factory,
        lines=tuple(lines),
        amount=9999,
        receipts=(_transitioned_receipt(RANGE_START + timedelta(hours=1)),),
    )

    response = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )

    assert response.status_code == 200
    assert response.headers["content-disposition"] == (
        'attachment; filename="product-sales_20260811T100000Z_'
        '20260811T140000Z_all.csv"'
    )
    decoded = response.content.decode("utf-8-sig")
    assert decoded.count("\r\n") == len(names) + 1
    reader = csv.reader(io.StringIO(decoded, newline=""))
    assert next(reader) == PRODUCT_SALES_HEADERS
    rows = _rows(response)
    exported_names = {row["item_name"] for row in rows}
    assert {
        "'=SUM(A1:A2)",
        "'+cmd",
        "'-10+20",
        '\'@HYPERLINK("http://example.com")',
        "Kjøtt",
        "Grønnsaker Å Ø Æ",
        'Chef\'s "Special", seasonal\nmenu',
    } == exported_names
    assert all(row["currency"] == "NOK" for row in rows)
    assert {int(row["quantity_sold"]) for row in rows} == set(range(1, 8))
    with export_client.session_factory() as session:
        persisted_names = set(session.scalars(select(OrderItem.name_snapshot)).all())
    assert persisted_names == set(names)


def test_product_sales_uses_immutable_snapshots_after_catalog_mutation(
    export_client: ExportClient,
) -> None:
    item_id, category_id = _store_catalog_item(
        export_client.session_factory,
        item_name="Current Product",
        category_name="Current Category",
    )
    _store_financial_order(
        export_client.session_factory,
        lines=(SnapshotLine(item_id, "Historical Product", 3, 407),),
        amount=1500,
        receipts=(_transitioned_receipt(RANGE_START + timedelta(hours=1)),),
    )
    with export_client.session_factory.begin() as session:
        item = session.get(MenuItem, item_id)
        category = session.get(Category, category_id)
        assert item is not None and category is not None
        item.name = "Changed Current Product"
        item.price_amount = 9999
        item.cost_amount = 8888
        item.is_active = False
        item.is_available = False
        category.name = "Changed Current Category"

    response = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    assert _rows(response) == [
        {
            "range_start": "2026-08-11T12:00:00+02:00",
            "range_end": "2026-08-11T16:00:00+02:00",
            "timezone": "Europe/Oslo",
            "menu_item_id": str(item_id),
            "item_name": "Historical Product",
            "currency": "NOK",
            "quantity_sold": "3",
            "sales_amount": "1221",
        }
    ]


def test_product_sales_keeps_same_uuid_different_snapshot_names_separate(
    export_client: ExportClient,
) -> None:
    item_id, _ = _store_catalog_item(
        export_client.session_factory,
        item_name="Current Shared Product",
        category_name="Shared Category",
    )
    for snapshot_name in ("Zulu Snapshot", "Alpha Snapshot"):
        _store_financial_order(
            export_client.session_factory,
            lines=(SnapshotLine(item_id, snapshot_name, 1, 100),),
            receipts=(_transitioned_receipt(RANGE_START + timedelta(hours=1)),),
        )
    response = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    rows = _rows(response)
    assert [row["menu_item_id"] for row in rows] == [str(item_id), str(item_id)]
    assert [row["item_name"] for row in rows] == [
        "Alpha Snapshot",
        "Zulu Snapshot",
    ]


def test_product_csv_is_untruncated_while_json_keeps_per_currency_top_n(
    export_client: ExportClient,
) -> None:
    item_ids = [UUID(int=index) for index in range(1, 4)]
    for index, item_id in enumerate(item_ids):
        _store_catalog_item(
            export_client.session_factory,
            item_id=item_id,
            item_name=f"Current Ranked {index}",
            category_name=f"Ranked Category {index}",
        )
        _store_financial_order(
            export_client.session_factory,
            lines=(
                SnapshotLine(
                    item_id,
                    f"Historical Ranked {index}",
                    1,
                    300 - index * 100,
                ),
            ),
            receipts=(_transitioned_receipt(RANGE_START + timedelta(hours=1)),),
        )

    csv_response = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    json_response = export_client.client.get(
        "/api/v1/admin/analytics/products",
        params={**_params(), "limit": "2"},
        headers=export_client.headers,
    )
    assert [row["menu_item_id"] for row in _rows(csv_response)] == [
        str(item_id) for item_id in item_ids
    ]
    assert json_response.status_code == 200
    assert json_response.json()["limit_per_currency"] == 2
    assert [item["menu_item_id"] for item in json_response.json()["items"]] == [
        str(item_ids[0]),
        str(item_ids[1]),
    ]


def test_product_sales_range_uses_payment_success_and_half_open_boundaries(
    export_client: ExportClient,
) -> None:
    item_id, _ = _store_catalog_item(
        export_client.session_factory,
        item_name="Current Boundary Product",
        category_name="Boundary Category",
    )
    included = _store_financial_order(
        export_client.session_factory,
        lines=(SnapshotLine(item_id, "At Start", 1, 100),),
        order_created_at=RANGE_END + timedelta(days=10),
        receipts=(_transitioned_receipt(RANGE_START),),
    )
    _store_financial_order(
        export_client.session_factory,
        lines=(SnapshotLine(item_id, "At End", 1, 100),),
        order_created_at=RANGE_START + timedelta(hours=1),
        receipts=(_transitioned_receipt(RANGE_END),),
    )
    response = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    rows = _rows(response)
    assert [row["item_name"] for row in rows] == ["At Start"]
    assert rows[0]["menu_item_id"] == str(item_id)
    assert included.public_order_number not in rows[0].values()


def test_product_sales_mixed_currency_requires_payment_and_order_match(
    export_client: ExportClient,
) -> None:
    item_id, _ = _store_catalog_item(
        export_client.session_factory,
        item_name="Current Mixed Product",
        category_name="Mixed Category",
    )
    _store_financial_order(
        export_client.session_factory,
        payment_currency="NOK",
        order_currency="EUR",
        lines=(SnapshotLine(item_id, "Historical Mixed Product", 1, 100),),
        receipts=(_transitioned_receipt(RANGE_START + timedelta(hours=1)),),
    )

    def names(currency: str | None = None) -> list[str]:
        response = export_client.client.get(
            PRODUCT_SALES_EXPORT_PATH,
            params=_params(**({"currency": currency} if currency else {})),
            headers=export_client.headers,
        )
        return [row["item_name"] for row in _rows(response)]

    assert names() == ["Historical Mixed Product"]
    assert names("NOK") == []
    assert names("EUR") == []


def test_product_sales_keeps_currencies_separate_and_filters_exactly(
    export_client: ExportClient,
) -> None:
    stored_names: dict[str, str] = {}
    for currency in ("NOK", "EUR"):
        item_id, _ = _store_catalog_item(
            export_client.session_factory,
            item_name=f"Current {currency} Product",
            category_name=f"{currency} Category",
        )
        snapshot_name = f"Historical {currency} Product"
        stored_names[currency] = snapshot_name
        _store_financial_order(
            export_client.session_factory,
            payment_currency=currency,
            lines=(SnapshotLine(item_id, snapshot_name, 2, 150),),
            receipts=(_transitioned_receipt(RANGE_START + timedelta(hours=1)),),
        )

    def rows(currency: str | None = None) -> list[dict[str, str]]:
        response = export_client.client.get(
            PRODUCT_SALES_EXPORT_PATH,
            params=_params(**({"currency": currency} if currency else {})),
            headers=export_client.headers,
        )
        return _rows(response)

    assert [row["currency"] for row in rows()] == ["EUR", "NOK"]
    for currency in ("NOK", "EUR"):
        filtered = rows(currency)
        assert [row["currency"] for row in filtered] == [currency]
        assert filtered[0]["item_name"] == stored_names[currency]
        assert filtered[0]["quantity_sold"] == "2"
        assert filtered[0]["sales_amount"] == "300"


def test_payments_csv_exports_only_qualified_succeeded_rows_and_currency_filters(
    export_client: ExportClient,
) -> None:
    nok = _store_financial_order(
        export_client.session_factory,
        amount=1201,
        receipts=(_transitioned_receipt(RANGE_START + timedelta(minutes=10)),),
    )
    eur = _store_financial_order(
        export_client.session_factory,
        payment_currency="EUR",
        amount=2302,
        receipts=(
            _transitioned_receipt(
                RANGE_START + timedelta(minutes=20),
                event_type=StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED,
            ),
        ),
    )
    for status in (
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.PENDING,
    ):
        _store_financial_order(
            export_client.session_factory,
            payment_status=status,
            receipts=(_transitioned_receipt(RANGE_START + timedelta(minutes=30)),),
        )
    demo = _store_financial_order(
        export_client.session_factory,
        payment_status=PaymentStatus.SUCCEEDED,
        provider=PaymentProvider.DEMO,
        succeeded_at=RANGE_START + timedelta(minutes=30),
        amount=3403,
        receipts=(),
    )
    with export_client.session_factory() as session:
        assert (
            session.scalar(
                select(Payment.provider).where(Payment.id == demo.payment_id)
            )
            == PaymentProvider.DEMO.value
        )
        assert (
            session.scalar(
                select(StripeEvent.id).where(StripeEvent.payment_id == demo.payment_id)
            )
            is None
        )

    def rows(currency: str) -> list[dict[str, str]]:
        response = export_client.client.get(
            PAYMENTS_EXPORT_PATH,
            params=_params(currency=currency),
            headers=export_client.headers,
        )
        assert response.status_code == 200
        return _rows(response)

    unfiltered_response = export_client.client.get(
        PAYMENTS_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    assert unfiltered_response.status_code == 200
    assert unfiltered_response.content.count(codecs.BOM_UTF8) == 1
    assert unfiltered_response.headers["content-disposition"] == (
        'attachment; filename="payments_20260811T100000Z_' '20260811T140000Z_all.csv"'
    )
    unfiltered = _rows(unfiltered_response)
    assert [row["public_order_number"] for row in unfiltered] == [
        nok.public_order_number,
        eur.public_order_number,
        demo.public_order_number,
    ]
    assert list(unfiltered[0]) == PAYMENTS_HEADERS
    assert unfiltered[0]["payment_status"] == "succeeded"
    assert unfiltered[0]["success_at"] == "2026-08-11T12:10:00+02:00"
    assert unfiltered[0]["amount"] == "1201"
    assert unfiltered[1]["currency"] == "EUR"
    assert unfiltered[1]["amount"] == "2302"
    assert unfiltered[2]["currency"] == "NOK"
    assert unfiltered[2]["amount"] == "3403"
    assert [row["public_order_number"] for row in rows("NOK")] == [
        nok.public_order_number,
        demo.public_order_number,
    ]
    assert [row["public_order_number"] for row in rows("EUR")] == [
        eur.public_order_number
    ]


def test_payments_csv_uses_persisted_success_time_and_ignores_prior_attempts(
    export_client: ExportClient,
) -> None:
    stored = _store_financial_order(
        export_client.session_factory,
        payment_status=PaymentStatus.FAILED,
        amount=505,
    )
    _add_payment(
        export_client.session_factory,
        order_id=stored.order_id,
        status=PaymentStatus.EXPIRED,
        currency="NOK",
        amount=505,
    )
    first_success = RANGE_START + timedelta(minutes=15)
    _add_payment(
        export_client.session_factory,
        order_id=stored.order_id,
        status=PaymentStatus.SUCCEEDED,
        currency="NOK",
        amount=505,
        succeeded_at=first_success,
        receipts=(
            ReceiptFixture(
                StripeWebhookEventType.COMPLETED,
                WebhookProcessingOutcome.ALREADY_APPLIED,
                RANGE_START + timedelta(minutes=5),
            ),
            _transitioned_receipt(first_success),
            _transitioned_receipt(
                first_success + timedelta(minutes=1),
                event_type=StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED,
            ),
        ),
    )
    response = export_client.client.get(
        PAYMENTS_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    rows = _rows(response)
    assert len(rows) == 1
    assert rows[0]["public_order_number"] == stored.public_order_number
    assert rows[0]["success_at"] == "2026-08-11T12:15:00+02:00"
    assert rows[0]["amount"] == "505"


def test_payments_csv_uses_success_half_open_range_not_updated_at(
    export_client: ExportClient,
) -> None:
    at_start = _store_financial_order(
        export_client.session_factory,
        payment_updated_at=RANGE_END + timedelta(days=1),
        receipts=(_transitioned_receipt(RANGE_START),),
    )
    inside = _store_financial_order(
        export_client.session_factory,
        payment_updated_at=RANGE_END + timedelta(days=2),
        receipts=(_transitioned_receipt(RANGE_START + timedelta(microseconds=1)),),
    )
    _store_financial_order(
        export_client.session_factory,
        payment_updated_at=RANGE_START + timedelta(hours=1),
        receipts=(_transitioned_receipt(RANGE_END),),
    )
    _store_financial_order(
        export_client.session_factory,
        payment_updated_at=RANGE_START + timedelta(hours=1),
        receipts=(_transitioned_receipt(RANGE_START - timedelta(microseconds=1)),),
    )
    response = export_client.client.get(
        PAYMENTS_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    assert [row["public_order_number"] for row in _rows(response)] == [
        at_start.public_order_number,
        inside.public_order_number,
    ]


@pytest.mark.parametrize("path", [PRODUCT_SALES_EXPORT_PATH, PAYMENTS_EXPORT_PATH])
def test_analytics_export_executes_one_report_select_and_zero_dml(
    export_client: ExportClient,
    test_database_engine: Engine,
    path: str,
) -> None:
    item_id, _ = _store_catalog_item(
        export_client.session_factory,
        item_name="Current Query Product",
        category_name="Query Category",
    )
    _store_financial_order(
        export_client.session_factory,
        lines=(SnapshotLine(item_id, "Historical Query Product", 1, 100),),
        receipts=(_transitioned_receipt(RANGE_START + timedelta(hours=1)),),
    )
    statements: list[str] = []

    def capture(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture)
    try:
        response = export_client.client.get(
            path,
            params=_params(),
            headers=export_client.headers,
        )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    assert response.status_code == 200
    report_selects = [
        statement
        for statement in statements
        if "qualified_succeeded_payments" in statement
    ]
    assert len(report_selects) == 1
    verbs = [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ]
    assert verbs == ["SELECT", "WITH"]
    assert not {"INSERT", "UPDATE", "DELETE"}.intersection(verbs)
    assert "FROM menu_items" not in report_selects[0]
    assert "JOIN menu_items" not in report_selects[0]
    assert "FROM categories" not in report_selects[0]
    assert "JOIN categories" not in report_selects[0]
    normalized_sql = " ".join(report_selects[0].lower().split())
    assert "stripe_events" not in normalized_sql
    assert "payments.succeeded_at" in normalized_sql
    if path == PAYMENTS_EXPORT_PATH:
        assert (
            "order by qualified_succeeded_payments.success_at asc, "
            "orders.public_order_number asc, "
            "qualified_succeeded_payments.payment_id asc"
        ) in normalized_sql
    else:
        assert (
            "order by product_sales_groups.currency asc, "
            "product_sales_groups.sales_amount desc, "
            "product_sales_groups.quantity_sold desc, "
            "product_sales_groups.menu_item_id asc, "
            "product_sales_groups.item_name asc"
        ) in normalized_sql


def test_cross_export_ranges_use_order_creation_and_payment_success_independently(
    export_client: ExportClient,
) -> None:
    item_id, _ = _store_catalog_item(
        export_client.session_factory,
        item_name="Current Cross-Range Product",
        category_name="Cross-Range Category",
    )
    payment_success = RANGE_END + timedelta(hours=2)
    stored = _store_financial_order(
        export_client.session_factory,
        order_created_at=RANGE_START + timedelta(hours=1),
        lines=(SnapshotLine(item_id, "Historical Cross-Range Product", 1, 100),),
        receipts=(_transitioned_receipt(payment_success),),
    )
    payment_range = _params(
        start=RANGE_END + timedelta(hours=1),
        end=RANGE_END + timedelta(hours=3),
    )

    orders_in_creation_range = export_client.client.get(
        EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    products_in_creation_range = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    payments_in_creation_range = export_client.client.get(
        PAYMENTS_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    assert [row["public_order_number"] for row in _rows(orders_in_creation_range)] == [
        stored.public_order_number
    ]
    assert _rows(products_in_creation_range) == []
    assert _rows(payments_in_creation_range) == []

    orders_in_payment_range = export_client.client.get(
        EXPORT_PATH,
        params=payment_range,
        headers=export_client.headers,
    )
    products_in_payment_range = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=payment_range,
        headers=export_client.headers,
    )
    payments_in_payment_range = export_client.client.get(
        PAYMENTS_EXPORT_PATH,
        params=payment_range,
        headers=export_client.headers,
    )
    assert _rows(orders_in_payment_range) == []
    assert [row["item_name"] for row in _rows(products_in_payment_range)] == [
        "Historical Cross-Range Product"
    ]
    assert [row["public_order_number"] for row in _rows(payments_in_payment_range)] == [
        stored.public_order_number
    ]


@pytest.mark.parametrize(
    ("path", "expected_headers"),
    [
        (EXPORT_PATH, EXPECTED_HEADERS),
        (PRODUCT_SALES_EXPORT_PATH, PRODUCT_SALES_HEADERS),
        (PAYMENTS_EXPORT_PATH, PAYMENTS_HEADERS),
    ],
)
def test_each_export_has_exact_row_bytes_mime_headers_and_no_blank_record(
    export_client: ExportClient,
    path: str,
    expected_headers: list[str],
) -> None:
    item_id, _ = _store_catalog_item(
        export_client.session_factory,
        item_name="Current Byte Contract Product",
        category_name="Byte Contract Category",
    )
    _store_financial_order(
        export_client.session_factory,
        order_created_at=RANGE_START + timedelta(hours=1),
        lines=(SnapshotLine(item_id, "Historical Byte Product", 2, 321),),
        amount=987,
        receipts=(_transitioned_receipt(RANGE_START + timedelta(hours=1)),),
    )
    response = export_client.client.get(
        path,
        params=_params(),
        headers=export_client.headers,
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.content.startswith(codecs.BOM_UTF8)
    assert not response.content.startswith(codecs.BOM_UTF8 * 2)
    assert response.content.count(codecs.BOM_UTF8) == 1
    payload = response.content[len(codecs.BOM_UTF8) :]
    payload.decode("utf-8")
    assert payload.endswith(b"\r\n")
    assert payload.count(b"\r\n") == 2
    assert b"\n" not in payload.replace(b"\r\n", b"")
    parsed = list(csv.reader(io.StringIO(payload.decode("utf-8"), newline="")))
    assert parsed[0] == expected_headers
    assert len(parsed) == 2
    assert parsed[1]
    assert all(cell != "" for cell in parsed[1] if path != EXPORT_PATH)


@pytest.mark.parametrize(
    "path", [EXPORT_PATH, PRODUCT_SALES_EXPORT_PATH, PAYMENTS_EXPORT_PATH]
)
def test_equivalent_instants_produce_identical_safe_content_disposition(
    export_client: ExportClient,
    path: str,
) -> None:
    utc_params = _params(
        start=datetime(2026, 8, 11, 12, tzinfo=UTC),
        end=datetime(2026, 8, 11, 14, tzinfo=UTC),
    )
    offset_params = _params(
        start=datetime.fromisoformat("2026-08-11T14:00:00+02:00"),
        end=datetime.fromisoformat("2026-08-11T16:00:00+02:00"),
    )
    first = export_client.client.get(
        path,
        params=utc_params,
        headers=export_client.headers,
    )
    second = export_client.client.get(
        path,
        params=offset_params,
        headers=export_client.headers,
    )
    disposition = first.headers["content-disposition"]
    assert second.headers["content-disposition"] == disposition
    assert disposition.startswith('attachment; filename="')
    assert disposition.endswith('"')
    assert "filename*=" not in disposition
    filename = disposition.removeprefix('attachment; filename="').removesuffix('"')
    filename.encode("ascii")
    assert not any(character in filename for character in "/\\;\r\n")


def test_product_grouping_uses_raw_names_before_serialization_safety(
    export_client: ExportClient,
) -> None:
    item_id, _ = _store_catalog_item(
        export_client.session_factory,
        item_name="Current Raw Group Product",
        category_name="Raw Group Category",
    )
    for snapshot_name in ("=Raw Name", "'=Raw Name"):
        _store_financial_order(
            export_client.session_factory,
            lines=(SnapshotLine(item_id, snapshot_name, 1, 100),),
            receipts=(_transitioned_receipt(RANGE_START + timedelta(hours=1)),),
        )
    response = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )

    rows = _rows(response)
    assert len(rows) == 2
    assert [row["menu_item_id"] for row in rows] == [str(item_id), str(item_id)]
    assert [row["item_name"] for row in rows] == ["'=Raw Name", "'=Raw Name"]
    with export_client.session_factory() as session:
        persisted = set(session.scalars(select(OrderItem.name_snapshot)).all())
    assert persisted == {"=Raw Name", "'=Raw Name"}


def test_mixed_currency_sources_remain_intentionally_asymmetric(
    export_client: ExportClient,
) -> None:
    item_id, _ = _store_catalog_item(
        export_client.session_factory,
        item_name="Current Asymmetric Product",
        category_name="Asymmetric Category",
    )
    stored = _store_financial_order(
        export_client.session_factory,
        payment_currency="NOK",
        order_currency="EUR",
        order_created_at=RANGE_START + timedelta(hours=1),
        lines=(SnapshotLine(item_id, "Historical Asymmetric Product", 1, 100),),
        receipts=(_transitioned_receipt(RANGE_START + timedelta(hours=1)),),
    )

    orders_eur = export_client.client.get(
        EXPORT_PATH,
        params=_params(currency="EUR"),
        headers=export_client.headers,
    )
    orders_nok = export_client.client.get(
        EXPORT_PATH,
        params=_params(currency="NOK"),
        headers=export_client.headers,
    )
    products_all = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    products_nok = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=_params(currency="NOK"),
        headers=export_client.headers,
    )
    products_eur = export_client.client.get(
        PRODUCT_SALES_EXPORT_PATH,
        params=_params(currency="EUR"),
        headers=export_client.headers,
    )
    payments_nok = export_client.client.get(
        PAYMENTS_EXPORT_PATH,
        params=_params(currency="NOK"),
        headers=export_client.headers,
    )
    assert [row["public_order_number"] for row in _rows(orders_eur)] == [
        stored.public_order_number
    ]
    assert _rows(orders_nok) == []
    assert [row["currency"] for row in _rows(products_all)] == ["EUR"]
    assert _rows(products_nok) == []
    assert _rows(products_eur) == []
    assert [row["public_order_number"] for row in _rows(payments_nok)] == [
        stored.public_order_number
    ]


def test_payments_same_success_time_orders_by_public_number_without_exposing_id(
    export_client: ExportClient,
) -> None:
    success_at = RANGE_START + timedelta(hours=1)
    later_number = "ROA-23456789ABCE"
    earlier_number = "ROA-23456789ABCD"
    _store_financial_order(
        export_client.session_factory,
        public_order_number=later_number,
        receipts=(_transitioned_receipt(success_at),),
    )
    _store_financial_order(
        export_client.session_factory,
        public_order_number=earlier_number,
        receipts=(_transitioned_receipt(success_at),),
    )
    response = export_client.client.get(
        PAYMENTS_EXPORT_PATH,
        params=_params(),
        headers=export_client.headers,
    )
    rows = _rows(response)
    assert [row["public_order_number"] for row in rows] == [
        earlier_number,
        later_number,
    ]
    assert list(rows[0]) == PAYMENTS_HEADERS
    assert "payment_id" not in rows[0]


@pytest.mark.parametrize(
    ("start", "end", "start_offset", "end_offset", "instant_offset"),
    [
        (
            datetime(2026, 1, 15, 10, tzinfo=UTC),
            datetime(2026, 1, 15, 12, tzinfo=UTC),
            "+01:00",
            "+01:00",
            "+01:00",
        ),
        (
            datetime(2026, 7, 15, 10, tzinfo=UTC),
            datetime(2026, 7, 15, 12, tzinfo=UTC),
            "+02:00",
            "+02:00",
            "+02:00",
        ),
        (
            datetime(2026, 3, 29, 0, tzinfo=UTC),
            datetime(2026, 3, 29, 2, tzinfo=UTC),
            "+01:00",
            "+02:00",
            "+02:00",
        ),
        (
            datetime(2026, 10, 25, 0, tzinfo=UTC),
            datetime(2026, 10, 25, 2, tzinfo=UTC),
            "+02:00",
            "+01:00",
            "+01:00",
        ),
    ],
)
def test_all_exports_use_oslo_offsets_across_seasons_and_dst_boundaries(
    export_client: ExportClient,
    start: datetime,
    end: datetime,
    start_offset: str,
    end_offset: str,
    instant_offset: str,
) -> None:
    item_id, _ = _store_catalog_item(
        export_client.session_factory,
        item_name="Current Time Product",
        category_name="Time Category",
    )
    instant = start + (end - start) / 2
    _store_financial_order(
        export_client.session_factory,
        order_created_at=instant,
        lines=(SnapshotLine(item_id, "Historical Time Product", 1, 101),),
        amount=303,
        receipts=(_transitioned_receipt(instant),),
    )
    params = _params(start=start, end=end)
    orders_row = _rows(
        export_client.client.get(
            EXPORT_PATH, params=params, headers=export_client.headers
        )
    )[0]
    product_row = _rows(
        export_client.client.get(
            PRODUCT_SALES_EXPORT_PATH,
            params=params,
            headers=export_client.headers,
        )
    )[0]
    payment_row = _rows(
        export_client.client.get(
            PAYMENTS_EXPORT_PATH,
            params=params,
            headers=export_client.headers,
        )
    )[0]

    for row in (orders_row, product_row, payment_row):
        assert row["range_start"].endswith(start_offset)
        assert row["range_end"].endswith(end_offset)
        assert row["timezone"] == "Europe/Oslo"
    assert orders_row["created_at"].endswith(instant_offset)
    assert orders_row["updated_at"].endswith(instant_offset)
    assert payment_row["success_at"].endswith(instant_offset)
    assert orders_row["subtotal_amount"].isdigit()
    assert orders_row["total_amount"].isdigit()
    assert product_row["sales_amount"] == "101"
    assert payment_row["amount"] == "303"
