"""Integration tests for the read-only public menu API."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Generator
from pathlib import Path
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import PostgresDsn
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.categories.models import Category
from app.core.config import Settings
from app.database.dependencies import get_db_session
from app.database.session import create_session_factory
from app.main import create_app
from app.menu.models import MenuItem
from app.menu.queries import get_public_menu, get_public_menu_item
from app.menu.schemas import PublicMenuResponse
from app.seed.runner import seed_menu_data

pytestmark = pytest.mark.integration

WARM_APPLE_CAKE_ID = UUID("95abd9ff-dea5-48fa-aa81-0632fb5caef7")
BACKEND_ROOT = Path(__file__).resolve().parents[2]
INTERNAL_FIELDS = {
    "cost_amount",
    "created_at",
    "updated_at",
    "is_active",
    "category_id",
}


def test_import_app_main_does_not_create_engine() -> None:
    """A fresh interpreter imports the application without creating an Engine."""
    script = """
import sys
import sqlalchemy

def reject_engine_creation(*args, **kwargs):
    raise RuntimeError("Engine creation is forbidden during import")

sqlalchemy.create_engine = reject_engine_creation
import app.main
assert "alembic.command" not in sys.modules
assert "app.seed.runner" not in sys.modules
"""
    environment = {
        key: os.environ[key]
        for key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP")
        if key in os.environ
    }
    environment.update(
        {
            "DATABASE_URL": str(
                PostgresDsn.build(
                    scheme="postgresql+psycopg",
                    host="127.0.0.1",
                    port=5433,
                    path="import_safety",
                )
            ),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONPATH": str(BACKEND_ROOT),
        }
    )

    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=BACKEND_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0
    assert completed.stdout == ""
    assert completed.stderr == ""


@pytest.fixture(autouse=True)
def empty_menu_tables(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep every public API test isolated in the approved test database."""
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
    """Provide a request session factory bound to the isolated test database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def client(
    api_session_factory: sessionmaker[Session],
) -> Generator[TestClient, None, None]:
    """Run the application with an injected isolated session factory."""
    application = create_app(
        settings=Settings(database_url=None),
        session_factory=api_session_factory,
    )
    with TestClient(application) as test_client:
        yield test_client


def _category(
    *,
    name: str,
    display_order: int,
    is_active: bool = True,
    category_id: UUID | None = None,
) -> Category:
    return Category(
        id=category_id or uuid4(),
        name=name,
        description=f"{name} description",
        display_order=display_order,
        is_active=is_active,
    )


def _item(
    category: Category,
    *,
    name: str,
    display_order: int,
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
        price_amount=9900,
        cost_amount=4500,
        currency="NOK",
        allergens=["milk"],
        display_order=display_order,
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


def _all_items(payload: dict[str, object]) -> list[dict[str, object]]:
    categories = payload["categories"]
    assert isinstance(categories, list)
    return [item for category in categories for item in category["items"]]


def _assert_public_item(item: dict[str, object]) -> None:
    assert not INTERNAL_FIELDS.intersection(item)
    assert set(item) == {
        "id",
        "name",
        "description",
        "image_url",
        "price_amount",
        "currency",
        "allergens",
        "display_order",
        "is_available",
    }


def test_empty_database_returns_the_stable_menu_envelope(client: TestClient) -> None:
    first_response = client.get("/api/v1/menu")
    second_response = client.get("/api/v1/menu")

    assert first_response.status_code == 200
    assert first_response.headers["content-type"].startswith("application/json")
    assert first_response.json() == {"categories": []}
    assert second_response.json() == first_response.json()


def test_default_menu_visibility_order_and_public_fields(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
) -> None:
    first = _category(name="First", display_order=10)
    tied = _category(name="Tied", display_order=10)
    inactive_category = _category(name="Inactive", display_order=0, is_active=False)
    empty = _category(name="Empty", display_order=5)
    inactive_items_only = _category(name="Inactive items only", display_order=6)
    first_by_uuid = _item(
        first,
        name="Zulu",
        display_order=10,
        item_id=UUID("00000000-0000-0000-0000-000000000001"),
    )
    second_by_uuid = _item(
        first,
        name="Alpha",
        display_order=10,
        item_id=UUID("00000000-0000-0000-0000-000000000002"),
    )
    unavailable = _item(first, name="Unavailable", display_order=30, is_available=False)
    inactive_item = _item(first, name="Hidden item", display_order=0, is_active=False)
    hidden_by_category = _item(
        inactive_category, name="Hidden category item", display_order=0
    )
    hidden_only_item = _item(
        inactive_items_only, name="Only hidden item", display_order=0, is_active=False
    )
    tied_item = _item(tied, name="Tied item", display_order=0)
    _store(
        api_session_factory,
        first,
        tied,
        inactive_category,
        empty,
        inactive_items_only,
        first_by_uuid,
        second_by_uuid,
        unavailable,
        inactive_item,
        hidden_by_category,
        hidden_only_item,
        tied_item,
    )

    response = client.get("/api/v1/menu")

    assert response.status_code == 200
    assert set(response.json()) == {"categories"}
    categories = response.json()["categories"]
    expected_category_ids = [
        str(category.id)
        for category in sorted(
            (first, tied), key=lambda value: (value.display_order, value.id)
        )
    ]
    assert [category["id"] for category in categories] == expected_category_ids
    first_payload = next(
        category for category in categories if category["id"] == str(first.id)
    )
    assert [item["name"] for item in first_payload["items"]] == [
        "Zulu",
        "Alpha",
        "Unavailable",
    ]
    assert first_payload["items"][-1]["is_available"] is False
    assert all(
        category["name"] not in {"Inactive", "Empty", "Inactive items only"}
        for category in categories
    )
    for category in categories:
        assert set(category) == {
            "id",
            "name",
            "description",
            "display_order",
            "items",
        }
    for item in _all_items(response.json()):
        _assert_public_item(item)


def test_available_only_filters_items_and_categories_that_become_empty(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
) -> None:
    mixed = _category(name="Mixed", display_order=0)
    unavailable_only = _category(name="Unavailable only", display_order=1)
    available = _item(mixed, name="Available", display_order=0)
    unavailable = _item(mixed, name="Unavailable", display_order=1, is_available=False)
    only_unavailable = _item(
        unavailable_only,
        name="Only unavailable",
        display_order=0,
        is_available=False,
    )
    _store(
        api_session_factory,
        mixed,
        unavailable_only,
        available,
        unavailable,
        only_unavailable,
    )

    response = client.get("/api/v1/menu?available_only=true")

    assert response.status_code == 200
    assert [category["name"] for category in response.json()["categories"]] == ["Mixed"]
    assert [item["name"] for item in _all_items(response.json())] == ["Available"]


def test_seeded_menu_returns_five_categories_and_fifteen_items_by_default(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
) -> None:
    seed_menu_data(api_session_factory)

    response = client.get("/api/v1/menu")

    assert response.status_code == 200
    assert len(response.json()["categories"]) == 5
    assert len(_all_items(response.json())) == 15
    cake = next(
        item
        for item in _all_items(response.json())
        if item["id"] == str(WARM_APPLE_CAKE_ID)
    )
    assert cake["name"] == "Warm Apple Cake"
    assert cake["is_available"] is False

    detail_response = client.get(f"/api/v1/menu/items/{WARM_APPLE_CAKE_ID}")
    assert detail_response.status_code == 200
    assert detail_response.json()["is_available"] is False
    assert detail_response.json()["category"]["name"] == "Desserts"


def test_seeded_available_only_menu_returns_fourteen_items(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
) -> None:
    seed_menu_data(api_session_factory)

    response = client.get("/api/v1/menu?available_only=true")

    assert response.status_code == 200
    assert len(response.json()["categories"]) == 5
    assert len(_all_items(response.json())) == 14
    assert str(WARM_APPLE_CAKE_ID) not in {
        item["id"] for item in _all_items(response.json())
    }


@pytest.mark.parametrize("is_available", [True, False])
def test_item_detail_includes_category_for_every_availability_state(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
    is_available: bool,
) -> None:
    category = _category(name="Desserts", display_order=0)
    item = _item(category, name="Cake", display_order=0, is_available=is_available)
    _store(api_session_factory, category, item)

    response = client.get(f"/api/v1/menu/items/{item.id}")

    assert response.status_code == 200
    payload = response.json()
    _assert_public_item(
        {key: value for key, value in payload.items() if key != "category"}
    )
    assert payload["is_available"] is is_available
    assert payload["category"] == {"id": str(category.id), "name": "Desserts"}


@pytest.mark.parametrize("hidden_parent", [False, True])
def test_item_detail_hides_inactive_records(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
    hidden_parent: bool,
) -> None:
    category = _category(name="Category", display_order=0, is_active=not hidden_parent)
    item = _item(category, name="Item", display_order=0, is_active=hidden_parent)
    _store(api_session_factory, category, item)

    response = client.get(f"/api/v1/menu/items/{item.id}")

    assert response.status_code == 404
    assert response.json() == {"detail": "Menu item not found"}


def test_unknown_item_returns_the_exact_not_found_response(client: TestClient) -> None:
    response = client.get(f"/api/v1/menu/items/{uuid4()}")

    assert response.status_code == 404
    assert response.json() == {"detail": "Menu item not found"}


def test_malformed_item_uuid_returns_validation_error(client: TestClient) -> None:
    response = client.get("/api/v1/menu/items/not-a-uuid")

    assert response.status_code == 422


def test_invalid_available_only_value_returns_validation_error(
    client: TestClient,
) -> None:
    response = client.get("/api/v1/menu?available_only=not-a-boolean")

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/api/v1/menu"),
        ("put", "/api/v1/menu"),
        ("patch", "/api/v1/menu"),
        ("delete", "/api/v1/menu"),
        ("post", f"/api/v1/menu/items/{uuid4()}"),
        ("put", f"/api/v1/menu/items/{uuid4()}"),
        ("patch", f"/api/v1/menu/items/{uuid4()}"),
        ("delete", f"/api/v1/menu/items/{uuid4()}"),
    ],
)
def test_public_menu_routes_are_read_only(
    client: TestClient, method: str, path: str
) -> None:
    assert client.request(method, path).status_code == 405


def test_openapi_documents_routes_filter_responses_and_public_fields(
    client: TestClient,
) -> None:
    document = client.get("/openapi.json").json()
    paths = document["paths"]

    assert set(paths["/api/v1/menu"]) == {"get"}
    assert set(paths["/api/v1/menu/items/{item_id}"]) == {"get"}
    parameter = paths["/api/v1/menu"]["get"]["parameters"][0]
    assert parameter["name"] == "available_only"
    assert parameter["schema"]["default"] is False
    assert "temporarily unavailable" in parameter["description"]
    assert "404" in paths["/api/v1/menu/items/{item_id}"]["get"]["responses"]
    schema_text = str(document["components"]["schemas"])
    assert all(field not in schema_text for field in INTERNAL_FIELDS)
    assert paths["/api/v1/menu"]["get"]["tags"] == ["menu"]
    assert paths["/api/v1/menu/items/{item_id}"]["get"]["tags"] == ["menu"]
    assert [
        parameter["name"] for parameter in paths["/api/v1/menu"]["get"]["parameters"]
    ] == ["available_only"]
    item_parameter = paths["/api/v1/menu/items/{item_id}"]["get"]["parameters"][0]
    assert item_parameter["name"] == "item_id"
    assert item_parameter["schema"]["format"] == "uuid"
    assert paths["/api/v1/menu"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]["$ref"].endswith("/PublicMenuResponse")
    assert paths["/api/v1/menu/items/{item_id}"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]["$ref"].endswith("/PublicMenuItemDetailResponse")
    example = document["components"]["schemas"]["PublicMenuResponse"]["example"]
    validated_example = PublicMenuResponse.model_validate_json(json.dumps(example))
    assert all(item["image_url"] is None for item in example["categories"][0]["items"])
    assert {item.is_available for item in validated_example.categories[0].items} == {
        True,
        False,
    }


def test_interactive_documentation_is_available(client: TestClient) -> None:
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200


def test_query_count_public_menu_with_categories_is_two_selects(
    api_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    category = _category(name="Category", display_order=0)
    _store(api_session_factory, category, _item(category, name="Item", display_order=0))
    select_count = 0

    def count_selects(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        nonlocal select_count
        if statement.lstrip().upper().startswith("SELECT"):
            select_count += 1

    event.listen(test_database_engine, "before_cursor_execute", count_selects)
    try:
        with api_session_factory() as session:
            result = get_public_menu(session)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", count_selects)

    assert select_count == 2
    assert [category.name for category in result.categories] == ["Category"]
    assert [item.name for item in result.categories[0].items] == ["Item"]


def test_query_count_public_menu_without_categories_is_one_select(
    api_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    select_count = 0

    def count_selects(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        nonlocal select_count
        if statement.lstrip().upper().startswith("SELECT"):
            select_count += 1

    event.listen(test_database_engine, "before_cursor_execute", count_selects)
    try:
        with api_session_factory() as session:
            result = get_public_menu(session)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", count_selects)

    assert select_count == 1
    assert result.categories == []


def test_query_count_public_menu_item_is_one_select(
    api_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    category = _category(name="Category", display_order=0)
    item = _item(category, name="Item", display_order=0)
    _store(api_session_factory, category, item)
    select_count = 0

    def count_selects(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        nonlocal select_count
        if statement.lstrip().upper().startswith("SELECT"):
            select_count += 1

    event.listen(test_database_engine, "before_cursor_execute", count_selects)
    try:
        with api_session_factory() as session:
            result = get_public_menu_item(session, item.id)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", count_selects)

    assert select_count == 1
    assert result is not None
    assert result.id == item.id
    assert result.category.id == category.id


def test_injected_factory_does_not_create_a_development_engine(
    monkeypatch: pytest.MonkeyPatch,
    api_session_factory: sessionmaker[Session],
) -> None:
    create_engine = MagicMock(
        side_effect=AssertionError("engine creation is forbidden")
    )
    monkeypatch.setattr("app.main.create_database_engine", create_engine)
    application = create_app(
        settings=Settings(database_url=None),
        session_factory=api_session_factory,
    )

    with TestClient(application) as test_client:
        assert test_client.get("/health").status_code == 200
        assert application.state.session_factory is api_session_factory

    create_engine.assert_not_called()


def test_health_does_not_use_session_factory() -> None:
    """The process health endpoint remains independent of database sessions."""
    session_factory = MagicMock(
        side_effect=AssertionError("Health must not create a database session")
    )
    application = create_app(
        settings=Settings(database_url=None),
        session_factory=session_factory,
    )

    with TestClient(application) as test_client:
        response = test_client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    session_factory.assert_not_called()


def test_session_dependency_calls_factory_once_and_closes_session() -> None:
    session = MagicMock(spec=Session)
    context_manager = MagicMock()
    context_manager.__enter__.return_value = session
    factory = MagicMock(return_value=context_manager)
    request = MagicMock()
    request.app.state.session_factory = factory

    dependency = get_db_session(request)
    assert next(dependency) is session
    with pytest.raises(StopIteration):
        next(dependency)

    factory.assert_called_once_with()
    context_manager.__enter__.assert_called_once_with()
    context_manager.__exit__.assert_called_once()
    session.commit.assert_not_called()


def test_lifespan_creates_one_engine_and_disposes_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = MagicMock()
    factory = MagicMock(spec=sessionmaker)
    create_engine = MagicMock(return_value=engine)
    create_factory = MagicMock(return_value=factory)
    monkeypatch.setattr("app.main.create_database_engine", create_engine)
    monkeypatch.setattr("app.main.create_session_factory", create_factory)
    database_url = PostgresDsn.build(
        scheme="postgresql+psycopg",
        host="127.0.0.1",
        port=5433,
        path="restaurant_ordering_analytics_dev",
    )
    application = create_app(settings=Settings(database_url=database_url))

    with TestClient(application) as test_client:
        assert test_client.get("/health").status_code == 200
        assert application.state.session_factory is factory

    create_engine.assert_called_once_with(database_url)
    create_factory.assert_called_once_with(engine)
    engine.dispose.assert_called_once_with()
    assert not hasattr(application.state, "session_factory")


def test_public_reads_do_not_mutate_database_state(
    client: TestClient,
    api_session_factory: sessionmaker[Session],
) -> None:
    category = _category(name="Category", display_order=0)
    item = _item(category, name="Item", display_order=0)
    _store(api_session_factory, category, item)

    def snapshot() -> tuple[list[object], list[object]]:
        with api_session_factory() as session:
            categories = session.execute(
                select(
                    Category.id,
                    Category.name,
                    Category.description,
                    Category.display_order,
                    Category.is_active,
                    Category.created_at,
                    Category.updated_at,
                )
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
                )
            ).all()
        return categories, items

    before = snapshot()

    assert client.get("/api/v1/menu").status_code == 200
    assert client.get(f"/api/v1/menu/items/{item.id}").status_code == 200

    after = snapshot()
    assert after == before


def test_query_result_serializes_after_database_context_closes(
    api_session_factory: sessionmaker[Session],
) -> None:
    category = _category(name="Category", display_order=0)
    _store(api_session_factory, category, _item(category, name="Item", display_order=0))

    with api_session_factory() as session:
        result = get_public_menu(session)

    assert result.model_dump(mode="json")["categories"][0]["name"] == "Category"


def test_application_start_and_first_read_do_not_seed_an_empty_database(
    api_session_factory: sessionmaker[Session],
) -> None:
    application = create_app(
        settings=Settings(database_url=None),
        session_factory=api_session_factory,
    )

    with TestClient(application) as test_client:
        assert test_client.get("/api/v1/menu").json() == {"categories": []}
        assert test_client.get(f"/api/v1/menu/items/{uuid4()}").status_code == 404

    with api_session_factory() as session:
        assert session.scalar(select(Category).limit(1)) is None
        assert session.scalar(select(MenuItem).limit(1)) is None
