"""Integration tests for the nullable Order ownership migration."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.engine import URL, Engine
from sqlalchemy.exc import IntegrityError

from alembic import command
from tests.integration.conftest import (
    HEAD_REVISION,
    _alembic_config,
    _current_revision,
    _public_tables,
    _temporary_database_url,
)

pytestmark = pytest.mark.integration

REVISION_0007 = "0007_unify_user_auth_roles"
REVISION_0008 = "0008_add_order_ownership"
OWNERSHIP_FOREIGN_KEY = "fk_orders_customer_user_id_users"
OWNERSHIP_INDEX = "ix_orders_customer_user_created_at_id"
EXPECTED_HEAD_TABLES = {
    "alembic_version",
    "categories",
    "menu_items",
    "order_items",
    "order_status_history",
    "orders",
    "payments",
    "restaurant_tables",
    "stripe_events",
    "users",
}


def _upgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.upgrade(config, revision)


def _downgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.downgrade(config, revision)


def _empty_head(database_url: URL, engine: Engine) -> None:
    _upgrade(database_url, "head")
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM stripe_events"))
        connection.execute(text("DELETE FROM payments"))
        connection.execute(text("DELETE FROM order_status_history"))
        connection.execute(text("DELETE FROM order_items"))
        connection.execute(text("DELETE FROM orders"))
        connection.execute(text("DELETE FROM users"))


def _insert_order(
    engine: Engine,
    *,
    order_id: uuid.UUID,
    public_order_number: str,
    customer_user_id: uuid.UUID | None = None,
) -> None:
    columns = [
        "id",
        "public_order_number",
        "order_access_token_hash",
        "order_type",
        "table_id",
        "table_number_snapshot",
        "status",
        "currency",
        "subtotal_amount",
        "total_amount",
    ]
    values: dict[str, object] = {
        "id": order_id,
        "public_order_number": public_order_number,
        "order_access_token_hash": order_id.hex + order_id.hex,
        "order_type": "takeaway",
        "table_id": None,
        "table_number_snapshot": None,
        "status": "created",
        "currency": "NOK",
        "subtotal_amount": 53700,
        "total_amount": 53700,
    }
    if customer_user_id is not None:
        columns.append("customer_user_id")
        values["customer_user_id"] = customer_user_id
    column_sql = ", ".join(columns)
    value_sql = ", ".join(f":{column}" for column in columns)
    with engine.begin() as connection:
        connection.execute(
            text(f"INSERT INTO orders ({column_sql}) VALUES ({value_sql})"),
            values,
        )


def _insert_user(engine: Engine, *, user_id: uuid.UUID, email: str) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users "
                "(id, email, password_hash, role, is_active) "
                "VALUES (:id, :email, :password_hash, 'customer', true)"
            ),
            {
                "id": user_id,
                "email": email,
                "password_hash": "synthetic-order-ownership-hash",
            },
        )


def _order_snapshot(engine: Engine, order_id: uuid.UUID) -> dict[str, Any]:
    with engine.connect() as connection:
        row = (
            connection.execute(
                text(
                    "SELECT id, public_order_number, order_type, table_id, "
                    "table_number_snapshot, status, currency, subtotal_amount, "
                    "total_amount FROM orders WHERE id = :order_id"
                ),
                {"order_id": order_id},
            )
            .mappings()
            .one()
        )
    return dict(row)


def _ownership_schema(engine: Engine) -> tuple[dict[str, Any], dict[str, Any]]:
    inspector = inspect(engine)
    foreign_keys = {
        foreign_key["name"]: foreign_key
        for foreign_key in inspector.get_foreign_keys("orders")
    }
    indexes = {
        index["name"]: index
        for index in inspector.get_indexes("orders")
        if index["name"].startswith("ix_")
    }
    return foreign_keys, indexes


def test_revision_is_the_single_child_of_unified_user_migration() -> None:
    """Keep ownership as the exact single head after unified Users."""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(_alembic_config())
    revision = script.get_revision(REVISION_0008)
    assert revision is not None
    assert revision.revision == REVISION_0008
    assert revision.down_revision == REVISION_0007
    assert script.get_current_head() == HEAD_REVISION


def test_upgrade_adds_exact_schema_and_preserves_historical_order(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Add nullable ownership without rewriting a historical Order."""
    order_id = uuid.uuid4()
    public_order_number = "ROA-23456789ABCD"
    _empty_head(test_database_url, test_database_engine)
    try:
        _downgrade(test_database_url, REVISION_0007)
        before_tables = _public_tables(test_database_url)
        _insert_order(
            test_database_engine,
            order_id=order_id,
            public_order_number=public_order_number,
        )
        before = _order_snapshot(test_database_engine, order_id)

        _upgrade(test_database_url, REVISION_0008)

        inspector = inspect(test_database_engine)
        ownership_column = {
            column["name"]: column for column in inspector.get_columns("orders")
        }["customer_user_id"]
        assert isinstance(ownership_column["type"], PostgreSQLUUID)
        assert ownership_column["nullable"] is True
        assert ownership_column["default"] is None

        foreign_keys, indexes = _ownership_schema(test_database_engine)
        ownership_foreign_key = foreign_keys[OWNERSHIP_FOREIGN_KEY]
        assert ownership_foreign_key["constrained_columns"] == ["customer_user_id"]
        assert ownership_foreign_key["referred_table"] == "users"
        assert ownership_foreign_key["referred_columns"] == ["id"]
        assert ownership_foreign_key["options"]["ondelete"] == "SET NULL"
        assert set(indexes) == {OWNERSHIP_INDEX}
        assert indexes[OWNERSHIP_INDEX]["column_names"] == [
            "customer_user_id",
            "created_at",
            "id",
        ]
        assert indexes[OWNERSHIP_INDEX]["unique"] is False
        assert _public_tables(test_database_url) == before_tables

        with test_database_engine.connect() as connection:
            ownership = connection.execute(
                text("SELECT customer_user_id FROM orders WHERE id = :order_id"),
                {"order_id": order_id},
            ).scalar_one()
        assert ownership is None
        assert _order_snapshot(test_database_engine, order_id) == before
    finally:
        _empty_head(test_database_url, test_database_engine)


