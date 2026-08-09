"""Integration tests for the deterministic PostgreSQL menu seed."""

from __future__ import annotations

import uuid
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.categories.models import Category
from app.database.session import create_session_factory
from app.main import app, create_app
from app.menu.models import MenuItem
from app.seed.data import CATEGORY_SEEDS, MENU_ITEM_SEEDS
from app.seed.runner import SeedConflictError, SeedResult, seed_menu_data

pytestmark = pytest.mark.integration

CATEGORY_BY_ID = {seed.id: seed for seed in CATEGORY_SEEDS}
MENU_ITEM_BY_ID = {seed.id: seed for seed in MENU_ITEM_SEEDS}


@pytest.fixture(autouse=True)
def empty_seed_tables(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep every seed test isolated inside the approved test database."""
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
def seed_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create the runner factory bound to the isolated test database."""
    return create_session_factory(test_database_engine)


def _counts(session_factory: sessionmaker[Session]) -> tuple[int, int]:
    with session_factory() as session:
        return (
            session.scalar(select(func.count()).select_from(Category)) or 0,
            session.scalar(select(func.count()).select_from(MenuItem)) or 0,
        )


def _non_seed_counts(engine: Engine) -> tuple[int, int, int, int, int, int, int]:
    with engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT "
                "(SELECT count(*) FROM restaurant_tables), "
                "(SELECT count(*) FROM orders), "
                "(SELECT count(*) FROM order_items), "
                "(SELECT count(*) FROM order_status_history), "
                "(SELECT count(*) FROM payments), "
                "(SELECT count(*) FROM stripe_events), "
                "(SELECT count(*) FROM admin_users)"
            )
        ).one()
    return tuple(int(value) for value in row)


def _assert_canonical_records(session_factory: sessionmaker[Session]) -> None:
    with session_factory() as session:
        categories = {
            item.id: item
            for item in session.scalars(
                select(Category).where(Category.id.in_(CATEGORY_BY_ID))
            )
        }
        menu_items = {
            item.id: item
            for item in session.scalars(
                select(MenuItem).where(MenuItem.id.in_(MENU_ITEM_BY_ID))
            )
        }

        assert set(categories) == set(CATEGORY_BY_ID)
        assert set(menu_items) == set(MENU_ITEM_BY_ID)
        for item_id, expected in CATEGORY_BY_ID.items():
            actual = categories[item_id]
            assert actual.name == expected.name
            assert actual.description == expected.description
            assert actual.display_order == expected.display_order
            assert actual.is_active is expected.is_active
            assert actual.created_at.tzinfo is not None
            assert actual.updated_at.tzinfo is not None

        for item_id, expected in MENU_ITEM_BY_ID.items():
            actual = menu_items[item_id]
            assert actual.category_id == expected.category_id
            assert actual.name == expected.name
            assert actual.description == expected.description
            assert actual.image_url == expected.image_url
            assert actual.price_amount == expected.price_amount
            assert actual.cost_amount == expected.cost_amount
            assert actual.currency == expected.currency
            assert actual.allergens == list(expected.allergens)
            assert actual.display_order == expected.display_order
            assert actual.is_active is expected.is_active
            assert actual.is_available is expected.is_available
            assert actual.created_at.tzinfo is not None
            assert actual.updated_at.tzinfo is not None


def _timestamps(
    session_factory: sessionmaker[Session],
) -> dict[uuid.UUID, tuple[object, object]]:
    with session_factory() as session:
        category_rows = session.execute(
            select(Category.id, Category.created_at, Category.updated_at).where(
                Category.id.in_(CATEGORY_BY_ID)
            )
        )
        menu_item_rows = session.execute(
            select(MenuItem.id, MenuItem.created_at, MenuItem.updated_at).where(
                MenuItem.id.in_(MENU_ITEM_BY_ID)
            )
        )
        return {
            item_id: (created_at, updated_at)
            for item_id, created_at, updated_at in (*category_rows, *menu_item_rows)
        }


