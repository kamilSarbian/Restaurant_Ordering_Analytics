"""Integration tests for authenticated public order status retrieval."""

from __future__ import annotations

import re
from collections.abc import Generator
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.service import (
    ALGORITHM,
    ISSUER,
    USER_AUDIENCE,
    USER_TOKEN_TYPE,
    UserTokenService,
)
from app.categories.models import Category
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app
from app.menu.models import MenuItem
from app.orders.access import (
    OrderNotFoundError,
    generate_order_access_token,
    generate_public_order_number,
    get_order_status,
    hash_order_access_token,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration

STATUS_PATH = "/api/v1/orders/{public_order_number}"
QUOTE_PATH = "/api/v1/orders/quote"
SYNTHETIC_SECRET = "s" * 32
OTHER_SYNTHETIC_SECRET = "o" * 32
FIXED_NOW = datetime(2026, 8, 13, 12, tzinfo=UTC)
ISSUED_AT = int(FIXED_NOW.timestamp())
LEGACY_ADMIN_AUDIENCE = "restaurant-ordering-analytics-admin"


@dataclass(frozen=True)
class StoredOrder:
    """Hold detached identifiers needed by status integration tests."""

    public_order_number: str
    raw_access_token: str
    order_id: UUID
    first_menu_item_id: UUID
    second_menu_item_id: UUID
    table_id: UUID | None


@pytest.fixture(autouse=True)
def empty_order_status_tables(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep status tests isolated in the exact approved test database."""
    with test_database_engine.begin() as connection:
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))
        connection.execute(delete(User))
        connection.execute(delete(RestaurantTable))
        connection.execute(delete(MenuItem))
        connection.execute(delete(Category))
    try:
        yield
    finally:
        with test_database_engine.begin() as connection:
            connection.execute(delete(OrderStatusHistory))
            connection.execute(delete(OrderItem))
            connection.execute(delete(Order))
            connection.execute(delete(User))
            connection.execute(delete(RestaurantTable))
            connection.execute(delete(MenuItem))
            connection.execute(delete(Category))


@pytest.fixture
def status_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create status sessions bound only to the isolated test database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def client(
    status_session_factory: sessionmaker[Session],
) -> Generator[TestClient, None, None]:
    """Run the app with the isolated test session factory."""
    application = _application(status_session_factory)
    with TestClient(application) as test_client:
        yield test_client


@pytest.fixture
def user_token_service() -> UserTokenService:
    """Create deterministic canonical signing for status access tests."""
    return UserTokenService(SYNTHETIC_SECRET, now_provider=lambda: FIXED_NOW)


def _application(
    session_factory: sessionmaker[Session],
    *,
    user_token_service: UserTokenService | None = None,
):
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
        ),
        session_factory=session_factory,
        user_token_service=user_token_service,
    )


def _store_order(
    session_factory: sessionmaker[Session],
    *,
    dine_in: bool = False,
    customer_user_id: UUID | None = None,
) -> StoredOrder:
    public_order_number = generate_public_order_number()
    raw_access_token = generate_order_access_token()
    with session_factory.begin() as session:
        category = Category(name=f"Status Category {uuid4().hex}")
        first_menu_item = MenuItem(
            category=category,
            name="Current First Name",
            price_amount=125,
            cost_amount=70,
        )
        second_menu_item = MenuItem(
            category=category,
            name="Current Second Name",
            price_amount=300,
            cost_amount=150,
        )
        table = RestaurantTable(number=7) if dine_in else None
        session.add_all(
            [category, first_menu_item, second_menu_item]
            + ([table] if table is not None else [])
        )
        session.flush()

        order = Order(
            public_order_number=public_order_number,
            order_access_token_hash=hash_order_access_token(raw_access_token),
            customer_user_id=customer_user_id,
            order_type="dine_in" if dine_in else "takeaway",
            table_id=table.id if table is not None else None,
            table_number_snapshot=table.number if table is not None else None,
            currency="NOK",
            subtotal_amount=500,
            total_amount=500,
        )
        session.add(order)
        session.flush()

        first_item = OrderItem(
            order=order,
            menu_item_id=first_menu_item.id,
            position=0,
            category_name_snapshot="Historical Category",
            name_snapshot="Historical First",
            quantity=2,
            unit_price_amount=100,
            unit_cost_amount=70,
            tax_rate_bps_snapshot=None,
            discount_amount_snapshot=0,
            line_total_amount=200,
        )
        second_item = OrderItem(
            order=order,
            menu_item_id=second_menu_item.id,
            position=1,
            category_name_snapshot="Historical Category",
            name_snapshot="Historical Second",
            quantity=1,
            unit_price_amount=300,
            unit_cost_amount=150,
            tax_rate_bps_snapshot=None,
            discount_amount_snapshot=0,
            line_total_amount=300,
        )
        history = OrderStatusHistory(
            order=order,
            sequence=0,
            previous_status=None,
            new_status="created",
        )
        # Reverse insertion proves public ordering comes from the position column.
        session.add_all([second_item, first_item, history])
        session.flush()

        result = StoredOrder(
            public_order_number=public_order_number,
            raw_access_token=raw_access_token,
            order_id=order.id,
            first_menu_item_id=first_menu_item.id,
            second_menu_item_id=second_menu_item.id,
            table_id=table.id if table is not None else None,
        )
    return result


def _status_url(stored: StoredOrder) -> str:
    return STATUS_PATH.format(public_order_number=stored.public_order_number)


def _headers(stored: StoredOrder) -> dict[str, str]:
    return {"X-Order-Access-Token": stored.raw_access_token}


def _store_user(
    session_factory: sessionmaker[Session],
    *,
    is_active: bool = True,
) -> UUID:
    with session_factory.begin() as session:
        user = User(
            email=f"status-owner-{uuid4().hex}@example.com",
            password_hash="synthetic-status-owner-password-hash",
            role=UserRole.CUSTOMER,
            is_active=is_active,
        )
        session.add(user)
        session.flush()
        return user.id


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


def test_status_get_returns_exact_public_snapshot(
    client: TestClient,
    status_session_factory: sessionmaker[Session],
) -> None:
    """Return only detached snapshot fields for a valid guest credential."""
    stored = _store_order(status_session_factory)
    response = client.get(_status_url(stored), headers=_headers(stored))
    assert response.status_code == 200
    assert response.json() == {
        "public_order_number": stored.public_order_number,
        "status": "created",
        "order_type": "takeaway",
        "table_number": None,
        "currency": "NOK",
        "items": [
            {
                "menu_item_id": str(stored.first_menu_item_id),
                "name": "Historical First",
                "quantity": 2,
                "unit_price_amount": 100,
                "line_total_amount": 200,
            },
            {
                "menu_item_id": str(stored.second_menu_item_id),
                "name": "Historical Second",
                "quantity": 1,
                "unit_price_amount": 300,
                "line_total_amount": 300,
            },
        ],
        "subtotal_amount": 500,
        "total_amount": 500,
        "created_at": response.json()["created_at"],
        "updated_at": response.json()["updated_at"],
    }
    response_text = response.text.lower()
    assert all(
        forbidden not in response_text
        for forbidden in (
            "order_access_token",
            "token_hash",
            "customer_user_id",
            "owner_id",
            "user_id",
            "email",
            "role",
            "cost",
            "tax",
            "discount",
            "payment_summary",
        )
    )
    assert str(stored.order_id) not in response.text


@pytest.mark.parametrize(
    ("number_kind", "token_kind"),
    [
        ("unknown", "valid"),
        ("existing", "wrong"),
        ("existing", "missing"),
        ("malformed", "valid"),
    ],
)
def test_status_get_hides_all_access_failures(
    client: TestClient,
    status_session_factory: sessionmaker[Session],
    number_kind: str,
    token_kind: str,
) -> None:
    """Return one 404 contract for every invalid number/token combination."""
    stored = _store_order(status_session_factory)
    number = {
        "existing": stored.public_order_number,
        "unknown": "ROA-ZZZZZZZZZZZZ",
        "malformed": "not-a-public-number",
    }[number_kind]
    headers = {
        "valid": _headers(stored),
        "wrong": {"X-Order-Access-Token": "wrong-token"},
        "missing": {},
    }[token_kind]
    response = client.get(
        STATUS_PATH.format(public_order_number=number),
        headers=headers,
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "Order not found"}


def test_status_owner_or_capability_access_matrix(
    status_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Allow the owner or capability while hiding every other access failure."""
    owner_id = _store_user(status_session_factory)
    other_id = _store_user(status_session_factory)
    owned = _store_order(status_session_factory, customer_user_id=owner_id)
    unowned = _store_order(status_session_factory)
    owner_auth = _authorization(user_token_service.create_access_token(owner_id))
    other_auth = _authorization(user_token_service.create_access_token(other_id))
    application = _application(
        status_session_factory,
        user_token_service=user_token_service,
    )
    cases = [
        (owned, owner_auth, None, 200),
        (owned, owner_auth, "wrong-token", 200),
        (owned, owner_auth, owned.raw_access_token, 200),
        (owned, other_auth, owned.raw_access_token, 200),
        (owned, other_auth, None, 404),
        (owned, other_auth, "wrong-token", 404),
        (unowned, other_auth, unowned.raw_access_token, 200),
        (unowned, other_auth, None, 404),
        (unowned, other_auth, "wrong-token", 404),
    ]

    with TestClient(application) as test_client:
        for stored, authorization, capability, expected_status in cases:
            headers = dict(authorization)
            if capability is not None:
                headers["X-Order-Access-Token"] = capability
            response = test_client.get(_status_url(stored), headers=headers)
            assert response.status_code == expected_status
            if expected_status == 200:
                assert response.json()["public_order_number"] == (
                    stored.public_order_number
                )
                assert {
                    "customer_user_id",
                    "owner_id",
                    "user_id",
                    "email",
                    "role",
                }.isdisjoint(response.json())
            else:
                assert response.json() == {"detail": "Order not found"}

        unknown = test_client.get(
            STATUS_PATH.format(public_order_number="ROA-ZZZZZZZZZZZZ"),
            headers=owner_auth,
        )
    assert unknown.status_code == 404
    assert unknown.json() == {"detail": "Order not found"}


def test_invalid_present_authorization_never_falls_back_to_valid_capability(
    status_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Reject every unusable token family before evaluating guest capability."""
    user_id = _store_user(status_session_factory)
    stored = _store_order(status_session_factory, customer_user_id=user_id)
    authorization_values = [
        "",
        "Bearer",
        "Basic credentials",
        "Custom credentials",
        "Bearer not-a-jwt",
        f"Bearer {_signed_canonical_token(user_id, exp=ISSUED_AT)}",
        f"Bearer {_signed_canonical_token(user_id, secret=OTHER_SYNTHETIC_SECRET)}",
        f"Bearer {_signed_canonical_token(user_id, iss='wrong-issuer')}",
        f"Bearer {_signed_canonical_token(user_id, aud='wrong-audience')}",
        f"Bearer {_signed_canonical_token(user_id, type='admin_access')}",
        f"Bearer {_signed_canonical_token(user_id, type='admin_access', aud=LEGACY_ADMIN_AUDIENCE)}",
    ]
    application = _application(
        status_session_factory,
        user_token_service=user_token_service,
    )

    with TestClient(application) as test_client:
        for authorization in authorization_values:
            response = test_client.get(
                _status_url(stored),
                headers={
                    "Authorization": authorization,
                    "X-Order-Access-Token": stored.raw_access_token,
                },
            )
            assert response.status_code == 401
            assert response.json() == {"detail": "Invalid authentication credentials"}
            assert response.headers["WWW-Authenticate"] == "Bearer"


def test_inactive_and_missing_users_never_fall_back_to_valid_capability(
    status_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Require the supplied canonical identity to remain active and present."""
    inactive_id = _store_user(status_session_factory, is_active=False)
    stored = _store_order(status_session_factory)
    application = _application(
        status_session_factory,
        user_token_service=user_token_service,
    )

    with TestClient(application) as test_client:
        for user_id in (inactive_id, uuid4()):
            response = test_client.get(
                _status_url(stored),
                headers={
                    **_authorization(user_token_service.create_access_token(user_id)),
                    "X-Order-Access-Token": stored.raw_access_token,
                },
            )
            assert response.status_code == 401
            assert response.json() == {"detail": "Invalid authentication credentials"}
            assert response.headers["WWW-Authenticate"] == "Bearer"


@pytest.mark.parametrize("failure_kind", ["missing_service", "database"])
def test_status_authentication_failures_are_safe_503_before_capability(
    status_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    user_token_service: UserTokenService,
    failure_kind: str,
) -> None:
    """Map authentication infrastructure failures safely without guest fallback."""
    user_id = _store_user(status_session_factory)
    stored = _store_order(status_session_factory)
    application = _application(
        status_session_factory,
        user_token_service=(
            None if failure_kind == "missing_service" else user_token_service
        ),
    )

    def fail_auth_query(*_: object) -> None:
        raise OperationalError(
            "synthetic authentication query",
            {},
            RuntimeError("synthetic authentication failure"),
        )

    if failure_kind == "database":
        event.listen(test_database_engine, "before_cursor_execute", fail_auth_query)
    try:
        with TestClient(application) as test_client:
            response = test_client.get(
                _status_url(stored),
                headers={
                    **_authorization(user_token_service.create_access_token(user_id)),
                    "X-Order-Access-Token": stored.raw_access_token,
                },
            )
    finally:
        if failure_kind == "database":
            event.remove(
                test_database_engine,
                "before_cursor_execute",
                fail_auth_query,
            )

    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}
    assert "synthetic" not in response.text.lower()


def test_setup_stores_only_sha256_token_hash(
    status_session_factory: sessionmaker[Session],
) -> None:
    """Keep the raw guest token out of every persistent Order column."""
    stored = _store_order(status_session_factory)
    with status_session_factory() as session:
        stored_hash = session.scalar(
            select(Order.order_access_token_hash).where(Order.id == stored.order_id)
        )
    assert stored_hash is not None
    assert stored_hash != stored.raw_access_token
    assert len(stored_hash) == 64
    assert re.fullmatch(r"[0-9a-f]{64}", stored_hash)
    assert "order_access_token" not in Order.__table__.columns


def test_status_uses_historical_item_and_table_snapshots(
    client: TestClient,
    status_session_factory: sessionmaker[Session],
) -> None:
    """Ignore later MenuItem and RestaurantTable changes."""
    stored = _store_order(status_session_factory, dine_in=True)
    with status_session_factory.begin() as session:
        first_item = session.get(MenuItem, stored.first_menu_item_id)
        table = session.get(RestaurantTable, stored.table_id)
        assert first_item is not None
        assert table is not None
        first_item.name = "Changed Current Name"
        first_item.price_amount = 999
        table.number = 77

    response = client.get(_status_url(stored), headers=_headers(stored))
    assert response.status_code == 200
    payload = response.json()
    assert payload["items"][0]["name"] == "Historical First"
    assert payload["items"][0]["unit_price_amount"] == 100
    assert payload["table_number"] == 7


def test_valid_status_access_executes_two_selects_and_zero_dml(
    status_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Measure the explicit order and ordered-item read queries."""
    stored = _store_order(status_session_factory)
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
        with status_session_factory() as session:
            response = get_order_status(
                session,
                stored.public_order_number,
                stored.raw_access_token,
            )
    finally:
        event.remove(
            test_database_engine,
            "before_cursor_execute",
            capture_statement,
        )

    verbs = [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ]
    assert verbs.count("SELECT") == 2
    assert all(verb not in {"INSERT", "UPDATE", "DELETE"} for verb in verbs)
    assert [item.name for item in response.items] == [
        "Historical First",
        "Historical Second",
    ]


def test_wrong_token_executes_one_select_and_zero_dml(
    status_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Reject a wrong token before querying item snapshots."""
    stored = _store_order(status_session_factory)
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
        with status_session_factory() as session:
            with pytest.raises(OrderNotFoundError):
                get_order_status(
                    session,
                    stored.public_order_number,
                    "wrong-token",
                )
    finally:
        event.remove(
            test_database_engine,
            "before_cursor_execute",
            capture_statement,
        )

    verbs = [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ]
    assert verbs == ["SELECT"]


def test_unknown_order_executes_one_select(
    status_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Reject an unknown number after one order lookup."""
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
        with status_session_factory() as session:
            with pytest.raises(OrderNotFoundError):
                get_order_status(session, "ROA-ZZZZZZZZZZZZ", "token")
    finally:
        event.remove(
            test_database_engine,
            "before_cursor_execute",
            capture_statement,
        )
    assert [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ] == ["SELECT"]


def test_status_response_serializes_after_session_close(
    status_session_factory: sessionmaker[Session],
) -> None:
    """Build a response without retaining ORM objects or lazy relationships."""
    stored = _store_order(status_session_factory)
    with status_session_factory() as session:
        response = get_order_status(
            session,
            stored.public_order_number,
            stored.raw_access_token,
        )
    payload = response.model_dump(mode="json")
    assert payload["public_order_number"] == stored.public_order_number
    assert [item["name"] for item in payload["items"]] == [
        "Historical First",
        "Historical Second",
    ]


def test_get_quote_remains_405_and_post_quote_still_works(
    client: TestClient,
    status_session_factory: sessionmaker[Session],
) -> None:
    """Keep the static Stage 7 quote contract ahead of the dynamic route."""
    stored = _store_order(status_session_factory)
    assert client.get(QUOTE_PATH).status_code == 405
    response = client.post(
        QUOTE_PATH,
        json={
            "items": [
                {
                    "menu_item_id": str(stored.first_menu_item_id),
                    "quantity": 2,
                }
            ]
        },
    )
    assert response.status_code == 200


def test_openapi_documents_optional_owner_or_capability_status_access(
    client: TestClient,
) -> None:
    """Expose exact optional UserBearer semantics and the safe status schema."""
    document = client.get("/openapi.json").json()
    assert set(document["paths"][QUOTE_PATH]) == {"post"}
    assert "/api/v1/orders/{public_order_number}" in document["paths"]
    operation = document["paths"]["/api/v1/orders/{public_order_number}"]["get"]
    assert operation["tags"] == ["orders"]
    assert {"200", "401", "404", "422", "503"} <= set(operation["responses"])
    assert operation["responses"]["200"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/OrderStatusResponse")
    header = next(
        parameter
        for parameter in operation["parameters"]
        if parameter["name"] == "X-Order-Access-Token"
    )
    assert header["in"] == "header"
    assert header["required"] is False
    assert operation["security"] == [{"UserBearer": []}, {}]
    assert {"AdminBearer": []} not in operation["security"]
    assert "post" in document["paths"]["/api/v1/orders"]
    properties = document["components"]["schemas"]["OrderStatusResponse"]["properties"]
    assert set(properties) == {
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
    assert {
        "id",
        "order_access_token",
        "order_access_token_hash",
        "customer_user_id",
        "owner_id",
        "user_id",
        "email",
        "role",
        "payment_summary",
        "cost",
        "tax",
        "discount",
    }.isdisjoint(properties)
    status_schema_text = str(document["components"]["schemas"]["OrderStatusResponse"])
    assert "Payment" not in status_schema_text
    assert "Stripe" not in status_schema_text
    assert set(document["components"]["securitySchemes"]) == {"UserBearer"}


def test_post_order_creation_is_documented(client: TestClient) -> None:
    """Document the Stage 8B-3 creation route without duplicating its API suite."""
    document = client.get("/openapi.json").json()
    operation = document["paths"]["/api/v1/orders"]["post"]

    assert operation["tags"] == ["orders"]
    assert operation["summary"] == "Create an order"
    assert operation["requestBody"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/OrderCreateRequest")
    assert operation["responses"]["201"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/OrderCreateResponse")
    assert {"201", "404", "409", "422", "429"} <= set(operation["responses"])
    schema_text = str(document["components"]["schemas"]["OrderCreateResponse"])
    assert "Payment" not in schema_text
    assert "Stripe" not in schema_text
