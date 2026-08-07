"""Integration tests for persistent order aggregate models."""

from __future__ import annotations

import secrets
import uuid

import pytest
from sqlalchemy import BigInteger, inspect, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from app.categories.models import Category
from app.menu.models import MenuItem
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.statuses import OrderStatus
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration

PUBLIC_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
EXPECTED_CHECKS = {
    "restaurant_tables": {"ck_restaurant_tables_number_positive"},
    "orders": {
        "ck_orders_access_token_hash_format",
        "ck_orders_currency_format",
        "ck_orders_order_type_allowed",
        "ck_orders_order_type_table_consistency",
        "ck_orders_public_order_number_format",
        "ck_orders_status_allowed",
        "ck_orders_subtotal_amount_positive",
        "ck_orders_table_number_snapshot_positive",
        "ck_orders_total_amount_positive",
    },
    "order_items": {
        "ck_order_items_category_name_snapshot_not_blank",
        "ck_order_items_discount_amount_snapshot_nonnegative",
        "ck_order_items_line_total_amount_positive",
        "ck_order_items_line_total_matches_quantity",
        "ck_order_items_name_snapshot_not_blank",
        "ck_order_items_position_nonnegative",
        "ck_order_items_quantity_range",
        "ck_order_items_tax_rate_bps_snapshot_range",
        "ck_order_items_unit_cost_amount_nonnegative",
        "ck_order_items_unit_price_amount_positive",
    },
    "order_status_history": {
        "ck_order_status_history_initial_entry",
        "ck_order_status_history_new_status_allowed",
        "ck_order_status_history_previous_status_allowed",
        "ck_order_status_history_sequence_nonnegative",
    },
}


def _public_order_number() -> str:
    return "ROA-" + "".join(secrets.choice(PUBLIC_ALPHABET) for _ in range(12))


def _token_hash() -> str:
    return uuid.uuid4().hex + uuid.uuid4().hex


def _order(**values: object) -> Order:
    defaults: dict[str, object] = {
        "public_order_number": _public_order_number(),
        "order_access_token_hash": _token_hash(),
        "order_type": "takeaway",
        "table_id": None,
        "table_number_snapshot": None,
        "currency": "NOK",
        "subtotal_amount": 100,
        "total_amount": 100,
    }
    defaults.update(values)
    return Order(**defaults)


def _restaurant_table(session: Session, *, number: int = 1) -> RestaurantTable:
    table = RestaurantTable(number=number)
    session.add(table)
    session.flush()
    return table


def _menu_item(session: Session, *, name: str = "Snapshot Item") -> MenuItem:
    suffix = uuid.uuid4().hex
    category = Category(name=f"Snapshot Category {suffix}")
    item = MenuItem(
        category=category,
        name=f"{name} {suffix}",
        price_amount=100,
        cost_amount=40,
    )
    session.add(item)
    session.flush()
    return item


def _order_item(order: Order, menu_item: MenuItem, **values: object) -> OrderItem:
    defaults: dict[str, object] = {
        "order": order,
        "menu_item_id": menu_item.id,
        "position": 0,
        "category_name_snapshot": "Snapshot Category",
        "name_snapshot": "Snapshot Item",
        "quantity": 2,
        "unit_price_amount": 100,
        "unit_cost_amount": 40,
        "tax_rate_bps_snapshot": None,
        "discount_amount_snapshot": 0,
        "line_total_amount": 200,
    }
    defaults.update(values)
    return OrderItem(**defaults)


def _history(order: Order, **values: object) -> OrderStatusHistory:
    defaults: dict[str, object] = {
        "order": order,
        "sequence": 0,
        "previous_status": None,
        "new_status": OrderStatus.CREATED.value,
    }
    defaults.update(values)
    return OrderStatusHistory(**defaults)


def _assert_database_error(session: Session, model: object) -> None:
    session.add(model)
    with pytest.raises((IntegrityError, DataError)):
        session.flush()
    session.rollback()
    assert session.execute(select(1)).scalar_one() == 1


