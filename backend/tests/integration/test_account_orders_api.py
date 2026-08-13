"""Integration tests for strict canonical customer account Order reads."""

from __future__ import annotations

from collections.abc import Generator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete, event
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.service import USER_AUDIENCE, USER_TOKEN_TYPE, UserTokenService
from app.auth.tokens import ALGORITHM, ISSUER, AdminTokenService
from app.categories.models import Category
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app
from app.menu.models import MenuItem
from app.orders.access import (
    generate_order_access_token,
    generate_public_order_number,
    hash_order_access_token,
)
from app.orders.account_service import get_account_order, list_account_orders
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.statuses import OrderStatus
from app.payments.models import Payment
from app.payments.statuses import PaymentStatus
from app.payments.stripe_checkout import build_stripe_idempotency_key
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration

LIST_PATH = "/api/v1/account/orders"
DETAIL_PATH = "/api/v1/account/orders/{public_order_number}"
PUBLIC_STATUS_PATH = "/api/v1/orders/{public_order_number}"
SYNTHETIC_SECRET = "a" * 32
OTHER_SYNTHETIC_SECRET = "o" * 32
FIXED_NOW = datetime(2026, 8, 13, 12, tzinfo=UTC)
ISSUED_AT = int(FIXED_NOW.timestamp())


@dataclass(frozen=True)
class StoredOrder:
    """Carry detached values needed by account API assertions."""

    id: UUID
    public_order_number: str
    raw_access_token: str
    menu_item_id: UUID
    total_amount: int
    currency: str
    created_at: datetime


