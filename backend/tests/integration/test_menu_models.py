"""Integration tests for the PostgreSQL menu models and migration schema."""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from unittest.mock import patch

import pytest
from sqlalchemy import DateTime, create_engine, delete, inspect, select, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.engine import URL, Engine
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from app.categories.models import Category
from app.menu.models import MenuItem
from tests.integration.conftest import (
    ADMIN_DATABASE_NAME,
    DEVELOPMENT_DATABASE_NAME,
    REQUIRED_DRIVER,
    REQUIRED_PORT,
    TEST_DATABASE_NAME,
    _drop_test_database,
    _recreate_test_database,
    _terminate_test_database_connections,
    _validate_admin_engine,
    _validate_test_database_name,
)

pytestmark = pytest.mark.integration

EXPECTED_CATEGORY_CHECKS = {
    "ck_categories_display_order_nonnegative",
    "ck_categories_name_not_blank",
}
EXPECTED_MENU_ITEM_CHECKS = {
    "ck_menu_items_cost_amount_nonnegative",
    "ck_menu_items_currency_format",
    "ck_menu_items_display_order_nonnegative",
    "ck_menu_items_name_not_blank",
    "ck_menu_items_price_amount_positive",
}
EXPECTED_INDEXES = {
    "ix_categories_active_display_order",
    "ix_categories_name_normalized_unique",
    "ix_menu_items_active_category_display_order",
    "ix_menu_items_category_name_normalized_unique",
    "ix_payments_order_created_at_id",
    "ix_payments_order_pending_unique",
    "ix_payments_order_succeeded_unique",
    "ix_stripe_events_payment_created_at_id",
    "ix_stripe_events_session_created_at_id",
}
ADMIN_OPERATIONS: tuple[Callable[[Engine, str], None], ...] = (
    _terminate_test_database_connections,
    _drop_test_database,
    _recreate_test_database,
)


def _admin_engine(
    *,
    drivername: str = REQUIRED_DRIVER,
    host: str = "127.0.0.1",
    port: int = REQUIRED_PORT,
    database: str = ADMIN_DATABASE_NAME,
    username: str | None = "integration-user",
    password: str | None = "integration-password",
) -> Engine:
    if drivername == "sqlite+pysqlite":
        return create_engine("sqlite+pysqlite:///:memory:")
    return create_engine(
        URL.create(
            drivername=drivername,
            username=username,
            password=password,
            host=host,
            port=port,
            database=database,
        )
    )


def _category(name: str = "Main Courses", **values: object) -> Category:
    return Category(name=name, **values)


def _menu_item(
    category: Category,
    name: str = "House Burger",
    **values: object,
) -> MenuItem:
    values.setdefault("price_amount", 12900)
    return MenuItem(category=category, name=name, **values)


def _assert_database_error(session: Session, model: object) -> None:
    session.add(model)
    with pytest.raises((IntegrityError, DataError)):
        session.flush()
    session.rollback()
    assert session.execute(select(1)).scalar_one() == 1


def _normalized_index_definition(definition: str) -> str:
    return "".join(definition.lower().split()).replace("::text", "")


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
def test_valid_admin_engine_is_accepted_without_connecting(host: str) -> None:
    """Accept the approved administrative URL without opening a connection."""
    engine = _admin_engine(host=host)
    try:
        with patch.object(
            engine,
            "connect",
            side_effect=AssertionError("Validation attempted a connection"),
        ):
            _validate_admin_engine(engine)
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("host", "port", "database", "password"),
    [
        ("127.0.0.1", 5432, ADMIN_DATABASE_NAME, "integration-password"),
        (
            "database.example.com",
            REQUIRED_PORT,
            ADMIN_DATABASE_NAME,
            "integration-password",
        ),
        (
            "127.0.0.1",
            REQUIRED_PORT,
            DEVELOPMENT_DATABASE_NAME,
            "integration-password",
        ),
        (
            "127.0.0.1",
            REQUIRED_PORT,
            TEST_DATABASE_NAME,
            "integration-password",
        ),
        ("127.0.0.1", REQUIRED_PORT, ADMIN_DATABASE_NAME, None),
    ],
)
def test_admin_engine_validation_rejects_unsafe_urls_without_connecting(
    host: str,
    port: int,
    database: str,
    password: str | None,
) -> None:
    """Reject unsafe administrative URLs before any connection attempt."""
    engine = _admin_engine(
        host=host,
        port=port,
        database=database,
        password=password,
    )
    try:
        with patch.object(
            engine,
            "connect",
            side_effect=AssertionError("Validation attempted a connection"),
        ):
            with pytest.raises(RuntimeError) as exc_info:
                _validate_admin_engine(engine)
        message = str(exc_info.value)
        assert "integration-password" not in message
        assert "://" not in message
    finally:
        engine.dispose()