def test_schema_has_exact_constraints_and_restricted_foreign_keys(
    test_database_engine: Engine,
) -> None:
    """Verify the named schema contract produced by migration 0003."""
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
    }
    for table_name, expected in EXPECTED_CHECKS.items():
        assert {
            constraint["name"]
            for constraint in inspector.get_check_constraints(table_name)
        } == expected

    assert inspector.get_pk_constraint("restaurant_tables")["name"] == (
        "pk_restaurant_tables"
    )
    assert inspector.get_pk_constraint("orders")["name"] == "pk_orders"
    assert inspector.get_pk_constraint("order_items")["name"] == "pk_order_items"
    assert inspector.get_pk_constraint("order_status_history")["name"] == (
        "pk_order_status_history"
    )

    expected_uniques = {
        "restaurant_tables": {"uq_restaurant_tables_number"},
        "orders": {
            "uq_orders_order_access_token_hash",
            "uq_orders_public_order_number",
        },
        "order_items": {
            "uq_order_items_order_id_menu_item_id",
            "uq_order_items_order_id_position",
        },
        "order_status_history": {"uq_order_status_history_order_id_sequence"},
    }
    for table_name, expected in expected_uniques.items():
        assert {
            constraint["name"]
            for constraint in inspector.get_unique_constraints(table_name)
        } == expected

    expected_foreign_keys = {
        "orders": {"fk_orders_table_id_restaurant_tables"},
        "order_items": {
            "fk_order_items_menu_item_id_menu_items",
            "fk_order_items_order_id_orders",
        },
        "order_status_history": {"fk_order_status_history_order_id_orders"},
    }
    for table_name, expected in expected_foreign_keys.items():
        foreign_keys = inspector.get_foreign_keys(table_name)
        assert {foreign_key["name"] for foreign_key in foreign_keys} == expected
        assert {foreign_key["options"]["ondelete"] for foreign_key in foreign_keys} == {
            "RESTRICT"
        }


def test_schema_uses_bigint_and_has_no_unapproved_order_item_fields(
    test_database_engine: Engine,
) -> None:
    """Keep aggregate money wide while retaining the approved snapshot shape."""
    inspector = inspect(test_database_engine)
    order_columns = {
        column["name"]: column for column in inspector.get_columns("orders")
    }
    item_columns = {
        column["name"]: column for column in inspector.get_columns("order_items")
    }
    assert isinstance(order_columns["subtotal_amount"]["type"], BigInteger)
    assert isinstance(order_columns["total_amount"]["type"], BigInteger)
    assert isinstance(item_columns["discount_amount_snapshot"]["type"], BigInteger)
    assert isinstance(item_columns["line_total_amount"]["type"], BigInteger)
    assert {"currency", "created_at", "updated_at"}.isdisjoint(item_columns)


def test_restaurant_table_defaults_uuid_and_timestamps(db_session: Session) -> None:
    """Persist a table with Python and PostgreSQL defaults."""
    table = RestaurantTable(number=7)
    db_session.add(table)
    db_session.flush()
    assert isinstance(table.id, uuid.UUID)
    assert table.is_active is True
    assert table.created_at.tzinfo is not None
    assert table.updated_at.tzinfo is not None


@pytest.mark.parametrize("number", [0, -1])
def test_restaurant_table_rejects_nonpositive_number(
    db_session: Session,
    number: int,
) -> None:
    """Reject zero and negative restaurant table numbers."""
    _assert_database_error(db_session, RestaurantTable(number=number))


def test_restaurant_table_number_is_unique(db_session: Session) -> None:
    """Prevent two restaurant tables from sharing a number."""
    db_session.add(RestaurantTable(number=9))
    db_session.commit()
    _assert_database_error(db_session, RestaurantTable(number=9))