@pytest.fixture(autouse=True)
def empty_account_tables(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep account tests isolated in the exact guarded test database."""
    _clear_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_tables(test_database_engine)


@pytest.fixture
def account_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create request sessions bound only to the isolated test database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def user_token_service() -> UserTokenService:
    """Create deterministic strict canonical signing for account tests."""
    return UserTokenService(SYNTHETIC_SECRET, now_provider=lambda: FIXED_NOW)


@pytest.fixture
def menu_item_id(account_session_factory: sessionmaker[Session]) -> UUID:
    """Store one catalog record used only as an OrderItem foreign-key target."""
    with account_session_factory.begin() as session:
        category = Category(name=f"Account category {uuid4().hex}")
        item = MenuItem(
            category=category,
            name="Current account item",
            price_amount=1500,
            cost_amount=500,
            currency="NOK",
        )
        session.add_all([category, item])
        session.flush()
        return item.id


@pytest.fixture
def client(
    account_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> Generator[TestClient, None, None]:
    """Run account routes with strict synthetic canonical authentication."""
    with TestClient(
        _application(
            account_session_factory,
            user_token_service=user_token_service,
        )
    ) as test_client:
        yield test_client


def _application(
    session_factory: sessionmaker[Session],
    *,
    user_token_service: UserTokenService | None,
) -> FastAPI:
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
        ),
        session_factory=session_factory,
        user_token_service=user_token_service,
    )


def _clear_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(delete(Payment))
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))
        connection.execute(delete(User))
        connection.execute(delete(RestaurantTable))
        connection.execute(delete(MenuItem))
        connection.execute(delete(Category))


def _store_user(
    session_factory: sessionmaker[Session],
    *,
    role: UserRole = UserRole.CUSTOMER,
    is_active: bool = True,
) -> UUID:
    with session_factory.begin() as session:
        user = User(
            email=f"account-{role.value}-{uuid4().hex}@example.com",
            password_hash="synthetic-account-password-hash",
            role=role,
            is_active=is_active,
        )
        session.add(user)
        session.flush()
        return user.id


def _store_order(
    session_factory: sessionmaker[Session],
    menu_item_id: UUID,
    *,
    customer_user_id: UUID | None,
    order_id: UUID | None = None,
    created_at: datetime = FIXED_NOW,
    total_amount: int = 1500,
    currency: str = "NOK",
) -> StoredOrder:
    raw_access_token = generate_order_access_token()
    order = Order(
        id=order_id or uuid4(),
        public_order_number=generate_public_order_number(),
        order_access_token_hash=hash_order_access_token(raw_access_token),
        customer_user_id=customer_user_id,
        order_type="takeaway",
        table_id=None,
        table_number_snapshot=None,
        status=OrderStatus.CREATED.value,
        currency=currency,
        subtotal_amount=total_amount,
        total_amount=total_amount,
        created_at=created_at,
        updated_at=created_at,
    )
    item = OrderItem(
        order=order,
        menu_item_id=menu_item_id,
        position=0,
        category_name_snapshot="Historical account category",
        name_snapshot="Historical account item",
        quantity=1,
        unit_price_amount=total_amount,
        unit_cost_amount=500,
        tax_rate_bps_snapshot=None,
        discount_amount_snapshot=0,
        line_total_amount=total_amount,
    )
    history = OrderStatusHistory(
        order=order,
        sequence=0,
        previous_status=None,
        new_status=OrderStatus.CREATED.value,
        changed_at=created_at,
    )
    with session_factory.begin() as session:
        session.add_all([order, item, history])
        session.flush()
        stored_order = StoredOrder(
            id=order.id,
            public_order_number=order.public_order_number,
            raw_access_token=raw_access_token,
            menu_item_id=menu_item_id,
            total_amount=total_amount,
            currency=currency,
            created_at=created_at,
        )
    return stored_order


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _signed_canonical_token(
    user_id: UUID,
    *,
    secret: str = SYNTHETIC_SECRET,
    **overrides: object,
) -> str:
    claims: dict[str, object] = {
        "sub": str(user_id),
        "type": USER_TOKEN_TYPE,
        "iat": ISSUED_AT,
        "exp": ISSUED_AT + 1800,
        "iss": ISSUER,
        "aud": USER_AUDIENCE,
    }
    claims.update(overrides)
    return jwt.encode(claims, secret, algorithm=ALGORITHM)


def _detail_path(stored: StoredOrder) -> str:
    return DETAIL_PATH.format(public_order_number=stored.public_order_number)


@pytest.mark.parametrize("route_kind", ["list", "detail"])
def test_account_routes_require_strict_canonical_current_user(
    account_session_factory: sessionmaker[Session],
    menu_item_id: UUID,
    user_token_service: UserTokenService,
    route_kind: str,
) -> None:
    """Reject every absent, invalid, legacy, inactive, or missing identity."""
    owner_id = _store_user(account_session_factory)
    inactive_id = _store_user(account_session_factory, is_active=False)
    stored = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=owner_id,
    )
    legacy_service = AdminTokenService(
        SYNTHETIC_SECRET,
        now_provider=lambda: FIXED_NOW,
    )
    authorization_values: list[str | None] = [
        None,
        "Basic credentials",
        "Bearer not-a-jwt",
        f"Bearer {_signed_canonical_token(owner_id, iat=ISSUED_AT - 1800, exp=ISSUED_AT - 1)}",
        f"Bearer {_signed_canonical_token(owner_id, iss='wrong-issuer')}",
        f"Bearer {_signed_canonical_token(owner_id, aud='wrong-audience')}",
        f"Bearer {_signed_canonical_token(owner_id, secret=OTHER_SYNTHETIC_SECRET)}",
        f"Bearer {legacy_service.create_access_token(owner_id)}",
        f"Bearer {user_token_service.create_access_token(inactive_id)}",
        f"Bearer {user_token_service.create_access_token(uuid4())}",
    ]
    path = LIST_PATH if route_kind == "list" else _detail_path(stored)
    application = _application(
        account_session_factory,
        user_token_service=user_token_service,
    )

    with TestClient(application) as test_client:
        for authorization in authorization_values:
            headers = {"X-Order-Access-Token": stored.raw_access_token}
            if authorization is not None:
                headers["Authorization"] = authorization
            response = test_client.get(path, headers=headers)
            assert response.status_code == 401
            assert response.json() == {"detail": "Invalid authentication credentials"}
            assert response.headers["WWW-Authenticate"] == "Bearer"


@pytest.mark.parametrize(
    "role",
    [UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN],
)
def test_each_active_role_sees_only_personally_owned_orders(
    account_session_factory: sessionmaker[Session],
    menu_item_id: UUID,
    user_token_service: UserTokenService,
    role: UserRole,
) -> None:
    """Keep personal account scope role-neutral without administrator bypass."""
    current_user_id = _store_user(account_session_factory, role=role)
    other_user_id = _store_user(account_session_factory)
    own = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=current_user_id,
    )
    other = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=other_user_id,
    )
    unowned = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=None,
    )
    headers = _authorization(user_token_service.create_access_token(current_user_id))
    application = _application(
        account_session_factory,
        user_token_service=user_token_service,
    )

    with TestClient(application) as test_client:
        listed = test_client.get(LIST_PATH, headers=headers)
        own_detail = test_client.get(_detail_path(own), headers=headers)
        other_detail = test_client.get(_detail_path(other), headers=headers)
        unowned_detail = test_client.get(_detail_path(unowned), headers=headers)

    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert [item["public_order_number"] for item in listed.json()["items"]] == [
        own.public_order_number
    ]
    assert own_detail.status_code == 200
    for hidden in (other_detail, unowned_detail):
        assert hidden.status_code == 404
        assert hidden.status_code != 403
        assert hidden.json() == {"detail": "Order not found"}


def test_account_list_empty_response_uses_exact_default_envelope(
    client: TestClient,
    account_session_factory: sessionmaker[Session],
    menu_item_id: UUID,
    user_token_service: UserTokenService,
) -> None:
    """Return exact default pagination while excluding other and unowned Orders."""
    current_user_id = _store_user(account_session_factory)
    other_user_id = _store_user(account_session_factory)
    _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=other_user_id,
    )
    _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=None,
    )

    response = client.get(
        LIST_PATH,
        headers=_authorization(user_token_service.create_access_token(current_user_id)),
    )
    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0, "limit": 50, "offset": 0}


def test_account_list_pagination_ordering_total_and_money_are_exact(
    client: TestClient,
    account_session_factory: sessionmaker[Session],
    menu_item_id: UUID,
    user_token_service: UserTokenService,
) -> None:
    """Use persisted money and deterministic created-at then UUID ordering."""
    owner_id = _store_user(account_session_factory)
    other_id = _store_user(account_session_factory)
    older = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=owner_id,
        order_id=UUID("00000000-0000-4000-8000-000000000001"),
        created_at=FIXED_NOW - timedelta(days=1),
        total_amount=1100,
    )
    tied_lower = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=owner_id,
        order_id=UUID("00000000-0000-4000-8000-000000000002"),
        total_amount=2200,
        currency="USD",
    )
    tied_higher = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=owner_id,
        order_id=UUID("00000000-0000-4000-8000-000000000003"),
        total_amount=3300,
    )
    _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=other_id,
        total_amount=9999,
    )
    headers = _authorization(user_token_service.create_access_token(owner_id))

    first = client.get(f"{LIST_PATH}?limit=1&offset=0", headers=headers)
    second = client.get(f"{LIST_PATH}?limit=1&offset=1", headers=headers)
    complete = client.get(f"{LIST_PATH}?limit=100&offset=0", headers=headers)

    assert [response.status_code for response in (first, second, complete)] == [
        200,
        200,
        200,
    ]
    assert first.json()["total"] == second.json()["total"] == 3
    assert first.json()["items"][0]["public_order_number"] == (
        tied_higher.public_order_number
    )
    assert second.json()["items"][0]["public_order_number"] == (
        tied_lower.public_order_number
    )
    assert [item["public_order_number"] for item in complete.json()["items"]] == [
        tied_higher.public_order_number,
        tied_lower.public_order_number,
        older.public_order_number,
    ]
    assert complete.json()["limit"] == 100
    assert complete.json()["offset"] == 0
    assert set(complete.json()["items"][0]) == {
        "public_order_number",
        "status",
        "order_type",
        "total_amount",
        "currency",
        "created_at",
        "updated_at",
    }
    assert complete.json()["items"][0]["total_amount"] == 3300
    assert complete.json()["items"][1]["total_amount"] == 2200
    assert complete.json()["items"][1]["currency"] == "USD"


def test_account_list_rejects_invalid_pagination(
    client: TestClient,
    account_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Enforce the exact limit and offset bounds at the HTTP boundary."""
    user_id = _store_user(account_session_factory)
    headers = _authorization(user_token_service.create_access_token(user_id))

    for query in ("limit=0", "limit=101", "limit=invalid", "offset=-1", "offset=x"):
        response = client.get(f"{LIST_PATH}?{query}", headers=headers)
        assert response.status_code == 422


def test_account_service_queries_are_owner_scoped_in_sql(
    account_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    menu_item_id: UUID,
) -> None:
    """Put owner predicates in count, page, and detail SQL before row loading."""
    owner_id = _store_user(account_session_factory)
    own = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=owner_id,
    )
    statements: list[tuple[str, object]] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append((statement, parameters))

    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with account_session_factory() as session:
            listed = list_account_orders(
                session,
                current_user_id=owner_id,
                limit=50,
                offset=0,
            )
        list_statements = list(statements)
        statements.clear()
        with account_session_factory() as session:
            detail = get_account_order(
                session,
                current_user_id=owner_id,
                public_order_number=own.public_order_number,
            )
        detail_statements = list(statements)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    assert listed.total == 1
    assert detail.public_order_number == own.public_order_number
    assert len(list_statements) == 2
    assert all(
        "orders.customer_user_id" in statement for statement, _ in list_statements
    )
    assert all(str(owner_id) in str(parameters) for _, parameters in list_statements)
    assert len(detail_statements) == 2
    detail_order_sql, detail_order_parameters = detail_statements[0]
    assert "orders.public_order_number" in detail_order_sql
    assert "orders.customer_user_id" in detail_order_sql
    assert own.public_order_number in str(detail_order_parameters)
    assert str(owner_id) in str(detail_order_parameters)
    assert "order_items.order_id" in detail_statements[1][0]