def test_admin_engine_validation_rejects_invalid_driver_without_connecting() -> None:
    """Reject a non-PostgreSQL driver before attempting a connection."""
    engine = _admin_engine(drivername="sqlite+pysqlite")
    try:
        with patch.object(
            engine,
            "connect",
            side_effect=AssertionError("Validation attempted a connection"),
        ):
            with pytest.raises(RuntimeError, match="PostgreSQL Psycopg driver"):
                _validate_admin_engine(engine)
    finally:
        engine.dispose()


@pytest.mark.parametrize("operation", ADMIN_OPERATIONS)
def test_admin_operations_validate_engine_before_connecting(
    operation: Callable[[Engine, str], None],
) -> None:
    """Make every administrative operation reject an unsafe engine itself."""
    engine = _admin_engine(port=5432)
    try:
        with patch.object(
            engine,
            "connect",
            side_effect=AssertionError("Administrative SQL was attempted"),
        ):
            with pytest.raises(RuntimeError, match="port 5433"):
                operation(engine, TEST_DATABASE_NAME)
    finally:
        engine.dispose()


@pytest.mark.parametrize("operation", ADMIN_OPERATIONS)
@pytest.mark.parametrize(
    "database_name",
    [DEVELOPMENT_DATABASE_NAME, ADMIN_DATABASE_NAME],
)
def test_admin_operations_validate_target_before_connecting(
    operation: Callable[[Engine, str], None],
    database_name: str,
) -> None:
    """Make every administrative operation reject a protected target itself."""
    engine = _admin_engine()
    try:
        with patch.object(
            engine,
            "connect",
            side_effect=AssertionError("Administrative SQL was attempted"),
        ):
            with pytest.raises(
                RuntimeError, match="exact-name safety check"
            ) as exc_info:
                operation(engine, database_name)
        message = str(exc_info.value)
        assert "integration-password" not in message
        assert "://" not in message
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "database_name",
    [DEVELOPMENT_DATABASE_NAME, ADMIN_DATABASE_NAME, "", "another_database"],
)
def test_exact_test_database_name_rejects_other_names(database_name: str) -> None:
    """Reject every administrative target except the exact test database."""
    with pytest.raises(RuntimeError, match="exact-name safety check"):
        _validate_test_database_name(database_name)


def test_exact_test_database_name_is_accepted() -> None:
    """Accept the one approved test database name."""
    _validate_test_database_name(TEST_DATABASE_NAME)


def test_schema_matches_approved_contract(test_database_engine: Engine) -> None:
    """Verify exact tables, constraints, indexes, types, and delete behavior."""
    inspector = inspect(test_database_engine)
    assert set(inspector.get_table_names(schema="public")) == {
        "alembic_version",
        "categories",
        "menu_items",
        "order_items",
        "order_status_history",
        "orders",
        "payments",
        "restaurant_tables",
        "stripe_events",
    }
    assert inspector.get_pk_constraint("categories")["name"] == "pk_categories"
    assert inspector.get_pk_constraint("menu_items")["name"] == "pk_menu_items"

    category_checks = {
        item["name"] for item in inspector.get_check_constraints("categories")
    }
    menu_item_checks = {
        item["name"] for item in inspector.get_check_constraints("menu_items")
    }
    assert category_checks == EXPECTED_CATEGORY_CHECKS
    assert menu_item_checks == EXPECTED_MENU_ITEM_CHECKS

    foreign_keys = inspector.get_foreign_keys("menu_items")
    assert len(foreign_keys) == 1
    assert foreign_keys[0]["name"] == "fk_menu_items_category_id_categories"
    assert foreign_keys[0]["referred_table"] == "categories"
    assert foreign_keys[0]["options"]["ondelete"] == "RESTRICT"

    menu_columns = {
        column["name"]: column for column in inspector.get_columns("menu_items")
    }
    assert isinstance(menu_columns["allergens"]["type"], ARRAY)
    assert menu_columns["allergens"]["nullable"] is False
    for column_name in ("created_at", "updated_at"):
        column_type = menu_columns[column_name]["type"]
        assert isinstance(column_type, DateTime)
        assert column_type.timezone is True

    with test_database_engine.connect() as connection:
        definitions = dict(connection.execute(text("""
                    SELECT indexname, indexdef
                    FROM pg_indexes
                    WHERE schemaname = 'public'
                      AND indexname LIKE 'ix_%'
                    """)).all())
    assert set(definitions) == EXPECTED_INDEXES
    category_unique = _normalized_index_definition(
        definitions["ix_categories_name_normalized_unique"]
    )
    menu_unique = _normalized_index_definition(
        definitions["ix_menu_items_category_name_normalized_unique"]
    )
    category_active = _normalized_index_definition(
        definitions["ix_categories_active_display_order"]
    )
    menu_active = _normalized_index_definition(
        definitions["ix_menu_items_active_category_display_order"]
    )
    assert "lower(btrim((name)))" in category_unique
    assert "category_id,lower(btrim((name)))" in menu_unique
    assert "where(is_activeistrue)" in category_active
    assert "where(is_activeistrue)" in menu_active
    assert "is_available" not in menu_active