def test_takeaway_order_defaults_uuid_status_timestamps_and_bigint(
    db_session: Session,
) -> None:
    """Persist a takeaway order with created status and wide totals."""
    amount = 2_147_483_648
    order = _order(subtotal_amount=amount, total_amount=amount)
    db_session.add(order)
    db_session.flush()
    assert isinstance(order.id, uuid.UUID)
    assert order.status == OrderStatus.CREATED.value
    assert order.table_id is None
    assert order.table_number_snapshot is None
    assert order.subtotal_amount == amount
    assert order.total_amount == amount
    assert order.created_at.tzinfo is not None
    assert order.updated_at.tzinfo is not None


def test_dine_in_order_preserves_table_number_snapshot(db_session: Session) -> None:
    """Store both the table identity and historical table number."""
    table = _restaurant_table(db_session, number=12)
    order = _order(
        order_type="dine_in",
        table_id=table.id,
        table_number_snapshot=12,
    )
    db_session.add(order)
    db_session.flush()
    table.number = 13
    db_session.flush()
    assert order.table_number_snapshot == 12


@pytest.mark.parametrize("status", list(OrderStatus))
def test_order_accepts_every_approved_status(
    db_session: Session,
    status: OrderStatus,
) -> None:
    """Persist every approved fulfilment status without a native enum."""
    order = _order(status=status.value)
    db_session.add(order)
    db_session.flush()
    assert order.status == status.value


def test_order_rejects_unknown_status(db_session: Session) -> None:
    """Reject payment and unknown values from the fulfilment lifecycle."""
    _assert_database_error(db_session, _order(status="paid"))


@pytest.mark.parametrize(
    "values",
    [
        {"order_type": "delivery"},
        {"order_type": "dine_in"},
        {"table_number_snapshot": 1},
        {
            "order_type": "dine_in",
            "table_id": uuid.uuid4(),
            "table_number_snapshot": 0,
        },
    ],
)
def test_order_rejects_invalid_type_table_combinations(
    db_session: Session,
    values: dict[str, object],
) -> None:
    """Enforce the complete dine-in and takeaway table invariant."""
    _assert_database_error(db_session, _order(**values))


def test_dine_in_order_rejects_unknown_table(db_session: Session) -> None:
    """Require every dine-in order to reference an existing table."""
    _assert_database_error(
        db_session,
        _order(
            order_type="dine_in",
            table_id=uuid.uuid4(),
            table_number_snapshot=1,
        ),
    )


@pytest.mark.parametrize("currency", ["nok", "NO", "NØK", "NOKK"])
def test_order_rejects_invalid_currency(
    db_session: Session,
    currency: str,
) -> None:
    """Require exactly three uppercase ASCII currency letters."""
    _assert_database_error(db_session, _order(currency=currency))


@pytest.mark.parametrize(
    "values",
    [
        {"subtotal_amount": 0},
        {"subtotal_amount": -1},
        {"total_amount": 0},
        {"total_amount": -1},
    ],
)
def test_order_rejects_nonpositive_totals(
    db_session: Session,
    values: dict[str, int],
) -> None:
    """Require positive aggregate totals without enforcing their equality."""
    _assert_database_error(db_session, _order(**values))


@pytest.mark.parametrize(
    "public_order_number",
    [
        "ROA-123456789ABC",
        "ROA-ABCDEFGHIJKI",
        "roa-23456789ABCD",
        "ROA-23456789ABC",
        "ROA-23456789ABCDE",
    ],
)
def test_order_rejects_invalid_public_number(
    db_session: Session,
    public_order_number: str,
) -> None:
    """Enforce the non-ambiguous fixed public number format."""
    _assert_database_error(
        db_session,
        _order(public_order_number=public_order_number),
    )


@pytest.mark.parametrize(
    "token_hash",
    ["a" * 63, "a" * 65, "A" * 64, "g" * 64],
)
def test_order_rejects_invalid_access_token_hash(
    db_session: Session,
    token_hash: str,
) -> None:
    """Store only a fixed lowercase SHA-256 hexadecimal digest."""
    _assert_database_error(
        db_session,
        _order(order_access_token_hash=token_hash),
    )


