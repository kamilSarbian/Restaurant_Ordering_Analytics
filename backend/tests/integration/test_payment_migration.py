"""Integration tests for the Stage 9B-1 Payment migration lifecycle."""

from __future__ import annotations

from sqlalchemy import BigInteger, DateTime, String, Text, inspect, text
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

EXPECTED_STAGE_EIGHT_TABLES = {
    "alembic_version",
    "categories",
    "menu_items",
    "order_items",
    "order_status_history",
    "orders",
    "restaurant_tables",
}
EXPECTED_HEAD_TABLES = EXPECTED_STAGE_EIGHT_TABLES | {"payments"}
EXPECTED_CHECKS = {
    "ck_payments_amount_positive",
    "ck_payments_checkout_session_fields_consistent",
    "ck_payments_currency_format",
    "ck_payments_status_allowed",
}
EXPECTED_UNIQUES = {
    "uq_payments_order_id_request_idempotency_key",
    "uq_payments_stripe_checkout_session_id",
    "uq_payments_stripe_idempotency_key",
}
EXPECTED_INDEXES = {
    "ix_payments_order_created_at_id",
    "ix_payments_order_pending_unique",
    "ix_payments_order_succeeded_unique",
}


def _upgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.upgrade(config, revision)


def _downgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.downgrade(config, revision)


def _assert_payment_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    assert inspector.get_pk_constraint("payments")["name"] == "pk_payments"
    assert {
        constraint["name"] for constraint in inspector.get_check_constraints("payments")
    } == EXPECTED_CHECKS
    assert {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("payments")
    } == EXPECTED_UNIQUES
    foreign_keys = inspector.get_foreign_keys("payments")
    assert len(foreign_keys) == 1
    assert foreign_keys[0]["name"] == "fk_payments_order_id_orders"
    assert foreign_keys[0]["referred_table"] == "orders"
    assert foreign_keys[0]["options"]["ondelete"] == "RESTRICT"

    indexes = {
        index["name"]: index
        for index in inspector.get_indexes("payments")
        if index["name"].startswith("ix_")
    }
    assert set(indexes) == EXPECTED_INDEXES
    assert indexes["ix_payments_order_created_at_id"]["column_names"] == [
        "order_id",
        "created_at",
        "id",
    ]
    assert indexes["ix_payments_order_created_at_id"]["unique"] is False
    for status in ("pending", "succeeded"):
        index = indexes[f"ix_payments_order_{status}_unique"]
        assert index["column_names"] == ["order_id"]
        assert index["unique"] is True

    with engine.connect() as connection:
        definitions = dict(
            connection.execute(
                text(
                    "SELECT indexname, indexdef FROM pg_indexes "
                    "WHERE schemaname = 'public' AND tablename = 'payments' "
                    "AND indexname LIKE 'ix_%'"
                )
            ).all()
        )
    for status in ("pending", "succeeded"):
        definition = definitions[f"ix_payments_order_{status}_unique"].lower()
        assert "unique index" in definition
        assert "order_id" in definition
        assert "where" in definition
        assert f"'{status}'" in definition


def test_payment_migration_has_the_approved_parent() -> None:
    """Keep 0004 as the single additive child of the order migration."""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(_alembic_config())
    revision = script.get_revision("0004_create_payment_model")
    assert revision is not None
    assert revision.revision == HEAD_REVISION
    assert revision.down_revision == "0003_create_order_models"
    assert script.get_current_head() == HEAD_REVISION


def test_upgrade_downgrade_and_second_upgrade_preserve_stage_eight(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Cycle 0003 and 0004 without changing the Stage 8 schema."""
    try:
        _downgrade(test_database_url, "0003_create_order_models")
        assert _current_revision(test_database_url) == "0003_create_order_models"
        assert _public_tables(test_database_url) == EXPECTED_STAGE_EIGHT_TABLES

        _upgrade(test_database_url, "0004_create_payment_model")
        assert _current_revision(test_database_url) == HEAD_REVISION
        assert _public_tables(test_database_url) == EXPECTED_HEAD_TABLES
        _assert_payment_schema(test_database_engine)

        _downgrade(test_database_url, "0003_create_order_models")
        assert _current_revision(test_database_url) == "0003_create_order_models"
        assert _public_tables(test_database_url) == EXPECTED_STAGE_EIGHT_TABLES
        assert "payments" not in inspect(test_database_engine).get_table_names()
    finally:
        _upgrade(test_database_url, "head")

    assert _current_revision(test_database_url) == HEAD_REVISION
    assert _public_tables(test_database_url) == EXPECTED_HEAD_TABLES


def test_payment_model_matches_migration_and_alembic_has_no_drift(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Compare the Payment columns and run Alembic drift detection."""
    _assert_payment_schema(test_database_engine)
    inspector = inspect(test_database_engine)
    migrated_columns = {
        column["name"]: column for column in inspector.get_columns("payments")
    }
    model_columns = metadata.tables["payments"].columns
    assert set(migrated_columns) == set(model_columns.keys())
    for column_name, model_column in model_columns.items():
        assert migrated_columns[column_name]["nullable"] is model_column.nullable
        assert (migrated_columns[column_name]["default"] is None) is (
            model_column.server_default is None
        )

    assert isinstance(migrated_columns["id"]["type"], PostgreSQLUUID)
    assert isinstance(migrated_columns["order_id"]["type"], PostgreSQLUUID)
    assert isinstance(
        migrated_columns["request_idempotency_key"]["type"], PostgreSQLUUID
    )
    assert isinstance(migrated_columns["status"]["type"], String)
    assert isinstance(migrated_columns["amount"]["type"], BigInteger)
    assert isinstance(migrated_columns["currency"]["type"], String)
    assert isinstance(migrated_columns["stripe_checkout_url"]["type"], Text)
    for column_name in (
        "stripe_checkout_expires_at",
        "created_at",
        "updated_at",
    ):
        assert isinstance(migrated_columns[column_name]["type"], DateTime)
        assert migrated_columns[column_name]["type"].timezone is True

    with _temporary_database_url(test_database_url):
        command.check(_alembic_config())