def test_account_detail_reuses_exact_safe_public_status_response(
    client: TestClient,
    account_session_factory: sessionmaker[Session],
    menu_item_id: UUID,
    user_token_service: UserTokenService,
) -> None:
    """Serialize account and capability detail identically without internals."""
    owner_id = _store_user(account_session_factory)
    stored = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=owner_id,
        total_amount=4200,
    )
    payment_id = uuid4()
    with account_session_factory.begin() as session:
        session.add(
            Payment(
                id=payment_id,
                order_id=stored.id,
                status=PaymentStatus.PENDING.value,
                amount=stored.total_amount,
                currency=stored.currency,
                request_idempotency_key=uuid4(),
                stripe_idempotency_key=build_stripe_idempotency_key(payment_id),
            )
        )

    account_response = client.get(
        _detail_path(stored),
        headers=_authorization(user_token_service.create_access_token(owner_id)),
    )
    public_response = client.get(
        PUBLIC_STATUS_PATH.format(public_order_number=stored.public_order_number),
        headers={"X-Order-Access-Token": stored.raw_access_token},
    )

    assert account_response.status_code == public_response.status_code == 200
    assert account_response.json() == public_response.json()
    account_payload = account_response.json()
    assert set(account_payload) == {
        "public_order_number",
        "status",
        "order_type",
        "table_number",
        "currency",
        "items",
        "subtotal_amount",
        "total_amount",
        "created_at",
        "updated_at",
    }
    assert len(account_payload["items"]) == 1
    assert set(account_payload["items"][0]) == {
        "menu_item_id",
        "name",
        "quantity",
        "unit_price_amount",
        "line_total_amount",
    }