def test_order_public_number_is_unique(db_session: Session) -> None:
    """Reject duplicate public order numbers."""
    number = _public_order_number()
    db_session.add(_order(public_order_number=number))
    db_session.commit()
    _assert_database_error(db_session, _order(public_order_number=number))


def test_order_access_token_hash_is_unique(db_session: Session) -> None:
    """Reject duplicate access-token hashes."""
    token_hash = _token_hash()
    db_session.add(_order(order_access_token_hash=token_hash))
    db_session.commit()
    _assert_database_error(db_session, _order(order_access_token_hash=token_hash))


def test_order_totals_are_not_required_to_be_equal(db_session: Session) -> None:
    """Keep future tax and discount arithmetic outside database equality checks."""
    order = _order(subtotal_amount=100, total_amount=101)
    db_session.add(order)
    db_session.flush()
    assert order.total_amount != order.subtotal_amount


def test_order_item_persists_approved_snapshot_and_defaults(
    db_session: Session,
) -> None:
    """Persist all D-009 fields without line currency or timestamps."""
    menu_item = _menu_item(db_session)
    order = _order()
    item = _order_item(
        order,
        menu_item,
        category_name_snapshot="Historical Category",
        name_snapshot="Historical Product",
        unit_cost_amount=None,
        tax_rate_bps_snapshot=None,
    )
    item.discount_amount_snapshot = None  # type: ignore[assignment]
    db_session.add(item)
    db_session.flush()
    assert isinstance(item.id, uuid.UUID)
    assert item.discount_amount_snapshot == 0
    assert item.category_name_snapshot == "Historical Category"
    assert item.name_snapshot == "Historical Product"
    assert item.unit_cost_amount is None
    assert item.tax_rate_bps_snapshot is None


@pytest.mark.parametrize("field_name", ["category_name_snapshot", "name_snapshot"])
@pytest.mark.parametrize("value", ["", "   "])
def test_order_item_rejects_blank_snapshot_names(
    db_session: Session,
    field_name: str,
    value: str,
) -> None:
    """Reject blank historical category and product names."""
    menu_item = _menu_item(db_session)
    order = _order()
    db_session.add(order)
    db_session.commit()
    _assert_database_error(
        db_session,
        _order_item(order, menu_item, **{field_name: value}),
    )


@pytest.mark.parametrize(
    "values",
    [
        {"quantity": 0, "line_total_amount": 0},
        {"quantity": 100, "line_total_amount": 10_000},
        {"unit_price_amount": 0, "line_total_amount": 0},
        {"unit_cost_amount": -1},
        {"tax_rate_bps_snapshot": -1},
        {"tax_rate_bps_snapshot": 10001},
        {"discount_amount_snapshot": -1},
        {"line_total_amount": 0},
        {"position": -1},
        {"line_total_amount": 201},
    ],
)
def test_order_item_rejects_invalid_numeric_values(
    db_session: Session,
    values: dict[str, int],
) -> None:
    """Enforce quantity, money, tax, position, and line formula checks."""
    menu_item = _menu_item(db_session)
    order = _order()
    db_session.add(order)
    db_session.commit()
    _assert_database_error(db_session, _order_item(order, menu_item, **values))


@pytest.mark.parametrize(
    ("unit_cost_amount", "tax_rate_bps_snapshot"),
    [(None, None), (0, 0), (40, 10000)],
)
def test_order_item_accepts_cost_and_tax_boundaries(
    db_session: Session,
    unit_cost_amount: int | None,
    tax_rate_bps_snapshot: int | None,
) -> None:
    """Accept nullable and inclusive non-negative snapshot boundaries."""
    menu_item = _menu_item(db_session)
    item = _order_item(
        _order(),
        menu_item,
        unit_cost_amount=unit_cost_amount,
        tax_rate_bps_snapshot=tax_rate_bps_snapshot,
    )
    db_session.add(item)
    db_session.flush()
    assert item.unit_cost_amount == unit_cost_amount
    assert item.tax_rate_bps_snapshot == tax_rate_bps_snapshot


