"""Integration tests for the Stage 11B-1 AdminUser migration lifecycle."""

from __future__ import annotations

from sqlalchemy import Boolean, DateTime, String, Text, inspect, text
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.engine import URL, Engine

from alembic import command
from app.database.model_registry import metadata
from tests.integration.conftest import (
    HEAD_REVISION,
    _alembic_config,
    _current_revision,
    _public_tables,
    _temporary_database_url,
)

EXPECTED_0005_TABLES = {
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
EXPECTED_0006_TABLES = EXPECTED_0005_TABLES | {"admin_users"}
EXPECTED_HEAD_TABLES = EXPECTED_0005_TABLES | {"users"}
EXPECTED_COLUMNS = [
    "id",
    "email",
    "password_hash",
    "is_active",
    "created_at",
    "updated_at",
]
EXPECTED_CHECKS = {
    "ck_admin_users_email_normalized",
    "ck_admin_users_email_not_blank",
    "ck_admin_users_password_hash_not_blank",
}


def _upgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.upgrade(config, revision)


def _downgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.downgrade(config, revision)


def _assert_admin_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    columns = {
        column["name"]: column for column in inspector.get_columns("admin_users")
    }
    assert list(columns) == EXPECTED_COLUMNS
    assert isinstance(columns["id"]["type"], PostgreSQLUUID)
    assert columns["id"]["default"] is None
    assert isinstance(columns["email"]["type"], String)
    assert columns["email"]["type"].length == 320
    assert isinstance(columns["password_hash"]["type"], Text)
    assert isinstance(columns["is_active"]["type"], Boolean)
    for column_name in ("created_at", "updated_at"):
        assert isinstance(columns[column_name]["type"], DateTime)
        assert columns[column_name]["type"].timezone is True
        assert columns[column_name]["default"] is not None
    assert columns["is_active"]["default"] is not None
    assert all(column["nullable"] is False for column in columns.values())
    assert inspector.get_pk_constraint("admin_users")["name"] == "pk_admin_users"
    assert {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("admin_users")
    } == {"uq_admin_users_email"}
    assert {
        constraint["name"]
        for constraint in inspector.get_check_constraints("admin_users")
    } == EXPECTED_CHECKS


def test_admin_migration_has_the_approved_parent() -> None:
    """Keep historical 0006 unchanged below the current unified-user head."""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(_alembic_config())
    revision = script.get_revision("0006_create_admin_user_model")
    assert revision is not None
    assert revision.revision == "0006_create_admin_user_model"
    assert revision.down_revision == "0005_create_stripe_event_model"
    assert script.get_current_head() == HEAD_REVISION


def test_upgrade_downgrade_and_second_upgrade_preserve_stage_one_through_ten(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Cycle 0005 and 0006 while retaining every earlier-stage table."""
    try:
        _downgrade(test_database_url, "0005_create_stripe_event_model")
        assert _current_revision(test_database_url) == "0005_create_stripe_event_model"
        assert _public_tables(test_database_url) == EXPECTED_0005_TABLES
        assert "admin_users" not in inspect(test_database_engine).get_table_names()

        _upgrade(test_database_url, "0006_create_admin_user_model")
        assert _current_revision(test_database_url) == "0006_create_admin_user_model"
        assert _public_tables(test_database_url) == EXPECTED_0006_TABLES
        _assert_admin_schema(test_database_engine)
        with test_database_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT count(*) FROM admin_users")
                ).scalar_one()
                == 0
            )

        _downgrade(test_database_url, "0005_create_stripe_event_model")
        assert _current_revision(test_database_url) == "0005_create_stripe_event_model"
        assert _public_tables(test_database_url) == EXPECTED_0005_TABLES
        assert "admin_users" not in inspect(test_database_engine).get_table_names()
        assert {"stripe_events", "payments", "orders", "menu_items"}.issubset(
            _public_tables(test_database_url)
        )
    finally:
        _upgrade(test_database_url, "head")

    assert _current_revision(test_database_url) == HEAD_REVISION
    assert _public_tables(test_database_url) == EXPECTED_HEAD_TABLES


def test_historical_admin_schema_and_current_metadata_have_no_drift(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Retain 0006 coverage while current metadata matches the users table."""
    try:
        _downgrade(test_database_url, "0006_create_admin_user_model")
        _assert_admin_schema(test_database_engine)
    finally:
        _upgrade(test_database_url, "head")

    columns = {
        column["name"]: column
        for column in inspect(test_database_engine).get_columns("users")
    }
    model_columns = metadata.tables["users"].columns
    assert set(columns) == set(model_columns.keys())
    for column_name, model_column in model_columns.items():
        assert columns[column_name]["nullable"] is model_column.nullable
        assert (columns[column_name]["default"] is None) is (
            model_column.server_default is None
        )

    with _temporary_database_url(test_database_url):
        command.check(_alembic_config())
