"""Integration tests for the public, read-only order quote API."""

from __future__ import annotations

import json
from collections.abc import Generator
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, inspect, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.categories.models import Category
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app
from app.menu.models import MenuItem
from app.orders.quoting import (
    MenuItemNotFoundError,
    MenuItemUnavailableError,
    MixedCurrencyError,
    quote_order,
)
from app.orders.schemas import OrderQuoteItemRequest, OrderQuoteRequest

pytestmark = pytest.mark.integration

BURGER_ID = UUID("9933957b-7f5d-47d8-84c3-ba8ad21b2d8c")
SPRITZ_ID = UUID("c496b9cc-268c-4549-9e36-e8225e57561f")
WARM_APPLE_CAKE_ID = UUID("95abd9ff-dea5-48fa-aa81-0632fb5caef7")
QUOTE_PATH = "/api/v1/orders/quote"


@pytest.fixture(autouse=True)
def empty_menu_tables(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep every quote test isolated inside the approved test database."""
    with test_database_engine.begin() as connection:
        connection.execute(delete(MenuItem))
        connection.execute(delete(Category))
    try:
        yield
    finally:
        with test_database_engine.begin() as connection:
            connection.execute(delete(MenuItem))
            connection.execute(delete(Category))


@pytest.fixture
def api_session_factory(test_database_engine: Engine) -> sessionmaker[Session]:
    """Provide request sessions bound to the isolated test database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def client(
    api_session_factory: sessionmaker[Session],
) -> Generator[TestClient, None, None]:
    """Run FastAPI with the isolated test session factory."""
    application = create_app(
        settings=Settings(database_url=None),
        session_factory=api_session_factory,
    )
    with TestClient(application) as test_client:
        yield test_client


def _category(*, name: str = "Category", is_active: bool = True) -> Category:
    return Category(
        id=uuid4(),
        name=name,
        description=f"{name} description",
        display_order=0,
        is_active=is_active,
    )


def _item(
    category: Category,
    *,
    name: str,
    price_amount: int = 9900,
    currency: str = "NOK",
    is_active: bool = True,
    is_available: bool = True,
    item_id: UUID | None = None,
) -> MenuItem:
    return MenuItem(
        id=item_id or uuid4(),
        category=category,
        name=name,
        description=f"{name} description",
        image_url=None,
        price_amount=price_amount,
        cost_amount=4500,
        currency=currency,
        allergens=["milk"],
        display_order=0,
        is_active=is_active,
        is_available=is_available,
    )


def _store(
    session_factory: sessionmaker[Session],
    *records: Category | MenuItem,
) -> None:
    with session_factory.begin() as session:
        session.add_all(records)
        session.flush()
        session.expunge_all()


def _request(*items: tuple[UUID, int]) -> OrderQuoteRequest:
    return OrderQuoteRequest(
        items=[
            OrderQuoteItemRequest(menu_item_id=item_id, quantity=quantity)
            for item_id, quantity in items
        ]
    )


def _database_snapshot(
    session_factory: sessionmaker[Session],
) -> tuple[list[object], list[object]]:
    with session_factory() as session:
        categories = session.execute(
            select(
                Category.id,
                Category.name,
                Category.description,
                Category.display_order,
                Category.is_active,
                Category.created_at,
                Category.updated_at,
            ).order_by(Category.id)
        ).all()
        items = session.execute(
            select(
                MenuItem.id,
                MenuItem.category_id,
                MenuItem.name,
                MenuItem.description,
                MenuItem.image_url,
                MenuItem.price_amount,
                MenuItem.cost_amount,
                MenuItem.currency,
                MenuItem.allergens,
                MenuItem.display_order,
                MenuItem.is_active,
                MenuItem.is_available,
                MenuItem.created_at,
                MenuItem.updated_at,
            ).order_by(MenuItem.id)
        ).all()
    return categories, items


def test_quote_one_item_uses_server_name_price_and_integer_arithmetic(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Build one line only from current database-owned values."""
    category = _category()
    item = _item(category, name="Database Name", price_amount=12345)
    _store(api_session_factory, category, item)

    with api_session_factory() as session:
        result = quote_order(session, _request((item.id, 3)))

    assert result.currency == "NOK"
    assert result.items[0].name == "Database Name"
    assert result.items[0].unit_price_amount == 12345
    assert result.items[0].line_total_amount == 37035
    assert result.subtotal_amount == 37035
    assert result.total_amount == result.subtotal_amount


def test_quote_multiple_items_preserves_request_order_and_sums_totals(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Ignore PostgreSQL row order and preserve the client item order."""
    category = _category()
    first = _item(category, name="First", price_amount=100)
    second = _item(category, name="Second", price_amount=250)
    _store(api_session_factory, category, first, second)

    with api_session_factory() as session:
        result = quote_order(session, _request((second.id, 2), (first.id, 3)))

    assert [line.menu_item_id for line in result.items] == [second.id, first.id]
    assert [line.line_total_amount for line in result.items] == [500, 300]
    assert result.subtotal_amount == 800
    assert result.total_amount == 800


def test_foreign_non_seed_item_can_be_quoted_after_session_close(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Quote an arbitrary valid record without relying on seed identities."""
    category = _category(name="Local category")
    item = _item(category, name="Local item", price_amount=777)
    _store(api_session_factory, category, item)

    with api_session_factory() as session:
        result = quote_order(session, _request((item.id, 1)))

    assert result.model_dump(mode="json")["items"][0]["name"] == "Local item"


def test_identical_requests_are_deterministic(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Return identical JSON while database state remains unchanged."""
    category = _category()
    item = _item(category, name="Stable", price_amount=321)
    _store(api_session_factory, category, item)

    with api_session_factory() as session:
        first = quote_order(session, _request((item.id, 4)))
    with api_session_factory() as session:
        second = quote_order(session, _request((item.id, 4)))

    assert first.model_dump(mode="json") == second.model_dump(mode="json")


def test_large_valid_quote_remains_exact(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Calculate the maximum item count and quantity with Python integers."""
    category = _category()
    items = [
        _item(category, name=f"Large item {index}", price_amount=2_000_000_000)
        for index in range(50)
    ]
    _store(api_session_factory, category, *items)

    with api_session_factory() as session:
        result = quote_order(
            session,
            _request(*[(item.id, 99) for item in items]),
        )

    assert len(result.items) == 50
    assert result.total_amount == 9_900_000_000_000
    assert result.total_amount == result.subtotal_amount


@pytest.mark.parametrize(
    ("inactive_item", "inactive_category"),
    [(False, False), (True, False), (False, True)],
)
def test_missing_and_non_public_items_raise_not_found(
    api_session_factory: sessionmaker[Session],
    inactive_item: bool,
    inactive_category: bool,
) -> None:
    """Use one private domain result for missing and inactive records."""
    item_id = uuid4()
    if inactive_item or inactive_category:
        category = _category(is_active=not inactive_category)
        item = _item(
            category,
            name="Hidden",
            is_active=not inactive_item,
            item_id=item_id,
        )
        _store(api_session_factory, category, item)

    with api_session_factory() as session:
        with pytest.raises(MenuItemNotFoundError):
            quote_order(session, _request((item_id, 1)))


def test_active_unavailable_item_raises_unavailable(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Distinguish temporary unavailability from non-public records."""
    category = _category()
    item = _item(category, name="Unavailable", is_available=False)
    _store(api_session_factory, category, item)

    with api_session_factory() as session:
        with pytest.raises(MenuItemUnavailableError):
            quote_order(session, _request((item.id, 1)))


@pytest.mark.parametrize(
    ("missing_first", "expected_error"),
    [(True, MenuItemNotFoundError), (False, MenuItemUnavailableError)],
)
def test_first_item_error_follows_request_order(
    api_session_factory: sessionmaker[Session],
    missing_first: bool,
    expected_error: type[Exception],
) -> None:
    """Resolve item-level errors in request order without partial output."""
    category = _category()
    unavailable = _item(category, name="Unavailable", is_available=False)
    missing_id = uuid4()
    _store(api_session_factory, category, unavailable)
    items = (
        ((missing_id, 1), (unavailable.id, 1))
        if missing_first
        else ((unavailable.id, 1), (missing_id, 1))
    )

    with api_session_factory() as session:
        with pytest.raises(expected_error):
            quote_order(session, _request(*items))


@pytest.mark.parametrize("first_state", ["inactive", "unavailable"])
def test_item_errors_precede_mixed_currency(
    api_session_factory: sessionmaker[Session],
    first_state: str,
) -> None:
    """Check mixed currency only after every item passes item validation."""
    category = _category()
    first = _item(
        category,
        name="First",
        currency="NOK",
        is_active=first_state != "inactive",
        is_available=first_state != "unavailable",
    )
    second = _item(category, name="Second", currency="EUR")
    _store(api_session_factory, category, first, second)
    expected_error = (
        MenuItemNotFoundError if first_state == "inactive" else MenuItemUnavailableError
    )

    with api_session_factory() as session:
        with pytest.raises(expected_error):
            quote_order(session, _request((first.id, 1), (second.id, 1)))


def test_valid_items_with_mixed_currencies_fail_completely(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Reject a quote instead of grouping or converting currencies."""
    category = _category()
    nok_item = _item(category, name="NOK item", currency="NOK")
    eur_item = _item(category, name="EUR item", currency="EUR")
    _store(api_session_factory, category, nok_item, eur_item)
    before = _database_snapshot(api_session_factory)

    with api_session_factory() as session:
        with pytest.raises(MixedCurrencyError):
            quote_order(session, _request((nok_item.id, 1), (eur_item.id, 1)))

    assert _database_snapshot(api_session_factory) == before


def test_quote_executes_exactly_one_select_and_zero_dml(
    api_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Measure only quote execution and verify its narrow read contract."""
    category = _category()
    item = _item(category, name="Measured")
    _store(api_session_factory, category, item)
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
        with api_session_factory() as session:
            quote_order(session, _request((item.id, 1)))
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    verbs = [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ]
    assert verbs.count("SELECT") == 1
    assert all(verb not in {"INSERT", "UPDATE", "DELETE"} for verb in verbs)
    normalized_statement = statements[0].lower()
    assert "cost_amount" not in normalized_statement
    assert "created_at" not in normalized_statement
    assert "updated_at" not in normalized_statement


def test_quote_does_not_mutate_database_or_timestamps(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Leave all business fields, counts, and timestamps unchanged."""
    category = _category()
    item = _item(category, name="Read only")
    _store(api_session_factory, category, item)
    before = _database_snapshot(api_session_factory)

    with api_session_factory() as session:
        quote_order(session, _request((item.id, 2)))

    assert _database_snapshot(api_session_factory) == before


def test_price_snapshot_changes_only_for_a_later_quote(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Keep the first response stable after a later database price change."""
    category = _category()
    item = _item(category, name="Changing price", price_amount=100)
    _store(api_session_factory, category, item)

    with api_session_factory() as session:
        first = quote_order(session, _request((item.id, 2)))
    first_json = first.model_dump(mode="json")
    with api_session_factory.begin() as session:
        stored = session.get(MenuItem, item.id)
        assert stored is not None
        stored.price_amount = 175
    with api_session_factory() as session:
        second = quote_order(session, _request((item.id, 2)))

    assert first_json["items"][0]["unit_price_amount"] == 100
    assert first.model_dump(mode="json") == first_json
    assert second.items[0].unit_price_amount == 175
    assert second.total_amount == 350


def test_availability_change_affects_only_a_later_quote(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Revalidate availability without changing an earlier response."""
    category = _category()
    item = _item(category, name="Changing availability")
    _store(api_session_factory, category, item)

    with api_session_factory() as session:
        first = quote_order(session, _request((item.id, 1)))
    first_json = first.model_dump(mode="json")
    with api_session_factory.begin() as session:
        stored = session.get(MenuItem, item.id)
        assert stored is not None
        stored.is_available = False
    with api_session_factory() as session:
        with pytest.raises(MenuItemUnavailableError):
            quote_order(session, _request((item.id, 1)))

    assert first.model_dump(mode="json") == first_json


def test_empty_database_quote_does_not_run_seed(
    api_session_factory: sessionmaker[Session],
) -> None:
    """Fail missing without introducing seed or any new record."""
    before = _database_snapshot(api_session_factory)

    with api_session_factory() as session:
        with pytest.raises(MenuItemNotFoundError):
            quote_order(session, _request((uuid4(), 1)))

    assert before == ([], [])
    assert _database_snapshot(api_session_factory) == before


def test_success_endpoint_returns_approved_example_without_auth(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
) -> None:
    """Return the approved two-line quote without authentication headers."""
    category = _category(name="Seed example")
    burger = _item(
        category,
        name="Classic Beef Burger",
        price_amount=22900,
        item_id=BURGER_ID,
    )
    spritz = _item(
        category,
        name="Cloudberry Spritz",
        price_amount=7900,
        item_id=SPRITZ_ID,
    )
    _store(api_session_factory, category, burger, spritz)

    response = client.post(
        QUOTE_PATH,
        json={
            "items": [
                {"menu_item_id": str(BURGER_ID), "quantity": 2},
                {"menu_item_id": str(SPRITZ_ID), "quantity": 1},
            ]
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {
        "currency": "NOK",
        "items": [
            {
                "menu_item_id": str(BURGER_ID),
                "name": "Classic Beef Burger",
                "quantity": 2,
                "unit_price_amount": 22900,
                "line_total_amount": 45800,
            },
            {
                "menu_item_id": str(SPRITZ_ID),
                "name": "Cloudberry Spritz",
                "quantity": 1,
                "unit_price_amount": 7900,
                "line_total_amount": 7900,
            },
        ],
        "subtotal_amount": 53700,
        "total_amount": 53700,
    }


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"items": []},
        {"items": [{"menu_item_id": str(uuid4()), "quantity": 1} for _ in range(51)]},
        {"items": [{"menu_item_id": str(uuid4()), "quantity": 0}]},
        {"items": [{"menu_item_id": str(uuid4()), "quantity": 100}]},
        {"items": [{"menu_item_id": str(uuid4()), "quantity": "2"}]},
        {"items": [{"menu_item_id": str(uuid4()), "quantity": True}]},
        {"items": [{"menu_item_id": "not-a-uuid", "quantity": 1}]},
        {
            "items": [
                {"menu_item_id": str(BURGER_ID), "quantity": 1},
                {"menu_item_id": str(BURGER_ID), "quantity": 2},
            ]
        },
        {"items": [{"menu_item_id": str(uuid4()), "quantity": 1, "unexpected": True}]},
        {"items": [{"menu_item_id": str(uuid4()), "quantity": 1, "price_amount": 1}]},
        {"items": [{"menu_item_id": str(uuid4()), "quantity": 1, "currency": "NOK"}]},
    ],
)
def test_endpoint_rejects_invalid_requests(
    client: TestClient,
    payload: dict[str, object],
) -> None:
    """Return standard 422 responses for every invalid request class."""
    assert client.post(QUOTE_PATH, json=payload).status_code == 422


@pytest.mark.parametrize("hidden_target", ["missing", "item", "category"])
def test_endpoint_hides_missing_and_inactive_records(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
    hidden_target: str,
) -> None:
    """Return the exact generic 404 body for every non-public case."""
    item_id = uuid4()
    if hidden_target != "missing":
        category = _category(is_active=hidden_target != "category")
        item = _item(
            category,
            name="Hidden",
            is_active=hidden_target != "item",
            item_id=item_id,
        )
        _store(api_session_factory, category, item)

    response = client.post(
        QUOTE_PATH,
        json={"items": [{"menu_item_id": str(item_id), "quantity": 1}]},
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Menu item not found"}


def test_endpoint_returns_exact_unavailable_conflict(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
) -> None:
    """Return the approved 409 contract for temporary unavailability."""
    category = _category()
    cake = _item(
        category,
        name="Warm Apple Cake",
        is_available=False,
        item_id=WARM_APPLE_CAKE_ID,
    )
    _store(api_session_factory, category, cake)

    response = client.post(
        QUOTE_PATH,
        json={"items": [{"menu_item_id": str(cake.id), "quantity": 1}]},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Menu item is unavailable"}


def test_endpoint_returns_exact_mixed_currency_conflict(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
) -> None:
    """Return the approved 409 contract for mixed currencies."""
    category = _category()
    nok_item = _item(category, name="NOK", currency="NOK")
    eur_item = _item(category, name="EUR", currency="EUR")
    _store(api_session_factory, category, nok_item, eur_item)

    response = client.post(
        QUOTE_PATH,
        json={
            "items": [
                {"menu_item_id": str(nok_item.id), "quantity": 1},
                {"menu_item_id": str(eur_item.id), "quantity": 1},
            ]
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Mixed currencies are not supported"}


@pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
def test_quote_endpoint_allows_only_post(
    client: TestClient,
    method: str,
) -> None:
    """Return the standard 405 contract for unsupported methods."""
    assert client.request(method, QUOTE_PATH).status_code == 405


def test_openapi_documents_only_the_transient_quote_contract(
    client: TestClient,
) -> None:
    """Expose examples and errors without internal business models."""
    response = client.get("/openapi.json")
    assert response.status_code == 200
    document = response.json()
    operation = document["paths"][QUOTE_PATH]["post"]
    schemas = document["components"]["schemas"]

    assert set(document["paths"][QUOTE_PATH]) == {"post"}
    assert operation["tags"] == ["orders"]
    assert operation["summary"] == "Quote an order"
    assert "point-in-time" in operation["description"]
    assert operation["responses"]["200"]["description"] == (
        "The current price snapshot for the requested menu items."
    )
    assert {"200", "404", "409", "422"} <= set(operation["responses"])
    assert "security" not in operation
    assert operation["requestBody"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/OrderQuoteRequest")
    assert operation["responses"]["200"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/OrderQuoteResponse")
    assert schemas["OrderQuoteRequest"]["example"]["items"][0]["quantity"] == 2
    assert schemas["OrderQuoteResponse"]["example"]["total_amount"] == 53700
    assert set(schemas).isdisjoint({"Order", "OrderItem", "Payment"})
    schema_text = json.dumps(schemas)
    assert all(
        value not in schema_text
        for value in (
            "cost_amount",
            "customer",
            "created_at",
            "quoted_at",
            "expires_at",
            "Stripe",
        )
    )


def test_docs_health_and_existing_menu_regression(client: TestClient) -> None:
    """Keep documentation, health, and the Stage 6 menu route available."""
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/api/v1/menu").json() == {"categories": []}


def test_no_order_creation_payment_tables_or_routes(
    client: TestClient,
    test_database_engine: Engine,
) -> None:
    """Keep persistence and later-stage routes outside Stage 7."""
    assert set(inspect(test_database_engine).get_table_names(schema="public")) == {
        "alembic_version",
        "categories",
        "menu_items",
    }
    assert client.post("/api/v1/orders", json={}).status_code == 404
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/v1/orders" not in paths
    assert all("payment" not in path.lower() for path in paths)


def test_endpoint_quote_does_not_mutate_database(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
) -> None:
    """Keep counts, fields, and timestamps stable across an HTTP quote."""
    category = _category()
    item = _item(category, name="HTTP read only")
    _store(api_session_factory, category, item)
    before = _database_snapshot(api_session_factory)

    response = client.post(
        QUOTE_PATH,
        json={"items": [{"menu_item_id": str(item.id), "quantity": 2}]},
    )

    assert response.status_code == 200
    assert _database_snapshot(api_session_factory) == before