def test_category_defaults_and_uuid(db_session: Session) -> None:
    """Create a category with ORM and server-populated values."""
    category = _category()
    db_session.add(category)
    db_session.flush()
    assert isinstance(category.id, uuid.UUID)
    assert category.description is None
    assert category.display_order == 0
    assert category.is_active is True
    assert category.created_at.tzinfo is not None
    assert category.updated_at.tzinfo is not None


def test_category_empty_description_round_trip(db_session: Session) -> None:
    """Preserve an explicitly empty category description after reloading it."""
    category = _category(name="Empty Description", description="")
    db_session.add(category)
    db_session.commit()
    category_id = category.id
    db_session.expunge_all()

    stored = db_session.get(Category, category_id)
    assert stored is not None
    assert stored.description == ""


def test_menu_item_relationship_defaults_and_uuid(db_session: Session) -> None:
    """Create a related menu item and verify its approved defaults."""
    category = _category()
    menu_item = _menu_item(category)
    db_session.add(menu_item)
    db_session.flush()
    assert isinstance(menu_item.id, uuid.UUID)
    assert menu_item.category is category
    assert menu_item in category.menu_items
    assert menu_item.currency == "NOK"
    assert menu_item.allergens == []
    assert menu_item.display_order == 0
    assert menu_item.is_active is True
    assert menu_item.is_available is True
    assert menu_item.created_at.tzinfo is not None
    assert menu_item.updated_at.tzinfo is not None


def test_allergens_round_trip(db_session: Session) -> None:
    """Persist and reload multiple allergen values."""
    menu_item = _menu_item(
        _category(), allergens=["milk", "gluten"], name="Cream Pasta"
    )
    db_session.add(menu_item)
    db_session.commit()
    db_session.expire_all()
    stored = db_session.get(MenuItem, menu_item.id)
    assert stored is not None
    assert stored.allergens == ["milk", "gluten"]


@pytest.mark.parametrize(
    ("is_active", "is_available"),
    [(False, True), (True, False), (False, False)],
)
def test_activity_and_availability_are_independent(
    db_session: Session,
    is_active: bool,
    is_available: bool,
) -> None:
    """Persist every relevant activity and availability combination."""
    menu_item = _menu_item(
        _category(name=f"Category {is_active} {is_available}"),
        name=f"Item {is_active} {is_available}",
        is_active=is_active,
        is_available=is_available,
    )
    db_session.add(menu_item)
    db_session.flush()
    assert menu_item.is_active is is_active
    assert menu_item.is_available is is_available


def test_same_menu_item_name_is_allowed_in_different_categories(
    db_session: Session,
) -> None:
    """Allow the same normalized product name in separate categories."""
    first = _menu_item(_category("Cold Drinks"), name="Coca-Cola")
    second = _menu_item(_category("Meal Deals"), name="Coca-Cola")
    db_session.add_all([first, second])
    db_session.flush()
    assert first.id != second.id


@pytest.mark.parametrize(
    ("cost_amount", "description"),
    [(None, None), (0, ""), (500, "Fresh seasonal description ☕")],
)
def test_cost_and_description_boundaries(
    db_session: Session,
    cost_amount: int | None,
    description: str | None,
) -> None:
    """Accept unknown, zero, and positive costs with optional descriptions."""
    menu_item = _menu_item(
        _category(name=f"Boundary {cost_amount} {description}"),
        name=f"Product {cost_amount} {description}",
        price_amount=1,
        cost_amount=cost_amount,
        description=description,
    )
    db_session.add(menu_item)
    db_session.flush()
    assert menu_item.price_amount == 1
    assert menu_item.cost_amount == cost_amount
    assert menu_item.description == description


