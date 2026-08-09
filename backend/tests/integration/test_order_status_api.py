"""Integration tests for authenticated public order status retrieval."""

from __future__ import annotations

import re
from collections.abc import Generator
from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

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
    application = create_app(
        settings=Settings(database_url=None),
        session_factory=status_session_factory,
    )
    with TestClient(application) as test_client:
        yield test_client


def _store_order(
    session_factory: sessionmaker[Session],
    *,
    dine_in: bool = False,
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


def test_openapi_documents_status_without_an_order_security_requirement(
    client: TestClient,
) -> None:
    """Expose guest status without weakening its access or data boundary."""
    document = client.get("/openapi.json").json()
    assert set(document["paths"][QUOTE_PATH]) == {"post"}
    assert "/api/v1/orders/{public_order_number}" in document["paths"]
    operation = document["paths"]["/api/v1/orders/{public_order_number}"]["get"]
    assert operation["tags"] == ["orders"]
    assert {"200", "404", "422"} <= set(operation["responses"])
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
    assert "security" not in operation
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
        "payment_summary",
        "cost",
        "tax",
        "discount",
    }.isdisjoint(properties)
    status_schema_text = str(document["components"]["schemas"]["OrderStatusResponse"])
    assert "Payment" not in status_schema_text
    assert "Stripe" not in status_schema_text
    assert document["components"]["securitySchemes"]["AdminBearer"] == {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT",
    }


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