def test_order_item_bigint_formula_exceeds_32_bit(db_session: Session) -> None:
    """Persist a formula-validated line total above signed 32-bit range."""
    menu_item = _menu_item(db_session)
    unit_price_amount = 2_147_483_647
    quantity = 99
    line_total = unit_price_amount * quantity
    item = _order_item(
        _order(subtotal_amount=line_total, total_amount=line_total),
        menu_item,
        quantity=quantity,
        unit_price_amount=unit_price_amount,
        line_total_amount=line_total,
    )
    db_session.add(item)
    db_session.flush()
    assert item.line_total_amount == 212_600_881_053


def test_order_item_rejects_duplicate_position(db_session: Session) -> None:
    """Require each position to occur once per order."""
    order = _order()
    first_menu_item = _menu_item(db_session, name="First")
    second_menu_item = _menu_item(db_session, name="Second")
    db_session.add(_order_item(order, first_menu_item))
    db_session.commit()
    _assert_database_error(
        db_session,
        _order_item(order, second_menu_item, position=0),
    )


def test_order_item_rejects_duplicate_menu_item(db_session: Session) -> None:
    """Require each menu item to occur once per order."""
    order = _order()
    menu_item = _menu_item(db_session)
    db_session.add(_order_item(order, menu_item))
    db_session.commit()
    _assert_database_error(
        db_session,
        _order_item(order, menu_item, position=1),
    )


def test_order_item_rejects_unknown_foreign_keys(db_session: Session) -> None:
    """Require existing Order and MenuItem records."""
    _assert_database_error(
        db_session,
        OrderItem(
            order_id=uuid.uuid4(),
            menu_item_id=uuid.uuid4(),
            position=0,
            category_name_snapshot="Category",
            name_snapshot="Item",
            quantity=1,
            unit_price_amount=100,
            unit_cost_amount=None,
            tax_rate_bps_snapshot=None,
            discount_amount_snapshot=0,
            line_total_amount=100,
        ),
    )


def test_initial_history_defaults_uuid_and_timestamp(db_session: Session) -> None:
    """Persist the one approved initial history entry."""
    history = _history(_order())
    db_session.add(history)
    db_session.flush()
    assert isinstance(history.id, uuid.UUID)
    assert history.sequence == 0
    assert history.previous_status is None
    assert history.new_status == OrderStatus.CREATED.value
    assert history.changed_at.tzinfo is not None


@pytest.mark.parametrize("status", list(OrderStatus))
def test_history_accepts_every_approved_previous_and_new_status(
    db_session: Session,
    status: OrderStatus,
) -> None:
    """Allow every approved status in non-initial history entries."""
    history = _history(
        _order(),
        sequence=1,
        previous_status=status.value,
        new_status=status.value,
    )
    db_session.add(history)
    db_session.flush()
    assert history.previous_status == status.value
    assert history.new_status == status.value


@pytest.mark.parametrize(
    "values",
    [
        {"sequence": -1},
        {"new_status": "paid"},
        {"sequence": 1, "previous_status": "paid", "new_status": "accepted"},
        {"sequence": 0, "previous_status": "created", "new_status": "created"},
        {"sequence": 0, "previous_status": None, "new_status": "accepted"},
        {"sequence": 1, "previous_status": None, "new_status": "accepted"},
    ],
)
def test_history_rejects_invalid_status_and_initial_invariants(
    db_session: Session,
    values: dict[str, object],
) -> None:
    """Enforce valid statuses and the exact sequence-zero entry."""
    _assert_database_error(db_session, _history(_order(), **values))


def test_history_sequence_is_unique_per_order(db_session: Session) -> None:
    """Reject duplicate history sequence numbers within one order."""
    order = _order()
    db_session.add(_history(order))
    db_session.commit()
    _assert_database_error(db_session, _history(order))