def test_unicode_name_and_description(db_session: Session) -> None:
    """Store international text without altering it."""
    category = _category(name="Café Specials ☕", description="Fresh seasonal menu")
    menu_item = _menu_item(
        category,
        name="Chef’s plate 🍽",
        description="Fresh fish — today’s selection",
    )
    db_session.add(menu_item)
    db_session.flush()
    assert menu_item.name == "Chef’s plate 🍽"
    assert menu_item.description == "Fresh fish — today’s selection"


def test_postgresql_server_defaults(db_session: Session) -> None:
    """Omit defaulted fields so PostgreSQL supplies every server default."""
    category_id = uuid.uuid4()
    menu_item_id = uuid.uuid4()
    category_row = db_session.execute(
        text("""
            INSERT INTO categories (id, name)
            VALUES (:id, :name)
            RETURNING display_order, is_active, created_at, updated_at
            """),
        {"id": category_id, "name": "Server Defaults"},
    ).one()
    menu_item_row = db_session.execute(
        text("""
            INSERT INTO menu_items (id, category_id, name, price_amount)
            VALUES (:id, :category_id, :name, :price_amount)
            RETURNING currency, allergens, display_order, is_active,
                      is_available, created_at, updated_at
            """),
        {
            "id": menu_item_id,
            "category_id": category_id,
            "name": "Server Default Item",
            "price_amount": 1,
        },
    ).one()
    assert category_row.display_order == 0
    assert category_row.is_active is True
    assert category_row.created_at.tzinfo is not None
    assert category_row.updated_at.tzinfo is not None
    assert menu_item_row.currency == "NOK"
    assert menu_item_row.allergens == []
    assert menu_item_row.display_order == 0
    assert menu_item_row.is_active is True
    assert menu_item_row.is_available is True
    assert menu_item_row.created_at.tzinfo is not None
    assert menu_item_row.updated_at.tzinfo is not None


def test_mutable_allergens_append_and_remove(
    test_database_engine: Engine,
) -> None:
    """Persist in-place MutableList append and remove operations."""
    category_id = uuid.uuid4()
    menu_item_id = uuid.uuid4()
    with Session(test_database_engine) as session:
        category = Category(id=category_id, name=f"Mutable {category_id}")
        menu_item = MenuItem(
            id=menu_item_id,
            category=category,
            name="Mutable Allergens",
            price_amount=100,
            allergens=["gluten"],
        )
        session.add(menu_item)
        session.commit()

    with Session(test_database_engine) as session:
        menu_item = session.get(MenuItem, menu_item_id)
        assert menu_item is not None
        menu_item.allergens.append("milk")
        session.commit()

    with Session(test_database_engine) as session:
        menu_item = session.get(MenuItem, menu_item_id)
        assert menu_item is not None
        assert menu_item.allergens == ["gluten", "milk"]
        menu_item.allergens.remove("gluten")
        session.commit()

    with Session(test_database_engine) as session:
        menu_item = session.get(MenuItem, menu_item_id)
        assert menu_item is not None
        assert menu_item.allergens == ["milk"]
        session.execute(delete(MenuItem).where(MenuItem.id == menu_item_id))
        session.execute(delete(Category).where(Category.id == category_id))
        session.commit()


def test_updated_at_changes_in_a_new_transaction(
    test_database_engine: Engine,
) -> None:
    """Update the ORM timestamp in a transaction after the original insert."""
    category_id = uuid.uuid4()
    with Session(test_database_engine) as session:
        category = Category(id=category_id, name=f"Timestamp {category_id}")
        session.add(category)
        session.commit()
        original_updated_at = category.updated_at

    # PostgreSQL now() is fixed per transaction; a minimal pause separates starts.
    time.sleep(0.01)
    with Session(test_database_engine) as session:
        category = session.get(Category, category_id)
        assert category is not None
        category.description = "Updated in a separate transaction"
        session.commit()

    with Session(test_database_engine) as session:
        category = session.get(Category, category_id)
        assert category is not None
        assert category.updated_at > original_updated_at
        session.delete(category)
        session.commit()


@pytest.mark.parametrize("name", ["", "   "])
def test_blank_category_name_is_rejected(db_session: Session, name: str) -> None:
    """Reject category names that normalize to an empty value."""
    _assert_database_error(db_session, _category(name=name))