def test_head_accepts_guest_and_valid_owner_but_rejects_unknown_user(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Allow NULL or valid ownership while enforcing the User foreign key."""
    _empty_head(test_database_url, test_database_engine)
    try:
        user_id = uuid.uuid4()
        guest_order_id = uuid.uuid4()
        owned_order_id = uuid.uuid4()
        _insert_user(
            test_database_engine,
            user_id=user_id,
            email="ownership-valid@example.com",
        )
        _insert_order(
            test_database_engine,
            order_id=guest_order_id,
            public_order_number="ROA-3456789ABCDE",
        )
        _insert_order(
            test_database_engine,
            order_id=owned_order_id,
            public_order_number="ROA-456789ABCDEF",
            customer_user_id=user_id,
        )

        with pytest.raises(IntegrityError):
            _insert_order(
                test_database_engine,
                order_id=uuid.uuid4(),
                public_order_number="ROA-56789ABCDEFG",
                customer_user_id=uuid.uuid4(),
            )

        with test_database_engine.connect() as connection:
            rows = dict(
                connection.execute(
                    text(
                        "SELECT id, customer_user_id FROM orders "
                        "WHERE id IN (:guest_order_id, :owned_order_id)"
                    ),
                    {
                        "guest_order_id": guest_order_id,
                        "owned_order_id": owned_order_id,
                    },
                ).all()
            )
        assert rows == {guest_order_id: None, owned_order_id: user_id}
    finally:
        _empty_head(test_database_url, test_database_engine)


def test_deleting_user_sets_owner_null_and_preserves_order(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Apply ON DELETE SET NULL without application cleanup or Order loss."""
    _empty_head(test_database_url, test_database_engine)
    try:
        user_id = uuid.uuid4()
        order_id = uuid.uuid4()
        _insert_user(
            test_database_engine,
            user_id=user_id,
            email="ownership-delete@example.com",
        )
        _insert_order(
            test_database_engine,
            order_id=order_id,
            public_order_number="ROA-6789ABCDEFGH",
            customer_user_id=user_id,
        )
        before = _order_snapshot(test_database_engine, order_id)

        with test_database_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM users WHERE id = :user_id"),
                {"user_id": user_id},
            )

        with test_database_engine.connect() as connection:
            ownership = connection.execute(
                text("SELECT customer_user_id FROM orders WHERE id = :order_id"),
                {"order_id": order_id},
            ).scalar_one()
        assert ownership is None
        assert _order_snapshot(test_database_engine, order_id) == before
    finally:
        _empty_head(test_database_url, test_database_engine)


def test_downgrade_removes_only_ownership_schema_and_second_upgrade_succeeds(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Remove and restore ownership schema without deleting the Order."""
    _empty_head(test_database_url, test_database_engine)
    try:
        user_id = uuid.uuid4()
        order_id = uuid.uuid4()
        _insert_user(
            test_database_engine,
            user_id=user_id,
            email="ownership-round-trip@example.com",
        )
        _insert_order(
            test_database_engine,
            order_id=order_id,
            public_order_number="ROA-789ABCDEFGHJ",
            customer_user_id=user_id,
        )
        before_tables = _public_tables(test_database_url)
        before = _order_snapshot(test_database_engine, order_id)

        _downgrade(test_database_url, REVISION_0007)

        inspector = inspect(test_database_engine)
        assert _current_revision(test_database_url) == REVISION_0007
        assert "customer_user_id" not in {
            column["name"] for column in inspector.get_columns("orders")
        }
        assert OWNERSHIP_FOREIGN_KEY not in {
            foreign_key["name"] for foreign_key in inspector.get_foreign_keys("orders")
        }
        assert OWNERSHIP_INDEX not in {
            index["name"] for index in inspector.get_indexes("orders")
        }
        assert _public_tables(test_database_url) == before_tables
        assert _order_snapshot(test_database_engine, order_id) == before

        _upgrade(test_database_url, "head")

        assert _current_revision(test_database_url) == HEAD_REVISION
        assert "customer_user_id" in {
            column["name"]
            for column in inspect(test_database_engine).get_columns("orders")
        }
        foreign_keys, indexes = _ownership_schema(test_database_engine)
        assert OWNERSHIP_FOREIGN_KEY in foreign_keys
        assert OWNERSHIP_INDEX in indexes
        with test_database_engine.connect() as connection:
            ownership = connection.execute(
                text("SELECT customer_user_id FROM orders WHERE id = :order_id"),
                {"order_id": order_id},
            ).scalar_one()
        assert ownership is None
        assert _order_snapshot(test_database_engine, order_id) == before
    finally:
        _empty_head(test_database_url, test_database_engine)