def test_relationships_are_ordered_and_have_no_delete_cascade(
    db_session: Session,
) -> None:
    """Load aggregate collections in deterministic business order."""
    order = _order()
    menu_items = [
        _menu_item(db_session, name=f"Position {position}") for position in range(3)
    ]
    items = [
        _order_item(
            order,
            menu_items[position],
            position=position,
            name_snapshot=f"Position {position}",
        )
        for position in (2, 0, 1)
    ]
    history = [
        _history(
            order,
            sequence=2,
            previous_status="accepted",
            new_status="preparing",
        ),
        _history(order),
        _history(
            order,
            sequence=1,
            previous_status="created",
            new_status="accepted",
        ),
    ]
    db_session.add_all([*items, *history])
    db_session.commit()
    order_id = order.id
    db_session.expunge_all()

    stored = db_session.get(Order, order_id)
    assert stored is not None
    assert [item.position for item in stored.items] == [0, 1, 2]
    assert [entry.sequence for entry in stored.status_history] == [0, 1, 2]
    assert Order.items.property.passive_deletes == "all"
    assert Order.status_history.property.passive_deletes == "all"
    assert "delete" not in Order.items.property.cascade
    assert "delete-orphan" not in Order.items.property.cascade
    assert "delete" not in Order.status_history.property.cascade
    assert "delete-orphan" not in Order.status_history.property.cascade


def test_order_item_blocks_menu_item_deletion(db_session: Session) -> None:
    """Retain a MenuItem referenced by a historical order snapshot."""
    menu_item = _menu_item(db_session)
    item = _order_item(_order(), menu_item)
    db_session.add(item)
    db_session.commit()
    menu_item_id = menu_item.id
    item_id = item.id
    db_session.expunge_all()

    stored_menu_item = db_session.get(MenuItem, menu_item_id)
    assert stored_menu_item is not None
    db_session.delete(stored_menu_item)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()
    assert db_session.get(MenuItem, menu_item_id) is not None
    assert db_session.get(OrderItem, item_id) is not None


def test_order_item_blocks_order_deletion(db_session: Session) -> None:
    """Retain an Order referenced by an OrderItem."""
    menu_item = _menu_item(db_session)
    order = _order()
    item = _order_item(order, menu_item)
    db_session.add(item)
    db_session.commit()
    order_id = order.id
    item_id = item.id
    db_session.expunge_all()

    stored_order = db_session.get(Order, order_id)
    assert stored_order is not None
    db_session.delete(stored_order)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()
    assert db_session.get(Order, order_id) is not None
    assert db_session.get(OrderItem, item_id) is not None


def test_history_blocks_order_deletion(db_session: Session) -> None:
    """Retain an Order referenced by status history."""
    order = _order()
    history = _history(order)
    db_session.add(history)
    db_session.commit()
    order_id = order.id
    history_id = history.id
    db_session.expunge_all()

    stored_order = db_session.get(Order, order_id)
    assert stored_order is not None
    db_session.delete(stored_order)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()
    assert db_session.get(Order, order_id) is not None
    assert db_session.get(OrderStatusHistory, history_id) is not None


def test_dine_in_order_blocks_restaurant_table_deletion(
    db_session: Session,
) -> None:
    """Retain a RestaurantTable referenced by a dine-in order."""
    table = _restaurant_table(db_session, number=22)
    order = _order(
        order_type="dine_in",
        table_id=table.id,
        table_number_snapshot=table.number,
    )
    db_session.add(order)
    db_session.commit()
    table_id = table.id
    order_id = order.id
    db_session.expunge_all()

    stored_table = db_session.get(RestaurantTable, table_id)
    assert stored_table is not None
    db_session.delete(stored_table)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()
    assert db_session.get(RestaurantTable, table_id) is not None
    assert db_session.get(Order, order_id) is not None