def _wait_for_distinct_database_timestamp(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory.begin() as session:
        session.execute(text("SELECT pg_sleep(0.01)"))


def test_migration_leaves_business_tables_empty_at_current_head(
    test_database_engine: Engine,
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Prove migrations and database startup do not insert seed records."""
    with test_database_engine.connect() as connection:
        revision = connection.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar_one()
    assert revision == "0006_create_admin_user_model"
    assert _counts(seed_session_factory) == (0, 0)
    assert _non_seed_counts(test_database_engine) == (0, 0, 0, 0, 0, 0, 0)


def test_first_seed_inserts_the_complete_canonical_dataset(
    test_database_engine: Engine,
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Insert all approved records and return the exact processed counts."""
    result = seed_menu_data(seed_session_factory)
    assert result == SeedResult(categories_processed=5, menu_items_processed=15)
    assert _counts(seed_session_factory) == (5, 15)
    assert _non_seed_counts(test_database_engine) == (0, 0, 0, 0, 0, 0, 0)
    _assert_canonical_records(seed_session_factory)

    with seed_session_factory() as session:
        unavailable = session.scalars(
            select(MenuItem).where(MenuItem.is_available.is_(False))
        ).all()
        assert len(unavailable) == 1
        assert unavailable[0].name == "Warm Apple Cake"


def test_second_identical_seed_is_a_true_timestamp_no_op(
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Preserve identifiers and both timestamps during an identical rerun."""
    seed_menu_data(seed_session_factory)
    before = _timestamps(seed_session_factory)

    result = seed_menu_data(seed_session_factory)

    assert result == SeedResult(categories_processed=5, menu_items_processed=15)
    assert _counts(seed_session_factory) == (5, 15)
    assert _timestamps(seed_session_factory) == before
    _assert_canonical_records(seed_session_factory)


@pytest.mark.parametrize(
    ("field_name", "changed_value"),
    [
        ("name", "Altered Category Name"),
        ("description", None),
        ("display_order", 99),
        ("is_active", False),
    ],
)
def test_category_upsert_restores_each_business_field(
    field_name: str,
    changed_value: object,
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Cover every category field in the conditional upsert predicate."""
    seed_menu_data(seed_session_factory)
    seed = CATEGORY_SEEDS[0]
    with seed_session_factory() as session:
        category = session.get(Category, seed.id)
        assert category is not None
        created_at = category.created_at
        setattr(category, field_name, changed_value)
        session.commit()
        changed_updated_at = category.updated_at

    _wait_for_distinct_database_timestamp(seed_session_factory)
    seed_menu_data(seed_session_factory)

    with seed_session_factory() as session:
        category = session.get(Category, seed.id)
        assert category is not None
        assert getattr(category, field_name) == getattr(seed, field_name)
        assert category.created_at == created_at
        assert category.updated_at > changed_updated_at


@pytest.mark.parametrize(
    ("field_name", "changed_value"),
    [
        ("category_id", CATEGORY_SEEDS[1].id),
        ("name", "Altered Menu Item Name"),
        ("description", None),
        ("image_url", "https://example.invalid/temporary.jpg"),
        ("price_amount", 1),
        ("cost_amount", None),
        ("currency", "EUR"),
        ("allergens", ["temporary"]),
        ("display_order", 99),
        ("is_active", False),
        ("is_available", False),
    ],
)
def test_menu_item_upsert_restores_each_business_field(
    field_name: str,
    changed_value: object,
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Cover every menu item field in the conditional upsert predicate."""
    seed_menu_data(seed_session_factory)
    seed = MENU_ITEM_SEEDS[0]
    with seed_session_factory() as session:
        menu_item = session.get(MenuItem, seed.id)
        assert menu_item is not None
        created_at = menu_item.created_at
        setattr(menu_item, field_name, changed_value)
        session.commit()
        changed_updated_at = menu_item.updated_at

    _wait_for_distinct_database_timestamp(seed_session_factory)
    seed_menu_data(seed_session_factory)

    expected = getattr(seed, field_name)
    if field_name == "allergens":
        expected = list(expected)
    with seed_session_factory() as session:
        menu_item = session.get(MenuItem, seed.id)
        assert menu_item is not None
        assert getattr(menu_item, field_name) == expected
        assert menu_item.created_at == created_at
        assert menu_item.updated_at > changed_updated_at


def test_seed_restores_multiple_changed_values_and_activation(
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Restore a changed category and several changed item fields together."""
    seed_menu_data(seed_session_factory)
    category_seed = CATEGORY_SEEDS[2]
    menu_item_seed = MENU_ITEM_SEEDS[3]
    with seed_session_factory() as session:
        category = session.get(Category, category_seed.id)
        menu_item = session.get(MenuItem, menu_item_seed.id)
        assert category is not None
        assert menu_item is not None
        category.description = "Temporary category description"
        category.display_order = 77
        category.is_active = False
        menu_item.description = "Temporary item description"
        menu_item.price_amount = 1
        menu_item.allergens = ["temporary"]
        menu_item.is_active = False
        menu_item.is_available = not menu_item_seed.is_available
        session.commit()

    seed_menu_data(seed_session_factory)
    _assert_canonical_records(seed_session_factory)


def test_seed_recreates_a_deleted_owned_menu_item(
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Reinsert a manually deleted seed item with its fixed identifier."""
    seed_menu_data(seed_session_factory)
    deleted_seed = MENU_ITEM_SEEDS[4]
    with seed_session_factory.begin() as session:
        menu_item = session.get(MenuItem, deleted_seed.id)
        assert menu_item is not None
        session.delete(menu_item)
    assert _counts(seed_session_factory) == (5, 14)

    seed_menu_data(seed_session_factory)

    assert _counts(seed_session_factory) == (5, 15)
    _assert_canonical_records(seed_session_factory)


def test_seed_preserves_unrelated_records_and_timestamps(
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Leave every field of non-seed category and item records unchanged."""
    seed_menu_data(seed_session_factory)
    category_id = uuid.uuid4()
    menu_item_id = uuid.uuid4()
    with seed_session_factory.begin() as session:
        session.add(
            Category(
                id=category_id,
                name="Developer Specials",
                description="Unrelated local category",
                display_order=42,
                is_active=False,
            )
        )
        session.add(
            MenuItem(
                id=menu_item_id,
                category_id=category_id,
                name="Developer Plate",
                description="Unrelated local item",
                image_url="https://example.invalid/developer.jpg",
                price_amount=12345,
                cost_amount=6789,
                currency="EUR",
                allergens=["custom"],
                display_order=43,
                is_active=False,
                is_available=False,
            )
        )
    with seed_session_factory() as session:
        category = session.get(Category, category_id)
        menu_item = session.get(MenuItem, menu_item_id)
        assert category is not None
        assert menu_item is not None
        category_snapshot = (
            category.name,
            category.description,
            category.display_order,
            category.is_active,
            category.created_at,
            category.updated_at,
        )
        menu_item_snapshot = (
            menu_item.category_id,
            menu_item.name,
            menu_item.description,
            menu_item.image_url,
            menu_item.price_amount,
            menu_item.cost_amount,
            menu_item.currency,
            tuple(menu_item.allergens),
            menu_item.display_order,
            menu_item.is_active,
            menu_item.is_available,
            menu_item.created_at,
            menu_item.updated_at,
        )

    seed_menu_data(seed_session_factory)

    with seed_session_factory() as session:
        category = session.get(Category, category_id)
        menu_item = session.get(MenuItem, menu_item_id)
        assert category is not None
        assert menu_item is not None
        assert (
            category.name,
            category.description,
            category.display_order,
            category.is_active,
            category.created_at,
            category.updated_at,
        ) == category_snapshot
        assert (
            menu_item.category_id,
            menu_item.name,
            menu_item.description,
            menu_item.image_url,
            menu_item.price_amount,
            menu_item.cost_amount,
            menu_item.currency,
            tuple(menu_item.allergens),
            menu_item.display_order,
            menu_item.is_active,
            menu_item.is_available,
            menu_item.created_at,
            menu_item.updated_at,
        ) == menu_item_snapshot


def test_normalized_category_conflict_rolls_back_everything(
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Reject a differently owned normalized category name before upserts."""
    unrelated_id = uuid.uuid4()
    with seed_session_factory.begin() as session:
        session.add(Category(id=unrelated_id, name="  starters  "))

    with pytest.raises(SeedConflictError, match="Category name conflicts"):
        seed_menu_data(seed_session_factory)

    assert _counts(seed_session_factory) == (1, 0)
    with seed_session_factory() as session:
        assert session.get(Category, unrelated_id) is not None
        assert (
            session.scalar(
                select(func.count())
                .select_from(Category)
                .where(Category.id.in_(CATEGORY_BY_ID))
            )
            == 0
        )


def test_normalized_menu_item_conflict_rolls_back_everything(
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Reject a differently owned normalized item name in its seed category."""
    category_seed = CATEGORY_SEEDS[0]
    item_seed = MENU_ITEM_SEEDS[0]
    unrelated_id = uuid.uuid4()
    with seed_session_factory.begin() as session:
        session.add(
            Category(
                id=category_seed.id,
                name=category_seed.name,
                description="Pre-existing category",
            )
        )
        session.add(
            MenuItem(
                id=unrelated_id,
                category_id=category_seed.id,
                name=f"  {item_seed.name.lower()}  ",
                price_amount=100,
            )
        )

    with pytest.raises(SeedConflictError, match="Menu item name conflicts"):
        seed_menu_data(seed_session_factory)

    assert _counts(seed_session_factory) == (1, 1)
    with seed_session_factory() as session:
        category = session.get(Category, category_seed.id)
        assert category is not None
        assert category.description == "Pre-existing category"
        assert session.get(MenuItem, unrelated_id) is not None
        assert (
            session.scalar(
                select(func.count())
                .select_from(MenuItem)
                .where(MenuItem.id.in_(MENU_ITEM_BY_ID))
            )
            == 0
        )


def test_last_menu_item_conflict_is_detected_before_any_upsert(
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Preflight the final canonical item before changing earlier records."""
    category_seed = CATEGORY_SEEDS[-1]
    item_seed = MENU_ITEM_SEEDS[-1]
    unrelated_id = uuid.uuid4()
    with seed_session_factory.begin() as session:
        session.add(Category(id=category_seed.id, name=category_seed.name))
        session.add(
            MenuItem(
                id=unrelated_id,
                category_id=category_seed.id,
                name=f" {item_seed.name.upper()} ",
                price_amount=100,
            )
        )

    with pytest.raises(SeedConflictError, match="Sparkling Water"):
        seed_menu_data(seed_session_factory)

    assert _counts(seed_session_factory) == (1, 1)
    with seed_session_factory() as session:
        category = session.get(Category, category_seed.id)
        assert category is not None
        assert category.description is None
        assert session.get(MenuItem, unrelated_id) is not None
        assert (
            session.scalar(
                select(func.count())
                .select_from(MenuItem)
                .where(MenuItem.id.in_(MENU_ITEM_BY_ID))
            )
            == 0
        )


def test_fastapi_import_startup_and_health_do_not_seed(
    seed_session_factory: sessionmaker[Session],
) -> None:
    """Keep imports, application construction, startup, and health side-effect free."""
    assert _counts(seed_session_factory) == (0, 0)
    application = create_app()
    with TestClient(application) as client:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
    assert app.title == application.title
    assert _counts(seed_session_factory) == (0, 0)
