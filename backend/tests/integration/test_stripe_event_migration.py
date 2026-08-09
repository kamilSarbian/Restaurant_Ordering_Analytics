"""Integration tests for the Stage 10B-1 StripeEvent migration lifecycle."""

from __future__ import annotations

from sqlalchemy import Boolean, DateTime, String, inspect
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

EXPECTED_0004_TABLES = {
    "alembic_version",
    "categories",
    "menu_items",
    "order_items",
    "order_status_history",
    "orders",
    "payments",
    "restaurant_tables",
}
EXPECTED_0005_TABLES = EXPECTED_0004_TABLES | {"stripe_events"}
EXPECTED_HEAD_TABLES = EXPECTED_0005_TABLES | {"admin_users"}
EXPECTED_COLUMNS = [
    "id",
    "stripe_event_id",
    "event_type",
    "livemode",
    "stripe_created_at",
    "stripe_checkout_session_id",
    "payment_id",
    "processing_result",
    "created_at",
]
EXPECTED_CHECKS = {
    "ck_stripe_events_checkout_session_id_not_blank",
    "ck_stripe_events_event_type_allowed",
    "ck_stripe_events_processing_result_allowed",
    "ck_stripe_events_stripe_event_id_not_blank",
}
EXPECTED_INDEXES = {
    "ix_stripe_events_payment_created_at_id": [
        "payment_id",
        "stripe_created_at",
        "id",
    ],
    "ix_stripe_events_session_created_at_id": [
        "stripe_checkout_session_id",
        "stripe_created_at",
        "id",
    ],
}


def _upgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.upgrade(config, revision)


def _downgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.downgrade(config, revision)


def _assert_stripe_event_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    columns = {
        column["name"]: column
        for column in inspector.get_columns("stripe_events", schema="public")
    }
    assert list(columns) == EXPECTED_COLUMNS
    assert isinstance(columns["id"]["type"], PostgreSQLUUID)
    assert isinstance(columns["payment_id"]["type"], PostgreSQLUUID)
    assert isinstance(columns["stripe_event_id"]["type"], String)
    assert columns["stripe_event_id"]["type"].length == 255
    assert isinstance(columns["event_type"]["type"], String)
    assert columns["event_type"]["type"].length == 64
    assert isinstance(columns["stripe_checkout_session_id"]["type"], String)
    assert columns["stripe_checkout_session_id"]["type"].length == 255
    assert isinstance(columns["processing_result"]["type"], String)
    assert columns["processing_result"]["type"].length == 32
    assert isinstance(columns["livemode"]["type"], Boolean)
    for column_name in ("stripe_created_at", "created_at"):
        assert isinstance(columns[column_name]["type"], DateTime)
        assert columns[column_name]["type"].timezone is True
    assert columns["payment_id"]["nullable"] is True
    assert all(
        columns[column_name]["nullable"] is False
        for column_name in set(columns) - {"payment_id"}
    )
    assert columns["created_at"]["default"] is not None
    assert all(
        columns[column_name]["default"] is None
        for column_name in set(columns) - {"created_at"}
    )

    assert inspector.get_pk_constraint("stripe_events")["name"] == ("pk_stripe_events")
    assert {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("stripe_events")
    } == {"uq_stripe_events_stripe_event_id"}
    assert {
        constraint["name"]
        for constraint in inspector.get_check_constraints("stripe_events")
    } == EXPECTED_CHECKS
    foreign_keys = inspector.get_foreign_keys("stripe_events")
    assert len(foreign_keys) == 1
    assert foreign_keys[0]["name"] == "fk_stripe_events_payment_id_payments"
    assert foreign_keys[0]["referred_table"] == "payments"
    assert foreign_keys[0]["referred_columns"] == ["id"]
    assert foreign_keys[0]["constrained_columns"] == ["payment_id"]
    assert foreign_keys[0]["options"]["ondelete"] == "RESTRICT"

    indexes = {
        index["name"]: index
        for index in inspector.get_indexes("stripe_events")
        if index["name"].startswith("ix_")
    }
    assert set(indexes) == set(EXPECTED_INDEXES)
    for name, column_names in EXPECTED_INDEXES.items():
        assert indexes[name]["column_names"] == column_names
        assert indexes[name]["unique"] is False


def test_stripe_event_migration_has_the_approved_parent() -> None:
    """Keep 0005 as the single additive child of the Payment migration."""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(_alembic_config())
    revision = script.get_revision("0005_create_stripe_event_model")
    assert revision is not None
    assert revision.revision == "0005_create_stripe_event_model"
    assert revision.down_revision == "0004_create_payment_model"
    assert script.get_current_head() == HEAD_REVISION


def test_upgrade_downgrade_and_second_upgrade_preserve_existing_schema(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Cycle 0004 and 0005 without changing Payment or Stage 8 tables."""
    try:
        _downgrade(test_database_url, "0004_create_payment_model")
        assert _current_revision(test_database_url) == "0004_create_payment_model"
        assert _public_tables(test_database_url) == EXPECTED_0004_TABLES

        _upgrade(test_database_url, "0005_create_stripe_event_model")
        assert _current_revision(test_database_url) == "0005_create_stripe_event_model"
        assert _public_tables(test_database_url) == EXPECTED_0005_TABLES
        _assert_stripe_event_schema(test_database_engine)

        _downgrade(test_database_url, "0004_create_payment_model")
        assert _current_revision(test_database_url) == "0004_create_payment_model"
        assert _public_tables(test_database_url) == EXPECTED_0004_TABLES
        assert "stripe_events" not in inspect(test_database_engine).get_table_names(
            schema="public"
        )
        assert "payments" in inspect(test_database_engine).get_table_names(
            schema="public"
        )
    finally:
        _upgrade(test_database_url, "head")

    assert _current_revision(test_database_url) == HEAD_REVISION
    assert _public_tables(test_database_url) == EXPECTED_HEAD_TABLES


def test_stripe_event_model_matches_migration_and_alembic_has_no_drift(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Compare StripeEvent metadata with PostgreSQL and detect schema drift."""
    _assert_stripe_event_schema(test_database_engine)
    columns = {
        column["name"]: column
        for column in inspect(test_database_engine).get_columns("stripe_events")
    }
    model_columns = metadata.tables["stripe_events"].columns
    assert set(columns) == set(model_columns.keys())
    for column_name, model_column in model_columns.items():
        assert columns[column_name]["nullable"] is model_column.nullable
        assert (columns[column_name]["default"] is None) is (
            model_column.server_default is None
        )

    with _temporary_database_url(test_database_url):
        command.check(_alembic_config())
