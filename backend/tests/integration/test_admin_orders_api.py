"""Integration tests for authenticated administrator order reads."""

from __future__ import annotations

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

from app.auth.models import AdminUser
from app.auth.passwords import hash_password
from app.auth.roles import UserRole
from app.auth.tokens import AdminTokenService
from app.categories.models import Category
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app
from app.menu.models import MenuItem
from app.orders.access import generate_public_order_number
from app.orders.admin_service import (
    AdminOrderInvalidTransitionError,
    AdminOrderNotFoundError,
    get_admin_order,
    list_admin_orders,
    transition_order_status,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.schemas import OrderType
from app.orders.statuses import OrderStatus
from app.payments.models import Payment, StripeEvent
from app.payments.statuses import PaymentStatus
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration

LIST_PATH = "/api/v1/admin/orders"
DETAIL_PATH = "/api/v1/admin/orders/{public_order_number}"
SYNTHETIC_SECRET = "a" * 32
SYNTHETIC_PASSWORD = "synthetic-admin-order-password"
FIXED_NOW = datetime(2026, 8, 11, 12, tzinfo=UTC)


@dataclass(frozen=True)
class AdminClient:
    """Hold an authenticated client and its isolated persistence boundary."""

    client: TestClient
    token: str
    session_factory: sessionmaker[Session]

    @property
    def headers(self) -> dict[str, str]:
        """Return the synthetic Bearer header for one request."""
        return {"Authorization": f"Bearer {self.token}"}


@dataclass(frozen=True)
class StoredDetail:
    """Hold identifiers for one complete administrator order fixture."""

    order_id: UUID
    public_order_number: str
    category_id: UUID
    first_menu_item_id: UUID
    second_menu_item_id: UUID
    payment_ids: tuple[UUID, UUID, UUID]


@dataclass(frozen=True)
class StoredTransition:
    """Hold identifiers for one order-status transition fixture."""

    order_id: UUID
    public_order_number: str
    payment_ids: tuple[UUID, ...]


@dataclass(frozen=True)
class StoredHistory:
    """Hold primitive status-history values for cross-session assertions."""

    sequence: int
    previous_status: str | None
    new_status: str
    changed_at: datetime


@pytest.fixture(autouse=True)
def empty_admin_order_tables(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep administrator order tests isolated from all persisted records."""

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
            connection.execute(delete(AdminUser))

    clear()
    try:
        yield
    finally:
        clear()


@pytest.fixture
def admin_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create sessions bound only to the isolated integration database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def token_service() -> AdminTokenService:
    """Create a deterministic synthetic administrator token service."""
    return AdminTokenService(
        SYNTHETIC_SECRET,
        access_token_expire_minutes=30,
        now_provider=lambda: FIXED_NOW,
    )


@pytest.fixture
def admin_client(
    admin_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
) -> Generator[AdminClient, None, None]:
    """Run the application with an isolated active synthetic administrator."""
    admin_id = _store_admin(admin_session_factory)
    application = _application(admin_session_factory, token_service)
    with TestClient(application) as client:
        yield AdminClient(
            client=client,
            token=token_service.create_access_token(admin_id),
            session_factory=admin_session_factory,
        )


def _application(
    session_factory: sessionmaker[Session],
    token_service: AdminTokenService | None,
):
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            admin_jwt_secret=None,
        ),
        session_factory=session_factory,
        admin_token_service=token_service,
    )


def _store_admin(
    session_factory: sessionmaker[Session],
    *,
    email: str = "orders-admin@example.com",
    is_active: bool = True,
) -> UUID:
    with session_factory.begin() as session:
        admin = AdminUser(
            email=email,
            password_hash=hash_password(SYNTHETIC_PASSWORD),
            role=UserRole.SUPER_ADMIN,
            is_active=is_active,
        )
        session.add(admin)
        session.flush()
        return admin.id


def _store_customer(session_factory: sessionmaker[Session]) -> tuple[UUID, str]:
    email = f"owned-order-{uuid.uuid4().hex}@example.com"
    with session_factory.begin() as session:
        customer = AdminUser(
            email=email,
            password_hash="synthetic-owned-order-password-hash",
            role=UserRole.CUSTOMER,
            is_active=True,
        )
        session.add(customer)
        session.flush()
        return customer.id, email


def _store_list_order(
    session_factory: sessionmaker[Session],
    *,
    status: OrderStatus = OrderStatus.CREATED,
    order_type: OrderType = OrderType.TAKEAWAY,
    created_at: datetime = FIXED_NOW,
    total_amount: int = 1000,
    customer_user_id: UUID | None = None,
) -> tuple[UUID, str]:
    with session_factory.begin() as session:
        table = None
        if order_type is OrderType.DINE_IN:
            table = RestaurantTable(number=total_amount)
            session.add(table)
            session.flush()
        order = Order(
            public_order_number=generate_public_order_number(),
            order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
            customer_user_id=customer_user_id,
            order_type=order_type.value,
            table_id=table.id if table is not None else None,
            table_number_snapshot=table.number if table is not None else None,
            status=status.value,
            currency="NOK",
            subtotal_amount=total_amount,
            total_amount=total_amount,
            created_at=created_at,
            updated_at=created_at,
        )
        session.add(order)
        session.flush()
        return order.id, order.public_order_number


def _store_detail_order(
    session_factory: sessionmaker[Session],
    *,
    customer_user_id: UUID | None = None,
) -> StoredDetail:
    with session_factory.begin() as session:
        category = Category(name="Current Admin Category")
        first_menu_item = MenuItem(
            category=category,
            name="Current First Item",
            price_amount=9999,
            cost_amount=5555,
        )
        second_menu_item = MenuItem(
            category=category,
            name="Current Second Item",
            price_amount=8888,
            cost_amount=4444,
        )
        table = RestaurantTable(number=17)
        session.add_all([category, first_menu_item, second_menu_item, table])
        session.flush()

        order = Order(
            public_order_number=generate_public_order_number(),
            order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
            customer_user_id=customer_user_id,
            order_type=OrderType.DINE_IN.value,
            table_id=table.id,
            table_number_snapshot=7,
            status=OrderStatus.ACCEPTED.value,
            currency="NOK",
            subtotal_amount=500,
            total_amount=500,
            created_at=FIXED_NOW,
            updated_at=FIXED_NOW + timedelta(minutes=5),
        )
        session.add(order)
        session.flush()

        first_item = OrderItem(
            order=order,
            menu_item_id=first_menu_item.id,
            position=0,
            category_name_snapshot="Historical Category",
            name_snapshot="Historical First Item",
            quantity=2,
            unit_price_amount=100,
            unit_cost_amount=70,
            tax_rate_bps_snapshot=2500,
            discount_amount_snapshot=0,
            line_total_amount=200,
        )
        second_item = OrderItem(
            order=order,
            menu_item_id=second_menu_item.id,
            position=1,
            category_name_snapshot="Historical Category",
            name_snapshot="Historical Second Item",
            quantity=1,
            unit_price_amount=300,
            unit_cost_amount=None,
            tax_rate_bps_snapshot=None,
            discount_amount_snapshot=0,
            line_total_amount=300,
        )
        initial_history = OrderStatusHistory(
            order=order,
            sequence=0,
            previous_status=None,
            new_status=OrderStatus.CREATED.value,
            changed_at=FIXED_NOW,
        )
        accepted_history = OrderStatusHistory(
            order=order,
            sequence=1,
            previous_status=OrderStatus.CREATED.value,
            new_status=OrderStatus.ACCEPTED.value,
            changed_at=FIXED_NOW + timedelta(minutes=5),
        )
        session.add_all([second_item, first_item, accepted_history, initial_history])

        payment_ids = (
            UUID("00000000-0000-0000-0000-000000000103"),
            UUID("00000000-0000-0000-0000-000000000101"),
            UUID("00000000-0000-0000-0000-000000000102"),
        )
        payments = [
            Payment(
                id=payment_ids[0],
                order=order,
                status=PaymentStatus.SUCCEEDED.value,
                amount=500,
                currency="NOK",
                request_idempotency_key=uuid.uuid4(),
                stripe_idempotency_key=f"checkout-session:{payment_ids[0]}",
                stripe_checkout_session_id="cs_test_synthetic_admin_detail",
                stripe_checkout_url="https://example.invalid/checkout",
                stripe_checkout_expires_at=FIXED_NOW + timedelta(hours=1),
                created_at=FIXED_NOW + timedelta(minutes=3),
                updated_at=FIXED_NOW + timedelta(minutes=4),
            ),
            Payment(
                id=payment_ids[1],
                order=order,
                status=PaymentStatus.FAILED.value,
                amount=500,
                currency="NOK",
                request_idempotency_key=uuid.uuid4(),
                stripe_idempotency_key=f"checkout-session:{payment_ids[1]}",
                created_at=FIXED_NOW + timedelta(minutes=1),
                updated_at=FIXED_NOW + timedelta(minutes=1),
            ),
            Payment(
                id=payment_ids[2],
                order=order,
                status=PaymentStatus.EXPIRED.value,
                amount=500,
                currency="NOK",
                request_idempotency_key=uuid.uuid4(),
                stripe_idempotency_key=f"checkout-session:{payment_ids[2]}",
                created_at=FIXED_NOW + timedelta(minutes=2),
                updated_at=FIXED_NOW + timedelta(minutes=2),
            ),
        ]
        session.add_all(payments)
        session.flush()
        return StoredDetail(
            order_id=order.id,
            public_order_number=order.public_order_number,
            category_id=category.id,
            first_menu_item_id=first_menu_item.id,
            second_menu_item_id=second_menu_item.id,
            payment_ids=payment_ids,
        )


def _status_path(current_status: OrderStatus) -> list[OrderStatus]:
    paths = {
        OrderStatus.CREATED: [OrderStatus.CREATED],
        OrderStatus.ACCEPTED: [OrderStatus.CREATED, OrderStatus.ACCEPTED],
        OrderStatus.PREPARING: [
            OrderStatus.CREATED,
            OrderStatus.ACCEPTED,
            OrderStatus.PREPARING,
        ],
        OrderStatus.READY: [
            OrderStatus.CREATED,
            OrderStatus.ACCEPTED,
            OrderStatus.PREPARING,
            OrderStatus.READY,
        ],
        OrderStatus.COMPLETED: [
            OrderStatus.CREATED,
            OrderStatus.ACCEPTED,
            OrderStatus.PREPARING,
            OrderStatus.READY,
            OrderStatus.COMPLETED,
        ],
        OrderStatus.CANCELLED: [OrderStatus.CREATED, OrderStatus.CANCELLED],
    }
    return paths[current_status]


def _store_transition_order(
    session_factory: sessionmaker[Session],
    *,
    current_status: OrderStatus = OrderStatus.CREATED,
    payment_statuses: tuple[PaymentStatus, ...] = (),
    customer_user_id: UUID | None = None,
) -> StoredTransition:
    base_time = FIXED_NOW - timedelta(days=365)
    with session_factory.begin() as session:
        order = Order(
            public_order_number=generate_public_order_number(),
            order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
            customer_user_id=customer_user_id,
            order_type=OrderType.TAKEAWAY.value,
            table_id=None,
            table_number_snapshot=None,
            status=current_status.value,
            currency="NOK",
            subtotal_amount=500,
            total_amount=500,
            created_at=base_time,
            updated_at=base_time,
        )
        session.add(order)
        session.flush()

        path = _status_path(current_status)
        session.add_all(
            [
                OrderStatusHistory(
                    order_id=order.id,
                    sequence=sequence,
                    previous_status=(path[sequence - 1].value if sequence else None),
                    new_status=status_value.value,
                    changed_at=base_time + timedelta(minutes=sequence),
                )
                for sequence, status_value in enumerate(path)
            ]
        )

        payment_ids: list[UUID] = []
        for position, payment_status in enumerate(payment_statuses):
            payment_id = uuid.uuid4()
            payment_ids.append(payment_id)
            session.add(
                Payment(
                    id=payment_id,
                    order_id=order.id,
                    status=payment_status.value,
                    amount=order.total_amount,
                    currency=order.currency,
                    request_idempotency_key=uuid.uuid4(),
                    stripe_idempotency_key=f"checkout-session:{payment_id}",
                    created_at=base_time + timedelta(seconds=position),
                    updated_at=base_time + timedelta(seconds=position),
                )
            )
        session.flush()
        return StoredTransition(
            order_id=order.id,
            public_order_number=order.public_order_number,
            payment_ids=tuple(payment_ids),
        )


def _transition_path(public_order_number: str) -> str:
    return f"{DETAIL_PATH.format(public_order_number=public_order_number)}/status"


def _stored_transition_state(
    session_factory: sessionmaker[Session],
    stored: StoredTransition,
) -> tuple[str, list[StoredHistory], list[tuple[UUID, str, datetime]]]:
    with session_factory() as session:
        order = session.get(Order, stored.order_id)
        assert order is not None
        history = [
            StoredHistory(
                sequence=entry.sequence,
                previous_status=entry.previous_status,
                new_status=entry.new_status,
                changed_at=entry.changed_at,
            )
            for entry in session.scalars(
                select(OrderStatusHistory)
                .where(OrderStatusHistory.order_id == stored.order_id)
                .order_by(OrderStatusHistory.sequence.asc())
            ).all()
        ]
        payments = [
            (payment_id, status_value, updated_at)
            for payment_id, status_value, updated_at in session.execute(
                select(Payment.id, Payment.status, Payment.updated_at)
                .where(Payment.order_id == stored.order_id)
                .order_by(Payment.created_at.asc(), Payment.id.asc())
            ).all()
        ]
        return order.status, history, payments


def _response_keys(value: object) -> set[str]:
    keys: set[str] = set()
    if isinstance(value, dict):
        keys.update(value)
        for item in value.values():
            keys.update(_response_keys(item))
    elif isinstance(value, list):
        for item in value:
            keys.update(_response_keys(item))
    return keys


@pytest.mark.parametrize(
    "path",
    [LIST_PATH, DETAIL_PATH.format(public_order_number="ROA-ZZZZZZZZZZZZ")],
)
@pytest.mark.parametrize("authorization", [None, "Bearer malformed-token"])
def test_admin_order_routes_reject_missing_or_malformed_tokens(
    admin_client: AdminClient,
    path: str,
    authorization: str | None,
) -> None:
    """Protect both routes with the stable AdminBearer failure contract."""
    headers = {"Authorization": authorization} if authorization is not None else {}
    response = admin_client.client.get(path, headers=headers)
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication credentials"}
    assert response.headers["WWW-Authenticate"] == "Bearer"


@pytest.mark.parametrize(
    "path",
    [LIST_PATH, DETAIL_PATH.format(public_order_number="ROA-ZZZZZZZZZZZZ")],
)
def test_admin_order_routes_reject_inactive_admin(
    admin_client: AdminClient,
    token_service: AdminTokenService,
    path: str,
) -> None:
    """Reject a valid token after its administrator becomes inactive."""
    inactive_id = _store_admin(
        admin_client.session_factory,
        email="inactive-orders-admin@example.com",
        is_active=False,
    )
    token = token_service.create_access_token(inactive_id)
    response = admin_client.client.get(
        path,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication credentials"}
    assert response.headers["WWW-Authenticate"] == "Bearer"


@pytest.mark.parametrize(
    "path",
    [LIST_PATH, DETAIL_PATH.format(public_order_number="ROA-ZZZZZZZZZZZZ")],
)
def test_admin_order_routes_report_unavailable_authentication(
    admin_session_factory: sessionmaker[Session],
    path: str,
) -> None:
    """Preserve the existing unavailable authentication service response."""
    application = _application(admin_session_factory, None)
    with TestClient(application) as client:
        response = client.get(path)
    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}


def test_empty_order_list_uses_default_page(admin_client: AdminClient) -> None:
    """Return an exact empty response to a valid administrator."""
    response = admin_client.client.get(LIST_PATH, headers=admin_client.headers)
    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0, "limit": 50, "offset": 0}


def test_order_list_is_filtered_paginated_and_deterministic(
    admin_client: AdminClient,
) -> None:
    """Apply exact filters before a stable newest-first page slice."""
    _, created_takeaway = _store_list_order(
        admin_client.session_factory,
        created_at=FIXED_NOW,
        total_amount=1001,
    )
    _, accepted_takeaway = _store_list_order(
        admin_client.session_factory,
        status=OrderStatus.ACCEPTED,
        created_at=FIXED_NOW + timedelta(minutes=1),
        total_amount=1002,
    )
    _, created_dine_in = _store_list_order(
        admin_client.session_factory,
        order_type=OrderType.DINE_IN,
        created_at=FIXED_NOW + timedelta(minutes=2),
        total_amount=1003,
    )

    response = admin_client.client.get(LIST_PATH, headers=admin_client.headers)
    assert response.status_code == 200
    assert [item["public_order_number"] for item in response.json()["items"]] == [
        created_dine_in,
        accepted_takeaway,
        created_takeaway,
    ]

    status_response = admin_client.client.get(
        LIST_PATH,
        params={"status": "created"},
        headers=admin_client.headers,
    )
    assert status_response.json()["total"] == 2

    type_response = admin_client.client.get(
        LIST_PATH,
        params={"order_type": "takeaway"},
        headers=admin_client.headers,
    )
    assert type_response.json()["total"] == 2

    combined_response = admin_client.client.get(
        LIST_PATH,
        params={
            "status": "created",
            "order_type": "takeaway",
            "limit": 1,
            "offset": 0,
        },
        headers=admin_client.headers,
    )
    assert combined_response.json()["total"] == 1
    assert [
        item["public_order_number"] for item in combined_response.json()["items"]
    ] == [created_takeaway]

    page_response = admin_client.client.get(
        LIST_PATH,
        params={"limit": 1, "offset": 1},
        headers=admin_client.headers,
    )
    assert page_response.json()["total"] == 3
    assert page_response.json()["limit"] == 1
    assert page_response.json()["offset"] == 1
    assert [item["public_order_number"] for item in page_response.json()["items"]] == [
        accepted_takeaway
    ]


def test_order_list_exposes_exact_safe_fields(admin_client: AdminClient) -> None:
    """Exclude internal and financial-provider data from list items."""
    customer_id, customer_email = _store_customer(admin_client.session_factory)
    order_id, _ = _store_list_order(
        admin_client.session_factory,
        customer_user_id=customer_id,
    )
    response = admin_client.client.get(LIST_PATH, headers=admin_client.headers)
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert set(item) == {
        "public_order_number",
        "status",
        "order_type",
        "table_number",
        "total_amount",
        "currency",
        "created_at",
        "updated_at",
    }
    assert str(order_id) not in response.text
    assert str(customer_id) not in response.text
    assert customer_email not in response.text
    assert _response_keys(response.json()).isdisjoint(
        {
            "customer_user_id",
            "owner_id",
            "user_id",
            "customer_email",
            "email",
            "ownership",
            "account",
            "guest_access_token",
            "guest_access_token_hash",
        }
    )
    assert all(
        forbidden not in response.text.lower()
        for forbidden in ("payment", "stripe", "token", "authorization")
    )


@pytest.mark.parametrize(
    "params",
    [
        {"status": "unknown"},
        {"order_type": "delivery"},
        {"limit": "0"},
        {"limit": "101"},
        {"limit": "not-an-integer"},
        {"offset": "-1"},
        {"offset": "not-an-integer"},
    ],
)
def test_order_list_rejects_invalid_filters_before_domain_queries(
    admin_client: AdminClient,
    params: dict[str, str],
) -> None:
    """Return 422 rather than silently accepting invalid query values."""
    response = admin_client.client.get(
        LIST_PATH,
        params=params,
        headers=admin_client.headers,
    )
    assert response.status_code == 422


def test_list_service_executes_exactly_two_selects_and_no_dml(
    admin_client: AdminClient,
    test_database_engine: Engine,
) -> None:
    """Use one count and one page query without loading child collections."""
    _store_list_order(admin_client.session_factory)
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
        with admin_client.session_factory() as session:
            result = list_admin_orders(
                session,
                status=None,
                order_type=None,
                limit=50,
                offset=0,
            )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    verbs = [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ]
    assert result.total == 1
    assert verbs == ["SELECT", "SELECT"]


def test_admin_order_detail_returns_ordered_snapshot_history_and_payments(
    admin_client: AdminClient,
) -> None:
    """Return the exact detached detail contract with limited payment fields."""
    customer_id, customer_email = _store_customer(admin_client.session_factory)
    stored = _store_detail_order(
        admin_client.session_factory,
        customer_user_id=customer_id,
    )
    response = admin_client.client.get(
        DETAIL_PATH.format(public_order_number=stored.public_order_number),
        headers=admin_client.headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "order_id",
        "public_order_number",
        "status",
        "order_type",
        "table_number",
        "currency",
        "subtotal_amount",
        "total_amount",
        "created_at",
        "updated_at",
        "items",
        "status_history",
        "payments",
    }
    assert body["order_id"] == str(stored.order_id)
    assert body["public_order_number"] == stored.public_order_number
    assert body["table_number"] == 7
    assert [item["position"] for item in body["items"]] == [0, 1]
    assert body["items"][0] == {
        "id": body["items"][0]["id"],
        "menu_item_id": str(stored.first_menu_item_id),
        "position": 0,
        "category_name": "Historical Category",
        "name": "Historical First Item",
        "quantity": 2,
        "unit_price_amount": 100,
        "unit_cost_amount": 70,
        "tax_rate_bps": 2500,
        "discount_amount": 0,
        "line_total_amount": 200,
    }
    assert [entry["sequence"] for entry in body["status_history"]] == [0, 1]
    assert body["status_history"][0]["previous_status"] is None
    assert body["status_history"][0]["new_status"] == "created"
    assert [payment["id"] for payment in body["payments"]] == [
        str(stored.payment_ids[1]),
        str(stored.payment_ids[2]),
        str(stored.payment_ids[0]),
    ]
    assert set(body["payments"][0]) == {
        "id",
        "status",
        "amount",
        "currency",
        "created_at",
        "updated_at",
        "checkout_expires_at",
    }
    assert body["payments"][2]["checkout_expires_at"] is not None
    assert str(customer_id) not in response.text
    assert customer_email not in response.text
    assert _response_keys(body).isdisjoint(
        {
            "customer_user_id",
            "owner_id",
            "user_id",
            "customer_email",
            "email",
            "ownership",
            "account",
            "guest_access_token",
            "guest_access_token_hash",
        }
    )

    response_text = response.text.lower()
    assert all(
        forbidden not in response_text
        for forbidden in (
            "order_access_token",
            "token_hash",
            "stripe_checkout_session_id",
            "stripe_checkout_url",
            "stripe_idempotency_key",
            "request_idempotency_key",
            "stripe_event",
        )
    )


@pytest.mark.parametrize("public_order_number", ["ROA-ZZZZZZZZZZZZ", "malformed"])
def test_unknown_and_malformed_order_numbers_share_one_404(
    admin_client: AdminClient,
    public_order_number: str,
) -> None:
    """Avoid a separate path-validation response for malformed identifiers."""
    response = admin_client.client.get(
        DETAIL_PATH.format(public_order_number=public_order_number),
        headers=admin_client.headers,
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "Order not found"}


def test_detail_service_executes_four_selects_and_no_dml(
    admin_client: AdminClient,
    test_database_engine: Engine,
) -> None:
    """Read header and three ordered collections without N+1 queries."""
    stored = _store_detail_order(admin_client.session_factory)
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
        with admin_client.session_factory() as session:
            detail = get_admin_order(
                session,
                public_order_number=stored.public_order_number,
            )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    verbs = [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ]
    assert detail.order_id == stored.order_id
    assert verbs == ["SELECT", "SELECT", "SELECT", "SELECT"]


def test_unknown_detail_executes_one_select_and_no_dml(
    admin_client: AdminClient,
    test_database_engine: Engine,
) -> None:
    """Stop after the header lookup for an unknown order number."""
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
        with admin_client.session_factory() as session:
            with pytest.raises(AdminOrderNotFoundError):
                get_admin_order(
                    session,
                    public_order_number="ROA-ZZZZZZZZZZZZ",
                )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    assert [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ] == ["SELECT"]


def test_admin_detail_uses_immutable_order_item_snapshots(
    admin_client: AdminClient,
) -> None:
    """Ignore current category and menu changes when reading historical lines."""
    stored = _store_detail_order(admin_client.session_factory)
    with admin_client.session_factory.begin() as session:
        category = session.get(Category, stored.category_id)
        first_item = session.get(MenuItem, stored.first_menu_item_id)
        second_item = session.get(MenuItem, stored.second_menu_item_id)
        assert category is not None
        assert first_item is not None
        assert second_item is not None
        category.name = "Changed Current Category"
        first_item.name = "Changed Current First Item"
        first_item.price_amount = 7777
        first_item.cost_amount = 3333
        second_item.name = "Changed Current Second Item"

    response = admin_client.client.get(
        DETAIL_PATH.format(public_order_number=stored.public_order_number),
        headers=admin_client.headers,
    )
    assert response.status_code == 200
    items = response.json()["items"]
    assert [(item["category_name"], item["name"]) for item in items] == [
        ("Historical Category", "Historical First Item"),
        ("Historical Category", "Historical Second Item"),
    ]
    assert items[0]["unit_price_amount"] == 100
    assert items[0]["unit_cost_amount"] == 70


def test_status_patch_requires_admin_and_validates_exact_body(
    admin_client: AdminClient,
    token_service: AdminTokenService,
) -> None:
    """Protect the mutation route and reject every invalid request shape."""
    stored = _store_transition_order(admin_client.session_factory)
    path = _transition_path(stored.public_order_number)

    missing_auth = admin_client.client.patch(path, json={"status": "cancelled"})
    assert missing_auth.status_code == 401
    assert missing_auth.json() == {"detail": "Invalid authentication credentials"}
    assert missing_auth.headers["WWW-Authenticate"] == "Bearer"

    malformed_auth = admin_client.client.patch(
        path,
        json={"status": "cancelled"},
        headers={"Authorization": "Bearer malformed-token"},
    )
    assert malformed_auth.status_code == 401

    inactive_id = _store_admin(
        admin_client.session_factory,
        email="inactive-transition-admin@example.com",
        is_active=False,
    )
    inactive_auth = admin_client.client.patch(
        path,
        json={"status": "cancelled"},
        headers={
            "Authorization": f"Bearer {token_service.create_access_token(inactive_id)}"
        },
    )
    assert inactive_auth.status_code == 401
    assert inactive_auth.json() == {"detail": "Invalid authentication credentials"}

    for payload in ({}, {"status": "unknown"}, {"status": "cancelled", "extra": 1}):
        response = admin_client.client.patch(
            path,
            json=payload,
            headers=admin_client.headers,
        )
        assert response.status_code == 422


@pytest.mark.parametrize("public_order_number", ["ROA-ZZZZZZZZZZZZ", "malformed"])
def test_status_patch_unknown_and_malformed_order_share_one_404(
    admin_client: AdminClient,
    public_order_number: str,
) -> None:
    """Keep the administrator mutation lookup response stable and simple."""
    response = admin_client.client.patch(
        _transition_path(public_order_number),
        json={"status": "cancelled"},
        headers=admin_client.headers,
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "Order not found"}


@pytest.mark.parametrize(
    ("current_status", "target_status", "payment_statuses"),
    [
        (
            OrderStatus.CREATED,
            OrderStatus.ACCEPTED,
            (PaymentStatus.SUCCEEDED,),
        ),
        (OrderStatus.CREATED, OrderStatus.CANCELLED, ()),
        (OrderStatus.ACCEPTED, OrderStatus.PREPARING, ()),
        (OrderStatus.PREPARING, OrderStatus.READY, ()),
        (OrderStatus.READY, OrderStatus.COMPLETED, ()),
    ],
)
def test_each_allowed_status_transition_is_atomic_and_appends_one_history_entry(
    admin_client: AdminClient,
    current_status: OrderStatus,
    target_status: OrderStatus,
    payment_statuses: tuple[PaymentStatus, ...],
) -> None:
    """Apply every graph edge with one exact durable history append."""
    customer_id, customer_email = _store_customer(admin_client.session_factory)
    stored = _store_transition_order(
        admin_client.session_factory,
        current_status=current_status,
        payment_statuses=payment_statuses,
        customer_user_id=customer_id,
    )
    _, before_history, before_payments = _stored_transition_state(
        admin_client.session_factory,
        stored,
    )

    response = admin_client.client.patch(
        _transition_path(stored.public_order_number),
        json={"status": target_status.value},
        headers=admin_client.headers,
    )

    assert response.status_code == 200
    assert set(response.json()) == {
        "public_order_number",
        "status",
        "updated_at",
        "history",
    }
    body = response.json()
    assert body["public_order_number"] == stored.public_order_number
    assert body["status"] == target_status.value
    assert set(body["history"]) == {
        "sequence",
        "previous_status",
        "new_status",
        "changed_at",
    }
    assert body["history"]["sequence"] == len(before_history)
    assert body["history"]["previous_status"] == current_status.value
    assert body["history"]["new_status"] == target_status.value
    assert datetime.fromisoformat(body["updated_at"]) > FIXED_NOW - timedelta(days=365)
    assert str(customer_id) not in response.text
    assert customer_email not in response.text
    assert _response_keys(body).isdisjoint(
        {
            "customer_user_id",
            "owner_id",
            "user_id",
            "customer_email",
            "email",
            "ownership",
            "account",
            "guest_access_token",
            "guest_access_token_hash",
        }
    )

    stored_status, after_history, after_payments = _stored_transition_state(
        admin_client.session_factory,
        stored,
    )
    assert stored_status == target_status.value
    assert [entry.sequence for entry in after_history] == list(
        range(len(before_history) + 1)
    )
    assert len(after_history) == len(before_history) + 1
    assert after_history[-1].previous_status == current_status.value
    assert after_history[-1].new_status == target_status.value
    assert after_payments == before_payments
    with admin_client.session_factory() as session:
        order = session.get(Order, stored.order_id)
        assert order is not None
        assert order.customer_user_id == customer_id


@pytest.mark.parametrize(
    ("current_status", "target_status"),
    [
        (OrderStatus.CREATED, OrderStatus.PREPARING),
        (OrderStatus.CREATED, OrderStatus.READY),
        (OrderStatus.CREATED, OrderStatus.COMPLETED),
        (OrderStatus.ACCEPTED, OrderStatus.ACCEPTED),
        (OrderStatus.ACCEPTED, OrderStatus.READY),
        (OrderStatus.PREPARING, OrderStatus.ACCEPTED),
        (OrderStatus.READY, OrderStatus.PREPARING),
        (OrderStatus.COMPLETED, OrderStatus.CREATED),
        (OrderStatus.COMPLETED, OrderStatus.CANCELLED),
        (OrderStatus.CANCELLED, OrderStatus.CREATED),
    ],
)
def test_invalid_status_transitions_never_write(
    admin_client: AdminClient,
    current_status: OrderStatus,
    target_status: OrderStatus,
) -> None:
    """Reject repeats, skips, reversals, and terminal exits without mutation."""
    stored = _store_transition_order(
        admin_client.session_factory,
        current_status=current_status,
        payment_statuses=(
            (PaymentStatus.SUCCEEDED,) if current_status is OrderStatus.CREATED else ()
        ),
    )
    before = _stored_transition_state(admin_client.session_factory, stored)
    response = admin_client.client.patch(
        _transition_path(stored.public_order_number),
        json={"status": target_status.value},
        headers=admin_client.headers,
    )
    assert response.status_code == 409
    assert response.json() == {"detail": "Invalid order status transition"}
    after = _stored_transition_state(admin_client.session_factory, stored)
    assert after == before


@pytest.mark.parametrize(
    ("payment_statuses", "expected_status"),
    [
        ((), 409),
        ((PaymentStatus.PENDING,), 409),
        ((PaymentStatus.FAILED,), 409),
        ((PaymentStatus.EXPIRED,), 409),
        ((PaymentStatus.FAILED, PaymentStatus.EXPIRED), 409),
        ((PaymentStatus.SUCCEEDED,), 200),
        ((PaymentStatus.SUCCEEDED, PaymentStatus.FAILED), 200),
        ((PaymentStatus.SUCCEEDED, PaymentStatus.EXPIRED), 200),
    ],
)
def test_acceptance_requires_at_least_one_succeeded_payment(
    admin_client: AdminClient,
    payment_statuses: tuple[PaymentStatus, ...],
    expected_status: int,
) -> None:
    """Accept only a created order with persisted webhook-confirmed payment."""
    stored = _store_transition_order(
        admin_client.session_factory,
        payment_statuses=payment_statuses,
    )
    _, _, before_payments = _stored_transition_state(
        admin_client.session_factory,
        stored,
    )
    response = admin_client.client.patch(
        _transition_path(stored.public_order_number),
        json={"status": "accepted"},
        headers=admin_client.headers,
    )
    assert response.status_code == expected_status
    if expected_status == 409:
        assert response.json() == {"detail": "Order is not paid"}
    status_value, history, after_payments = _stored_transition_state(
        admin_client.session_factory,
        stored,
    )
    assert status_value == (
        OrderStatus.ACCEPTED.value
        if expected_status == 200
        else OrderStatus.CREATED.value
    )
    assert len(history) == (2 if expected_status == 200 else 1)
    assert after_payments == before_payments


@pytest.mark.parametrize(
    ("payment_statuses", "expected_status", "expected_detail"),
    [
        ((), 200, None),
        ((PaymentStatus.FAILED,), 200, None),
        ((PaymentStatus.EXPIRED,), 200, None),
        ((PaymentStatus.FAILED, PaymentStatus.EXPIRED), 200, None),
        ((PaymentStatus.PENDING,), 409, "Active payment attempt exists"),
        ((PaymentStatus.SUCCEEDED,), 409, "Order cannot be cancelled"),
        (
            (PaymentStatus.PENDING, PaymentStatus.SUCCEEDED),
            409,
            "Order cannot be cancelled",
        ),
        (
            (
                PaymentStatus.FAILED,
                PaymentStatus.EXPIRED,
                PaymentStatus.FAILED,
                PaymentStatus.EXPIRED,
            ),
            200,
            None,
        ),
    ],
)
def test_cancellation_uses_persisted_payment_attempt_policy(
    admin_client: AdminClient,
    payment_statuses: tuple[PaymentStatus, ...],
    expected_status: int,
    expected_detail: str | None,
) -> None:
    """Apply D-016 with succeeded taking precedence over pending conflicts."""
    stored = _store_transition_order(
        admin_client.session_factory,
        payment_statuses=payment_statuses,
    )
    _, _, before_payments = _stored_transition_state(
        admin_client.session_factory,
        stored,
    )
    response = admin_client.client.patch(
        _transition_path(stored.public_order_number),
        json={"status": "cancelled"},
        headers=admin_client.headers,
    )
    assert response.status_code == expected_status
    if expected_detail is not None:
        assert response.json() == {"detail": expected_detail}
    status_value, history, after_payments = _stored_transition_state(
        admin_client.session_factory,
        stored,
    )
    assert status_value == (
        OrderStatus.CANCELLED.value
        if expected_status == 200
        else OrderStatus.CREATED.value
    )
    assert len(history) == (2 if expected_status == 200 else 1)
    assert after_payments == before_payments


def test_invalid_graph_transition_does_not_query_payments_or_write(
    admin_client: AdminClient,
    test_database_engine: Engine,
) -> None:
    """Evaluate graph validity immediately after the mandatory Order lock."""
    stored = _store_transition_order(
        admin_client.session_factory,
        payment_statuses=(PaymentStatus.SUCCEEDED,),
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
        statements.append(" ".join(statement.lower().split()))

    event.listen(test_database_engine, "before_cursor_execute", capture)
    try:
        with admin_client.session_factory() as session:
            with pytest.raises(AdminOrderInvalidTransitionError):
                transition_order_status(
                    session,
                    public_order_number=stored.public_order_number,
                    target_status=OrderStatus.READY,
                )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    assert len(statements) == 1
    assert " from orders " in statements[0]
    assert "for update" in statements[0]
    assert all(" payments " not in statement for statement in statements)
    assert all(
        not statement.startswith(("insert", "update", "delete"))
        for statement in statements
    )


@pytest.mark.parametrize(
    ("current_status", "target_status", "payment_statuses", "payment_lock_expected"),
    [
        (OrderStatus.ACCEPTED, OrderStatus.PREPARING, (), False),
        (
            OrderStatus.CREATED,
            OrderStatus.ACCEPTED,
            (PaymentStatus.SUCCEEDED,),
            True,
        ),
    ],
)
def test_transition_sql_uses_required_locks_and_exact_dml_classes(
    admin_client: AdminClient,
    test_database_engine: Engine,
    current_status: OrderStatus,
    target_status: OrderStatus,
    payment_statuses: tuple[PaymentStatus, ...],
    payment_lock_expected: bool,
) -> None:
    """Lock Order first and write only Order plus one history entry."""
    stored = _store_transition_order(
        admin_client.session_factory,
        current_status=current_status,
        payment_statuses=payment_statuses,
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
        statements.append(" ".join(statement.lower().split()))

    event.listen(test_database_engine, "before_cursor_execute", capture)
    try:
        with admin_client.session_factory() as session:
            transition_order_status(
                session,
                public_order_number=stored.public_order_number,
                target_status=target_status,
            )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    lock_statements = [
        statement for statement in statements if "for update" in statement
    ]
    assert " from orders " in lock_statements[0]
    payment_locks = [
        statement for statement in lock_statements if " from payments " in statement
    ]
    assert bool(payment_locks) is payment_lock_expected
    if payment_locks:
        assert "order by payments.created_at asc, payments.id asc" in payment_locks[0]
    assert sum(statement.startswith("update orders ") for statement in statements) == 1
    assert (
        sum(
            statement.startswith("insert into order_status_history")
            for statement in statements
        )
        == 1
    )
    assert all(not statement.startswith("update payments ") for statement in statements)


def test_openapi_documents_exact_status_patch_contract(
    admin_client: AdminClient,
) -> None:
    """Expose one protected PATCH without a separate cancellation route."""
    document = admin_client.client.get("/openapi.json").json()
    path = "/api/v1/admin/orders/{public_order_number}/status"
    assert set(document["paths"][path]) == {"patch"}
    operation = document["paths"][path]["patch"]
    assert operation["tags"] == ["admin-orders"]
    assert operation["summary"] == "Update administrator order status"
    assert operation["security"] == [{"AdminBearer": []}]
    assert operation["requestBody"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/AdminOrderStatusUpdateRequest")
    assert operation["responses"]["200"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/AdminOrderStatusUpdateResponse")
    assert {"200", "401", "404", "409", "422", "503"} <= set(operation["responses"])
    assert "/api/v1/admin/orders/{public_order_number}/cancel" not in document["paths"]
    assert "/api/v1/stripe/webhook" not in document["paths"]
