"""Integration tests for transactional public order creation."""

from __future__ import annotations

from collections.abc import Generator
from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, func, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.categories.models import Category
from app.core.config import Settings
from app.core.rate_limit import FixedWindowRateLimiter
from app.database.session import create_session_factory
from app.main import create_app
from app.menu.models import MenuItem
from app.orders.access import hash_order_access_token
from app.orders.creation import MenuItemNotFoundError, create_order
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.schemas import OrderCreateRequest
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration

CREATE_PATH = "/api/v1/orders"
QUOTE_PATH = "/api/v1/orders/quote"
BURGER_ID = UUID("9933957b-7f5d-47d8-84c3-ba8ad21b2d8c")
SPRITZ_ID = UUID("c496b9cc-268c-4549-9e36-e8225e57561f")


@dataclass(frozen=True)
class MenuRecords:
    burger_id: UUID
    spritz_id: UUID
    burger_category_id: UUID
    drinks_category_id: UUID


class FakeClock:
    """Provide deterministic time for rate-limit integration tests."""

    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        """Advance the monotonic test clock."""
        self.value += seconds


@pytest.fixture(autouse=True)
def empty_creation_tables(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep creation tests isolated in the approved test database."""
    _clear_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_tables(test_database_engine)


@pytest.fixture
def creation_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create sessions bound only to the isolated test database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def menu_records(creation_session_factory: sessionmaker[Session]) -> MenuRecords:
    """Store the approved burger and spritz records in the test database."""
    return _store_menu(creation_session_factory)


@pytest.fixture
def client(
    creation_session_factory: sessionmaker[Session],
) -> Generator[TestClient, None, None]:
    """Run an app with isolated sessions and a fresh creation limiter."""
    application = create_app(
        settings=Settings(database_url=None),
        session_factory=creation_session_factory,
    )
    with TestClient(application) as test_client:
        yield test_client


def _clear_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))
        connection.execute(delete(RestaurantTable))
        connection.execute(delete(MenuItem))
        connection.execute(delete(Category))


def _store_menu(session_factory: sessionmaker[Session]) -> MenuRecords:
    burger_category = Category(name=f"Burgers {uuid4().hex}")
    drinks_category = Category(name=f"Drinks {uuid4().hex}")
    burger = MenuItem(
        id=BURGER_ID,
        category=burger_category,
        name="Classic Beef Burger",
        price_amount=22900,
        cost_amount=8700,
        currency="NOK",
        is_active=True,
        is_available=True,
    )
    spritz = MenuItem(
        id=SPRITZ_ID,
        category=drinks_category,
        name="Cloudberry Spritz",
        price_amount=7900,
        cost_amount=1900,
        currency="NOK",
        is_active=True,
        is_available=True,
    )
    with session_factory.begin() as session:
        session.add_all([burger_category, drinks_category, burger, spritz])
        session.flush()
        records = MenuRecords(
            burger_id=burger.id,
            spritz_id=spritz.id,
            burger_category_id=burger_category.id,
            drinks_category_id=drinks_category.id,
        )
    return records


def _takeaway_payload(
    records: MenuRecords,
    *,
    reverse: bool = False,
) -> dict[str, object]:
    items = [
        {"menu_item_id": str(records.burger_id), "quantity": 2},
        {"menu_item_id": str(records.spritz_id), "quantity": 1},
    ]
    if reverse:
        items.reverse()
    return {"order_type": "takeaway", "items": items}


def _aggregate_counts(session_factory: sessionmaker[Session]) -> tuple[int, int, int]:
    with session_factory() as session:
        return (
            session.scalar(select(func.count()).select_from(Order)) or 0,
            session.scalar(select(func.count()).select_from(OrderItem)) or 0,
            session.scalar(select(func.count()).select_from(OrderStatusHistory)) or 0,
        )


def test_successful_takeaway_persists_exact_snapshot_and_status_access(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    """Create the approved 53700 NOK aggregate and retrieve its public status."""
    response = client.post(CREATE_PATH, json=_takeaway_payload(menu_records))

    assert response.status_code == 201
    payload = response.json()
    assert payload["currency"] == "NOK"
    assert payload["status"] == "created"
    assert payload["order_type"] == "takeaway"
    assert payload["table_number"] is None
    assert payload["subtotal_amount"] == payload["total_amount"] == 53700
    assert [item["line_total_amount"] for item in payload["items"]] == [45800, 7900]
    assert payload["order_access_token"]
    assert (
        response.headers["location"]
        == f"/api/v1/orders/{payload['public_order_number']}"
    )

    with creation_session_factory() as session:
        order = session.scalars(select(Order)).one()
        items = session.scalars(select(OrderItem).order_by(OrderItem.position)).all()
        history = session.scalars(select(OrderStatusHistory)).one()
        assert order.status == "created"
        assert order.currency == "NOK"
        assert order.subtotal_amount == order.total_amount == 53700
        assert order.table_id is None
        assert order.table_number_snapshot is None
        assert order.order_access_token_hash == hash_order_access_token(
            payload["order_access_token"]
        )
        assert order.order_access_token_hash != payload["order_access_token"]
        assert [item.position for item in items] == [0, 1]
        assert [item.name_snapshot for item in items] == [
            "Classic Beef Burger",
            "Cloudberry Spritz",
        ]
        assert [item.unit_price_amount for item in items] == [22900, 7900]
        assert [item.unit_cost_amount for item in items] == [8700, 1900]
        assert [item.tax_rate_bps_snapshot for item in items] == [None, None]
        assert [item.discount_amount_snapshot for item in items] == [0, 0]
        assert history.sequence == 0
        assert history.previous_status is None
        assert history.new_status == "created"

    status_response = client.get(
        response.headers["location"],
        headers={"X-Order-Access-Token": payload["order_access_token"]},
    )
    assert status_response.status_code == 200
    status_payload = status_response.json()
    assert [item["name"] for item in status_payload["items"]] == [
        "Classic Beef Burger",
        "Cloudberry Spritz",
    ]
    assert "order_access_token" not in status_payload
    assert "order_access_token_hash" not in status_payload
    assert "id" not in status_payload


def test_successful_dine_in_uses_table_and_preserves_snapshots(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    with creation_session_factory.begin() as session:
        table = RestaurantTable(number=4, is_active=True)
        session.add(table)
        session.flush()
        table_id = table.id

    response = client.post(
        CREATE_PATH,
        json={
            "order_type": "dine_in",
            "table_number": 4,
            "items": [{"menu_item_id": str(menu_records.burger_id), "quantity": 1}],
        },
    )
    assert response.status_code == 201
    assert response.json()["table_number"] == 4

    with creation_session_factory.begin() as session:
        session.execute(
            update(Category)
            .where(Category.id == menu_records.burger_category_id)
            .values(name="Changed Category")
        )
        session.execute(
            update(MenuItem)
            .where(MenuItem.id == menu_records.burger_id)
            .values(name="Changed Item", price_amount=31000, cost_amount=12000)
        )
        session.execute(
            update(RestaurantTable)
            .where(RestaurantTable.id == table_id)
            .values(number=44)
        )

    payload = response.json()
    status_response = client.get(
        response.headers["location"],
        headers={"X-Order-Access-Token": payload["order_access_token"]},
    )
    assert status_response.status_code == 200
    assert status_response.json()["table_number"] == 4
    assert status_response.json()["items"][0]["name"] == "Classic Beef Burger"
    with creation_session_factory() as session:
        order = session.scalars(select(Order)).one()
        item = session.scalars(select(OrderItem)).one()
        assert order.table_id == table_id
        assert order.table_number_snapshot == 4
        assert order.total_amount == 22900
        assert item.category_name_snapshot.startswith("Burgers ")
        assert item.name_snapshot == "Classic Beef Burger"
        assert item.unit_price_amount == 22900
        assert item.unit_cost_amount == 8700


@pytest.mark.parametrize("active", [None, False])
def test_invalid_table_returns_422_before_menu_validation(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    active: bool | None,
) -> None:
    if active is not None:
        with creation_session_factory.begin() as session:
            session.add(RestaurantTable(number=9, is_active=active))
    response = client.post(
        CREATE_PATH,
        json={
            "order_type": "dine_in",
            "table_number": 9,
            "items": [{"menu_item_id": str(uuid4()), "quantity": 1}],
        },
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid table"}
    assert _aggregate_counts(creation_session_factory) == (0, 0, 0)


@pytest.mark.parametrize(
    ("mutation", "status_code", "detail"),
    [
        ("missing", 404, "Menu item not found"),
        ("inactive_item", 404, "Menu item not found"),
        ("inactive_category", 404, "Menu item not found"),
        ("unavailable", 409, "Menu item is unavailable"),
    ],
)
def test_item_errors_roll_back_without_partial_aggregate(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
    mutation: str,
    status_code: int,
    detail: str,
) -> None:
    item_id = menu_records.burger_id
    with creation_session_factory.begin() as session:
        if mutation == "missing":
            item_id = uuid4()
        elif mutation == "inactive_item":
            session.execute(
                update(MenuItem).where(MenuItem.id == item_id).values(is_active=False)
            )
        elif mutation == "inactive_category":
            session.execute(
                update(Category)
                .where(Category.id == menu_records.burger_category_id)
                .values(is_active=False)
            )
        else:
            session.execute(
                update(MenuItem)
                .where(MenuItem.id == item_id)
                .values(is_available=False)
            )

    response = client.post(
        CREATE_PATH,
        json={
            "order_type": "takeaway",
            "items": [{"menu_item_id": str(item_id), "quantity": 1}],
        },
    )
    assert response.status_code == status_code
    assert response.json() == {"detail": detail}
    assert _aggregate_counts(creation_session_factory) == (0, 0, 0)


@pytest.mark.parametrize(
    ("first_state", "second_state", "expected_status", "expected_detail"),
    [
        ("missing", "unavailable", 404, "Menu item not found"),
        ("unavailable", "missing", 409, "Menu item is unavailable"),
        ("inactive", "eur", 404, "Menu item not found"),
        ("unavailable", "eur", 409, "Menu item is unavailable"),
    ],
)
def test_item_error_precedence_follows_request_order(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
    first_state: str,
    second_state: str,
    expected_status: int,
    expected_detail: str,
) -> None:
    ids = [menu_records.burger_id, menu_records.spritz_id]
    states = [first_state, second_state]
    with creation_session_factory.begin() as session:
        for index, state in enumerate(states):
            if state == "missing":
                ids[index] = uuid4()
            elif state == "unavailable":
                session.execute(
                    update(MenuItem)
                    .where(MenuItem.id == ids[index])
                    .values(is_available=False)
                )
            elif state == "inactive":
                session.execute(
                    update(MenuItem)
                    .where(MenuItem.id == ids[index])
                    .values(is_active=False)
                )
            elif state == "eur":
                session.execute(
                    update(MenuItem)
                    .where(MenuItem.id == ids[index])
                    .values(currency="EUR")
                )

    response = client.post(
        CREATE_PATH,
        json={
            "order_type": "takeaway",
            "items": [
                {"menu_item_id": str(ids[0]), "quantity": 1},
                {"menu_item_id": str(ids[1]), "quantity": 1},
            ],
        },
    )
    assert response.status_code == expected_status
    assert response.json() == {"detail": expected_detail}
    assert _aggregate_counts(creation_session_factory) == (0, 0, 0)


def test_all_valid_mixed_currency_returns_409_without_persistence(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    with creation_session_factory.begin() as session:
        session.execute(
            update(MenuItem)
            .where(MenuItem.id == menu_records.spritz_id)
            .values(currency="EUR")
        )
    response = client.post(CREATE_PATH, json=_takeaway_payload(menu_records))
    assert response.status_code == 409
    assert response.json() == {"detail": "Mixed currencies are not supported"}
    assert _aggregate_counts(creation_session_factory) == (0, 0, 0)


def test_request_order_and_current_database_values_are_authoritative(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    with creation_session_factory.begin() as session:
        session.execute(
            update(MenuItem)
            .where(MenuItem.id == menu_records.spritz_id)
            .values(name="Current Spritz", price_amount=8100, cost_amount=2000)
        )
    response = client.post(
        CREATE_PATH, json=_takeaway_payload(menu_records, reverse=True)
    )
    assert response.status_code == 201
    assert [item["menu_item_id"] for item in response.json()["items"]] == [
        str(menu_records.spritz_id),
        str(menu_records.burger_id),
    ]
    assert response.json()["items"][0]["name"] == "Current Spritz"
    assert response.json()["items"][0]["unit_price_amount"] == 8100
    with creation_session_factory() as session:
        items = session.scalars(select(OrderItem).order_by(OrderItem.position)).all()
        assert [item.menu_item_id for item in items] == [
            menu_records.spritz_id,
            menu_records.burger_id,
        ]
        assert items[0].unit_cost_amount == 2000


def test_quote_price_a_does_not_override_creation_price_b(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    quote = client.post(
        QUOTE_PATH,
        json={"items": [{"menu_item_id": str(menu_records.burger_id), "quantity": 1}]},
    )
    assert quote.status_code == 200
    assert quote.json()["total_amount"] == 22900
    with creation_session_factory.begin() as session:
        session.execute(
            update(MenuItem)
            .where(MenuItem.id == menu_records.burger_id)
            .values(price_amount=24900)
        )
    created = client.post(
        CREATE_PATH,
        json={
            "order_type": "takeaway",
            "items": [{"menu_item_id": str(menu_records.burger_id), "quantity": 1}],
        },
    )
    assert created.status_code == 201
    assert created.json()["total_amount"] == 24900
    with creation_session_factory() as session:
        assert session.scalars(select(OrderItem)).one().unit_price_amount == 24900


def test_quote_success_does_not_reserve_availability(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    quote_payload = {
        "items": [{"menu_item_id": str(menu_records.burger_id), "quantity": 1}]
    }
    assert client.post(QUOTE_PATH, json=quote_payload).status_code == 200
    with creation_session_factory.begin() as session:
        session.execute(
            update(MenuItem)
            .where(MenuItem.id == menu_records.burger_id)
            .values(is_available=False)
        )
    created = client.post(CREATE_PATH, json={"order_type": "takeaway", **quote_payload})
    assert created.status_code == 409
    assert created.json() == {"detail": "Menu item is unavailable"}
    assert _aggregate_counts(creation_session_factory) == (0, 0, 0)


def test_repeated_post_creates_two_distinct_orders(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    first = client.post(CREATE_PATH, json=_takeaway_payload(menu_records))
    second = client.post(CREATE_PATH, json=_takeaway_payload(menu_records))
    assert first.status_code == second.status_code == 201
    assert first.json()["public_order_number"] != second.json()["public_order_number"]
    assert first.json()["order_access_token"] != second.json()["order_access_token"]
    assert _aggregate_counts(creation_session_factory) == (2, 4, 2)


@pytest.mark.parametrize("collision", ["public_number", "token_hash"])
def test_known_generated_access_collision_rolls_back_aggregate(
    client: TestClient,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
    monkeypatch: pytest.MonkeyPatch,
    collision: str,
) -> None:
    first = client.post(CREATE_PATH, json=_takeaway_payload(menu_records))
    assert first.status_code == 201
    if collision == "public_number":
        monkeypatch.setattr(
            "app.orders.creation.generate_public_order_number",
            lambda: first.json()["public_order_number"],
        )
    else:
        monkeypatch.setattr(
            "app.orders.creation.generate_order_access_token",
            lambda: first.json()["order_access_token"],
        )
    second = client.post(CREATE_PATH, json=_takeaway_payload(menu_records))
    assert second.status_code == 409
    assert second.json() == {"detail": "Order creation conflict"}
    assert _aggregate_counts(creation_session_factory) == (1, 2, 1)


def test_unexpected_insert_failure_propagates_and_rolls_back(
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    def fail_order_item_insert(*_: object) -> None:
        raise RuntimeError("controlled insert failure")

    event.listen(OrderItem, "before_insert", fail_order_item_insert)
    try:
        with creation_session_factory() as session:
            with pytest.raises(RuntimeError, match="controlled insert failure"):
                create_order(
                    session,
                    OrderCreateRequest.model_validate(_takeaway_payload(menu_records)),
                )
    finally:
        event.remove(OrderItem, "before_insert", fail_order_item_insert)
    assert _aggregate_counts(creation_session_factory) == (0, 0, 0)


def test_service_controls_one_commit_and_error_rollback(
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    commits = 0
    rollbacks = 0

    def count_commit(_: Session) -> None:
        nonlocal commits
        commits += 1

    def count_rollback(_: Session) -> None:
        nonlocal rollbacks
        rollbacks += 1

    with creation_session_factory() as session:
        event.listen(session, "after_commit", count_commit)
        event.listen(session, "after_rollback", count_rollback)
        create_order(
            session, OrderCreateRequest.model_validate(_takeaway_payload(menu_records))
        )
    assert (commits, rollbacks) == (1, 0)

    commits = 0
    rollbacks = 0
    invalid_request = OrderCreateRequest.model_validate(
        {
            "order_type": "takeaway",
            "items": [{"menu_item_id": str(uuid4()), "quantity": 1}],
        }
    )
    with creation_session_factory() as session:
        event.listen(session, "after_commit", count_commit)
        event.listen(session, "after_rollback", count_rollback)
        with pytest.raises(MenuItemNotFoundError):
            create_order(session, invalid_request)
    assert (commits, rollbacks) == (0, 1)


@pytest.mark.parametrize(
    ("order_type", "expected_selects"), [("takeaway", 1), ("dine_in", 2)]
)
def test_creation_sql_counts_locks_and_dine_in_order(
    test_database_engine: Engine,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
    order_type: str,
    expected_selects: int,
) -> None:
    if order_type == "dine_in":
        with creation_session_factory.begin() as session:
            session.add(RestaurantTable(number=4))
    statements: list[str] = []

    def capture_sql(*args: object) -> None:
        statements.append(str(args[2]))

    event.listen(test_database_engine, "before_cursor_execute", capture_sql)
    try:
        payload: dict[str, object] = {
            "order_type": order_type,
            "items": [{"menu_item_id": str(menu_records.burger_id), "quantity": 1}],
        }
        if order_type == "dine_in":
            payload["table_number"] = 4
        with creation_session_factory() as session:
            create_order(session, OrderCreateRequest.model_validate(payload))
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_sql)

    selects = [
        statement
        for statement in statements
        if statement.lstrip().upper().startswith("SELECT")
    ]
    assert len(selects) == expected_selects
    assert not any(
        statement.lstrip().upper().startswith("UPDATE") for statement in statements
    )
    assert not any(
        statement.lstrip().upper().startswith("DELETE") for statement in statements
    )
    assert "FOR SHARE OF menu_items, categories" in selects[-1]
    assert "FOR UPDATE" not in " ".join(selects)
    if order_type == "dine_in":
        assert "restaurant_tables" in selects[0]
        assert "FOR SHARE OF restaurant_tables" in selects[0]
        assert "menu_items" in selects[1]


def test_rate_limit_uses_ten_per_minute_zero_sql_on_denial_and_resets(
    test_database_engine: Engine,
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    clock = FakeClock()
    limiter = FixedWindowRateLimiter(limit=10, window_seconds=60, clock=clock)
    application = create_app(
        settings=Settings(database_url=None),
        session_factory=creation_session_factory,
        order_creation_rate_limiter=limiter,
    )
    with TestClient(application, client=("198.51.100.10", 50000)) as test_client:
        for _ in range(10):
            assert (
                test_client.post(
                    CREATE_PATH, json=_takeaway_payload(menu_records)
                ).status_code
                == 201
            )

        statements: list[str] = []

        def capture_sql(*args: object) -> None:
            statements.append(str(args[2]))

        event.listen(test_database_engine, "before_cursor_execute", capture_sql)
        try:
            denied = test_client.post(CREATE_PATH, json=_takeaway_payload(menu_records))
        finally:
            event.remove(test_database_engine, "before_cursor_execute", capture_sql)
        assert denied.status_code == 429
        assert denied.json() == {"detail": "Too many order creation requests"}
        assert int(denied.headers["retry-after"]) > 0
        assert statements == []

        clock.advance(61)
        assert (
            test_client.post(
                CREATE_PATH, json=_takeaway_payload(menu_records)
            ).status_code
            == 201
        )


def test_rate_limit_buckets_are_isolated_by_direct_client_host(
    creation_session_factory: sessionmaker[Session],
    menu_records: MenuRecords,
) -> None:
    application = create_app(
        settings=Settings(database_url=None),
        session_factory=creation_session_factory,
        order_creation_rate_limiter=FixedWindowRateLimiter(limit=10, window_seconds=60),
    )
    with (
        TestClient(application, client=("198.51.100.20", 50000)) as client_a,
        TestClient(application, client=("198.51.100.21", 50000)) as client_b,
    ):
        for _ in range(10):
            assert (
                client_a.post(
                    CREATE_PATH,
                    json=_takeaway_payload(menu_records),
                    headers={"X-Forwarded-For": "198.51.100.21"},
                ).status_code
                == 201
            )
        assert (
            client_a.post(CREATE_PATH, json=_takeaway_payload(menu_records)).status_code
            == 429
        )
        assert (
            client_b.post(CREATE_PATH, json=_takeaway_payload(menu_records)).status_code
            == 201
        )


def test_openapi_documents_creation_without_payment_or_internal_fields(
    client: TestClient,
) -> None:
    document = client.get("/openapi.json").json()
    operation = document["paths"][CREATE_PATH]["post"]
    assert operation["tags"] == ["orders"]
    assert operation["summary"] == "Create an order"
    assert operation["requestBody"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/OrderCreateRequest")
    assert operation["responses"]["201"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/OrderCreateResponse")
    assert {"201", "404", "409", "422", "429"} <= set(operation["responses"])
    assert "get" in document["paths"]["/api/v1/orders/{public_order_number}"]
    assert "post" in document["paths"][QUOTE_PATH]
    assert "get" not in document["paths"][QUOTE_PATH]
    response_schema = str(document["components"]["schemas"]["OrderCreateResponse"])
    assert all(
        value not in response_schema
        for value in (
            "order_access_token_hash",
            "cost_amount",
            "tax_rate",
            "discount_amount",
            "payment_summary",
            "Payment",
            "Stripe",
        )
    )
