"""Integration tests for the Stage 8 order migration lifecycle."""

from __future__ import annotations

from sqlalchemy import inspect
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
}
EXPECTED_0002_TABLES = {
    "alembic_version",
    "categories",
    "menu_items",
}
STAGE_EIGHT_TABLES = {
    "order_items",
    "order_status_history",
    "orders",
    "restaurant_tables",
}
EXPECTED_0003_TABLES = EXPECTED_0002_TABLES | STAGE_EIGHT_TABLES


def _upgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.upgrade(config, revision)


def _downgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.downgrade(config, revision)


def test_migration_revision_has_the_approved_parent() -> None:
    """Keep 0003 as the single additive child of the menu migration."""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(_alembic_config())
    revision = script.get_revision("0003_create_order_models")
    assert revision is not None
    assert revision.revision == "0003_create_order_models"
    assert revision.down_revision == "0002_create_menu_models"
    assert script.get_current_head() == HEAD_REVISION


def test_upgrade_downgrade_and_second_upgrade_preserve_menu_schema(
    test_database_url: URL,
) -> None:
    """Cycle 0002 and 0003 without dropping the Stage 4 menu tables."""
    _downgrade(test_database_url, "0002_create_menu_models")
    assert _current_revision(test_database_url) == "0002_create_menu_models"
    assert _public_tables(test_database_url) == EXPECTED_0002_TABLES

    _upgrade(test_database_url, "0003_create_order_models")
    assert _current_revision(test_database_url) == "0003_create_order_models"
    assert _public_tables(test_database_url) == EXPECTED_0003_TABLES

    _downgrade(test_database_url, "0002_create_menu_models")
    assert _current_revision(test_database_url) == "0002_create_menu_models"
    tables_after_downgrade = _public_tables(test_database_url)
    assert tables_after_downgrade == EXPECTED_0002_TABLES
    assert STAGE_EIGHT_TABLES.isdisjoint(tables_after_downgrade)

    _upgrade(test_database_url, "head")
    assert _current_revision(test_database_url) == HEAD_REVISION
    assert _public_tables(test_database_url) == EXPECTED_HEAD_TABLES


def test_migrated_schema_matches_models_and_alembic_has_no_drift(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Compare table/column contracts and run Alembic model drift detection."""
    inspector = inspect(test_database_engine)
    assert set(metadata.tables) == EXPECTED_HEAD_TABLES - {"alembic_version"}
    for table_name in metadata.tables:
        model_columns = metadata.tables[table_name].columns
        migrated_columns = {
            column["name"]: column
            for column in inspector.get_columns(table_name, schema="public")
        }
        assert set(model_columns.keys()) == set(migrated_columns)
        for column_name, model_column in model_columns.items():
            assert migrated_columns[column_name]["nullable"] is model_column.nullable
            assert (migrated_columns[column_name]["default"] is None) is (
                model_column.server_default is None
            )

    with _temporary_database_url(test_database_url):
        command.check(_alembic_config())