def test_account_detail_uniformly_hides_cross_user_unowned_and_unknown_orders(
    client: TestClient,
    account_session_factory: sessionmaker[Session],
    menu_item_id: UUID,
    user_token_service: UserTokenService,
) -> None:
    """Ignore guest capabilities and return one 404 privacy contract."""
    current_user_id = _store_user(account_session_factory)
    other_user_id = _store_user(account_session_factory)
    other = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=other_user_id,
    )
    unowned = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=None,
    )
    authorization = _authorization(
        user_token_service.create_access_token(current_user_id)
    )
    cases = [
        (_detail_path(other), None),
        (_detail_path(unowned), None),
        (DETAIL_PATH.format(public_order_number="ROA-ZZZZZZZZZZZZ"), None),
        (_detail_path(other), other.raw_access_token),
        (_detail_path(unowned), unowned.raw_access_token),
    ]

    for path, capability in cases:
        headers = dict(authorization)
        if capability is not None:
            headers["X-Order-Access-Token"] = capability
        response = client.get(path, headers=headers)
        assert response.status_code == 404
        assert response.status_code != 403
        assert response.json() == {"detail": "Order not found"}


@pytest.mark.parametrize("route_kind", ["list", "detail"])
def test_account_database_failures_return_safe_503(
    account_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    menu_item_id: UUID,
    user_token_service: UserTokenService,
    route_kind: str,
) -> None:
    """Map only account Order-query failures without masking auth behavior."""
    owner_id = _store_user(account_session_factory)
    stored = _store_order(
        account_session_factory,
        menu_item_id,
        customer_user_id=owner_id,
    )
    application = _application(
        account_session_factory,
        user_token_service=user_token_service,
    )

    def fail_account_query(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if "FROM orders" in statement:
            raise OperationalError(
                "synthetic account statement",
                {},
                RuntimeError("synthetic account database failure"),
            )

    event.listen(test_database_engine, "before_cursor_execute", fail_account_query)
    try:
        with TestClient(application) as test_client:
            response = test_client.get(
                LIST_PATH if route_kind == "list" else _detail_path(stored),
                headers=_authorization(
                    user_token_service.create_access_token(owner_id)
                ),
            )
    finally:
        event.remove(
            test_database_engine,
            "before_cursor_execute",
            fail_account_query,
        )

    assert response.status_code == 503
    assert response.json() == {"detail": "Account order service unavailable"}
    assert "synthetic" not in response.text.lower()
    assert "orders" not in response.text.lower()


def test_openapi_contains_exactly_two_strict_account_order_operations(
    account_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Document only required UserBearer account reads and exact safe schemas."""
    document = _application(
        account_session_factory,
        user_token_service=user_token_service,
    ).openapi()
    account_paths = {
        path: set(operations)
        for path, operations in document["paths"].items()
        if path.startswith("/api/v1/account")
    }
    assert account_paths == {
        LIST_PATH: {"get"},
        "/api/v1/account/orders/{public_order_number}": {"get"},
    }
    list_operation = document["paths"][LIST_PATH]["get"]
    detail_operation = document["paths"][
        "/api/v1/account/orders/{public_order_number}"
    ]["get"]
    for operation in (list_operation, detail_operation):
        assert operation["security"] == [{"UserBearer": []}]
        assert {} not in operation["security"]
        assert {"AdminBearer": []} not in operation["security"]
        assert "X-Order-Access-Token" not in {
            parameter["name"] for parameter in operation.get("parameters", [])
        }
        assert {"200", "401", "503"} <= set(operation["responses"])
    assert "404" in detail_operation["responses"]
    assert list_operation["responses"]["200"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/AccountOrderListResponse")
    assert detail_operation["responses"]["200"]["content"]["application/json"][
        "schema"
    ]["$ref"].endswith("/OrderStatusResponse")
    assert set(
        document["components"]["schemas"]["AccountOrderListItem"]["properties"]
    ) == {
        "public_order_number",
        "status",
        "order_type",
        "total_amount",
        "currency",
        "created_at",
        "updated_at",
    }
    assert set(
        document["components"]["schemas"]["AccountOrderListResponse"]["properties"]
    ) == {"items", "total", "limit", "offset"}