@pytest.mark.parametrize("name", ["", "   "])
def test_blank_menu_item_name_is_rejected(db_session: Session, name: str) -> None:
    """Reject menu item names that normalize to an empty value."""
    category = _category(name=f"Blank Item {uuid.uuid4()}")
    db_session.add(category)
    db_session.commit()
    _assert_database_error(db_session, _menu_item(category, name=name))


def test_negative_category_display_order_is_rejected(db_session: Session) -> None:
    """Enforce the category display order check in PostgreSQL."""
    _assert_database_error(db_session, _category(display_order=-1))


@pytest.mark.parametrize(
    ("field_name", "invalid_value"),
    [
        ("display_order", -1),
        ("price_amount", 0),
        ("price_amount", -1),
        ("cost_amount", -1),
        ("currency", "NO"),
        ("currency", "NOKK"),
        ("currency", "nok"),
        ("currency", "N0K"),
    ],
)
def test_invalid_menu_item_values_are_rejected(
    db_session: Session,
    field_name: str,
    invalid_value: object,
) -> None:
    """Enforce menu item check and length constraints in PostgreSQL."""
    category = _category(name=f"Invalid {field_name} {invalid_value}")
    db_session.add(category)
    db_session.commit()
    values: dict[str, object] = {
        "name": f"Invalid item {field_name} {invalid_value}",
        "price_amount": 100,
    }
    values[field_name] = invalid_value
    _assert_database_error(db_session, MenuItem(category=category, **values))


def test_unknown_category_foreign_key_is_rejected(db_session: Session) -> None:
    """Reject a menu item whose category identifier does not exist."""
    menu_item = MenuItem(
        category_id=uuid.uuid4(),
        name="Orphan Item",
        price_amount=100,
    )
    _assert_database_error(db_session, menu_item)


@pytest.mark.parametrize(
    "duplicate_name",
    ["Drinks", "drinks", " Drinks", "Drinks ", "  DRINKS  "],
)
def test_normalized_category_name_is_unique(
    db_session: Session,
    duplicate_name: str,
) -> None:
    """Reject case-only and outer-whitespace category duplicates."""
    db_session.add(_category(name="Drinks"))
    db_session.commit()
    _assert_database_error(db_session, _category(name=duplicate_name))


@pytest.mark.parametrize(
    "duplicate_name",
    ["Coca-Cola", "coca-cola", " Coca-Cola", "COCA-COLA "],
)
def test_normalized_menu_item_name_is_unique_within_category(
    db_session: Session,
    duplicate_name: str,
) -> None:
    """Reject normalized product duplicates within the same category."""
    category = _category(name=f"Unique Items {duplicate_name}")
    db_session.add(_menu_item(category, name="Coca-Cola"))
    db_session.commit()
    _assert_database_error(
        db_session,
        _menu_item(category, name=duplicate_name),
    )


def test_category_delete_is_restricted_when_menu_items_exist(
    db_session: Session,
) -> None:
    """Retain both records when PostgreSQL rejects category deletion."""
    category = _category(name="Protected Category")
    menu_item = _menu_item(category, name="Protected Item")
    db_session.add(menu_item)
    db_session.commit()
    category_id = category.id
    menu_item_id = menu_item.id

    db_session.delete(category)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()

    assert db_session.get(Category, category_id) is not None
    assert db_session.get(MenuItem, menu_item_id) is not None


@pytest.mark.parametrize(
    ("model_name", "invalid_length"),
    [("category", 121), ("menu_item", 121), ("image_url", 2049)],
)
def test_bounded_field_overflow_is_rejected(
    db_session: Session,
    model_name: str,
    invalid_length: int,
) -> None:
    """Reject values that exceed approved VARCHAR limits."""
    if model_name == "category":
        _assert_database_error(db_session, _category(name="x" * invalid_length))
        return

    category = _category(name=f"Length {model_name}")
    db_session.add(category)
    db_session.commit()
    if model_name == "menu_item":
        model = _menu_item(category, name="x" * invalid_length)
    else:
        model = _menu_item(
            category, name="Image URL Item", image_url="x" * invalid_length
        )
    _assert_database_error(db_session, model)


def test_maximum_bounded_field_lengths_are_accepted(db_session: Session) -> None:
    """Accept values exactly at every approved VARCHAR boundary."""
    category = _category(name="c" * 120)
    menu_item = _menu_item(
        category,
        name="m" * 120,
        image_url="i" * 2048,
    )
    db_session.add(menu_item)
    db_session.flush()
    assert len(category.name) == 120
    assert len(menu_item.name) == 120
    assert menu_item.image_url is not None
    assert len(menu_item.image_url) == 2048
