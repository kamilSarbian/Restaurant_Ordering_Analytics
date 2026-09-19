"""Integration proofs for the AF1+B1-2 provider-neutral migration."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import DateTime, String, Text, inspect, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.engine.url import URL

from alembic import command
from app.database.model_registry import metadata
from tests.integration.conftest import (
    HEAD_REVISION,
    _alembic_config,
    _current_revision,
    _temporary_database_url,
)

pytestmark = pytest.mark.integration

REVISION_0008 = "0008_add_order_ownership"
REVISION_0009 = "0009_add_portfolio_demo_origin_and_payment_provider"

EXPECTED_PAYMENT_CHECKS = {
    "ck_payments_amount_positive",
    "ck_payments_checkout_session_fields_consistent",
    "ck_payments_currency_format",
    "ck_payments_provider_allowed",
    "ck_payments_provider_idempotency_key_not_blank",
    "ck_payments_status_allowed",
    "ck_payments_succeeded_at_status_consistent",
}
EXPECTED_PAYMENT_UNIQUES = {
    "uq_payments_order_id_request_idempotency_key",
    "uq_payments_provider_provider_idempotency_key",
    "uq_payments_provider_provider_session_id",
}
EXPECTED_PAYMENT_INDEXES = {
    "ix_payments_order_created_at_id",
    "ix_payments_order_pending_unique",
    "ix_payments_order_succeeded_unique",
    "ix_payments_succeeded_at_id",
}
ORIGINAL_PAYMENT_UNIQUES = {
    "uq_payments_order_id_request_idempotency_key",
    "uq_payments_stripe_checkout_session_id",
    "uq_payments_stripe_idempotency_key",
}


def _upgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.upgrade(config, revision)


def _downgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.downgrade(config, revision)


def _clear_head_data(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM stripe_events"))
        connection.execute(text("DELETE FROM payments"))
        connection.execute(text("DELETE FROM order_status_history"))
        connection.execute(text("DELETE FROM order_items"))
        connection.execute(text("DELETE FROM orders"))


def _insert_legacy_order(connection: Connection) -> uuid.UUID:
    order_id = uuid.uuid4()
    connection.execute(
        text(
            "INSERT INTO orders ("
            "id, public_order_number, order_access_token_hash, order_type, "
            "table_id, table_number_snapshot, status, currency, "
            "subtotal_amount, total_amount"
            ") VALUES ("
            ":id, :public_order_number, :token_hash, 'takeaway', "
            "NULL, NULL, 'created', 'NOK', 100, 100"
            ")"
        ),
        {
            "id": order_id,
            "public_order_number": "ROA-23456789ABCD",
            "token_hash": order_id.hex + order_id.hex,
        },
    )
    return order_id


def _insert_legacy_payment(
    connection: Connection,
    *,
    order_id: uuid.UUID,
    status: str,
    with_session: bool = False,
) -> uuid.UUID:
    payment_id = uuid.uuid4()
    session_id = f"cs_test_{payment_id.hex}" if with_session else None
    connection.execute(
        text(
            "INSERT INTO payments ("
            "id, order_id, status, amount, currency, request_idempotency_key, "
            "stripe_idempotency_key, stripe_checkout_session_id, "
            "stripe_checkout_url, stripe_checkout_expires_at"
            ") VALUES ("
            ":id, :order_id, :status, 100, 'NOK', :request_key, "
            ":provider_key, :session_id, :checkout_url, :expires_at"
            ")"
        ),
        {
            "id": payment_id,
            "order_id": order_id,
            "status": status,
            "request_key": uuid.uuid4(),
            "provider_key": f"checkout-session:{payment_id}",
            "session_id": session_id,
            "checkout_url": (
                "https://checkout.stripe.example/session" if with_session else None
            ),
            "expires_at": (
                datetime(2026, 9, 18, 15, tzinfo=UTC) if with_session else None
            ),
        },
    )
    return payment_id


def _insert_legacy_event(
    connection: Connection,
    *,
    payment_id: uuid.UUID,
    created_at: datetime,
    event_type: str,
    processing_result: str,
) -> None:
    event_id = uuid.uuid4()
    connection.execute(
        text(
            "INSERT INTO stripe_events ("
            "id, stripe_event_id, event_type, livemode, stripe_created_at, "
            "stripe_checkout_session_id, payment_id, processing_result"
            ") VALUES ("
            ":id, :event_id, :event_type, false, :created_at, "
            ":session_id, :payment_id, :processing_result"
            ")"
        ),
        {
            "id": event_id,
            "event_id": f"evt_{event_id.hex}",
            "event_type": event_type,
            "created_at": created_at,
            "session_id": f"cs_test_{payment_id.hex}",
            "payment_id": payment_id,
            "processing_result": processing_result,
        },
    )


def test_0009_is_the_single_approved_head() -> None:
    """Pin the new revision to 0008 and keep it as the only head."""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(_alembic_config())
    revision = script.get_revision(REVISION_0009)
    assert revision is not None
    assert revision.revision == REVISION_0009
    assert revision.down_revision == REVISION_0008
    assert script.get_heads() == [REVISION_0009]
    assert HEAD_REVISION == REVISION_0009


def test_empty_upgrade_matches_models_and_has_no_alembic_drift(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Upgrade an empty 0008 database and verify the final schema contract."""
    _clear_head_data(test_database_engine)
    try:
        _downgrade(test_database_url, REVISION_0008)
        _upgrade(test_database_url, REVISION_0009)

        inspector = inspect(test_database_engine)
        order_columns = {
            column["name"]: column for column in inspector.get_columns("orders")
        }
        payment_columns = {
            column["name"]: column for column in inspector.get_columns("payments")
        }
        version_column = inspector.get_columns("alembic_version")[0]

        assert set(order_columns) == set(metadata.tables["orders"].columns.keys())
        assert set(payment_columns) == set(metadata.tables["payments"].columns.keys())
        assert isinstance(order_columns["data_origin"]["type"], String)
        assert order_columns["data_origin"]["type"].length == 17
        assert order_columns["data_origin"]["nullable"] is False
        assert "live" in str(order_columns["data_origin"]["default"])

        assert isinstance(payment_columns["provider"]["type"], String)
        assert payment_columns["provider"]["type"].length == 11
        assert payment_columns["provider"]["nullable"] is False
        assert payment_columns["provider"]["default"] is None
        assert payment_columns["provider_idempotency_key"]["type"].length == 64
        assert payment_columns["provider_session_id"]["type"].length == 255
        assert isinstance(payment_columns["provider_checkout_url"]["type"], Text)
        for column_name in ("provider_checkout_expires_at", "succeeded_at"):
            assert isinstance(payment_columns[column_name]["type"], DateTime)
            assert payment_columns[column_name]["type"].timezone is True
        assert isinstance(version_column["type"], String)
        assert version_column["type"].length == 64

        assert {
            constraint["name"]
            for constraint in inspector.get_check_constraints("payments")
        } == EXPECTED_PAYMENT_CHECKS
        assert {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("payments")
        } == EXPECTED_PAYMENT_UNIQUES
        indexes = {
            index["name"]: index
            for index in inspector.get_indexes("payments")
            if index["name"].startswith("ix_")
        }
        assert set(indexes) == EXPECTED_PAYMENT_INDEXES
        assert indexes["ix_payments_succeeded_at_id"]["column_names"] == [
            "succeeded_at",
            "id",
        ]
        assert indexes["ix_payments_succeeded_at_id"]["unique"] is False
        with test_database_engine.connect() as connection:
            succeeded_index = connection.execute(
                text(
                    "SELECT indexdef FROM pg_indexes "
                    "WHERE schemaname = 'public' AND tablename = 'payments' "
                    "AND indexname = 'ix_payments_succeeded_at_id'"
                )
            ).scalar_one()
        assert "WHERE" in succeeded_index
        assert "status" in succeeded_index
        assert "'succeeded'" in succeeded_index

        with _temporary_database_url(test_database_url):
            command.check(_alembic_config())
    finally:
        _upgrade(test_database_url, "head")
        _clear_head_data(test_database_engine)


def test_legacy_backfills_rename_and_downgrade_round_trip(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Preserve legacy values, choose earliest evidence, and cycle safely."""
    earliest = datetime(2026, 9, 18, 10, tzinfo=UTC)
    later = earliest + timedelta(minutes=5)
    ignored_earlier = earliest - timedelta(minutes=5)
    _clear_head_data(test_database_engine)
    succeeded_id: uuid.UUID | None = None
    try:
        _downgrade(test_database_url, REVISION_0008)
        with test_database_engine.begin() as connection:
            order_id = _insert_legacy_order(connection)
            succeeded_id = _insert_legacy_payment(
                connection,
                order_id=order_id,
                status="succeeded",
                with_session=True,
            )
            nonsuccess_ids = {
                status: _insert_legacy_payment(
                    connection,
                    order_id=order_id,
                    status=status,
                )
                for status in ("pending", "failed", "expired")
            }
            _insert_legacy_event(
                connection,
                payment_id=succeeded_id,
                created_at=later,
                event_type="checkout.session.async_payment_succeeded",
                processing_result="transitioned",
            )
            _insert_legacy_event(
                connection,
                payment_id=succeeded_id,
                created_at=earliest,
                event_type="checkout.session.completed",
                processing_result="transitioned",
            )
            _insert_legacy_event(
                connection,
                payment_id=succeeded_id,
                created_at=ignored_earlier,
                event_type="checkout.session.completed",
                processing_result="already_applied",
            )
            _insert_legacy_event(
                connection,
                payment_id=succeeded_id,
                created_at=ignored_earlier,
                event_type="checkout.session.async_payment_failed",
                processing_result="transitioned",
            )

        _upgrade(test_database_url, REVISION_0009)
        assert _current_revision(test_database_url) == REVISION_0009
        with test_database_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT data_origin FROM orders WHERE id = :id"),
                    {"id": order_id},
                ).scalar_one()
                == "live"
            )
            succeeded = connection.execute(
                text(
                    "SELECT provider, provider_idempotency_key, "
                    "provider_session_id, provider_checkout_url, "
                    "provider_checkout_expires_at, succeeded_at "
                    "FROM payments WHERE id = :id"
                ),
                {"id": succeeded_id},
            ).one()
            assert succeeded.provider == "stripe_test"
            assert succeeded.provider_idempotency_key == (
                f"checkout-session:{succeeded_id}"
            )
            assert succeeded.provider_session_id == f"cs_test_{succeeded_id.hex}"
            assert succeeded.provider_checkout_url == (
                "https://checkout.stripe.example/session"
            )
            assert succeeded.provider_checkout_expires_at == datetime(
                2026, 9, 18, 15, tzinfo=UTC
            )
            assert succeeded.succeeded_at == earliest
            nonsuccess = dict(
                connection.execute(
                    text(
                        "SELECT status, succeeded_at FROM payments "
                        "WHERE id IN (:pending_id, :failed_id, :expired_id)"
                    ),
                    {
                        "pending_id": nonsuccess_ids["pending"],
                        "failed_id": nonsuccess_ids["failed"],
                        "expired_id": nonsuccess_ids["expired"],
                    },
                ).all()
            )
            assert nonsuccess == {
                "pending": None,
                "failed": None,
                "expired": None,
            }

        _downgrade(test_database_url, REVISION_0008)
        assert _current_revision(test_database_url) == REVISION_0008
        inspector = inspect(test_database_engine)
        order_columns = {column["name"] for column in inspector.get_columns("orders")}
        payment_columns = {
            column["name"] for column in inspector.get_columns("payments")
        }
        assert "data_origin" not in order_columns
        assert "provider" not in payment_columns
        assert "succeeded_at" not in payment_columns
        assert {
            "stripe_idempotency_key",
            "stripe_checkout_session_id",
            "stripe_checkout_url",
            "stripe_checkout_expires_at",
        }.issubset(payment_columns)
        assert {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("payments")
        } == ORIGINAL_PAYMENT_UNIQUES
        with test_database_engine.connect() as connection:
            legacy = connection.execute(
                text(
                    "SELECT stripe_idempotency_key, stripe_checkout_session_id, "
                    "stripe_checkout_url, stripe_checkout_expires_at "
                    "FROM payments WHERE id = :id"
                ),
                {"id": succeeded_id},
            ).one()
            assert legacy.stripe_idempotency_key == f"checkout-session:{succeeded_id}"
            assert legacy.stripe_checkout_session_id == f"cs_test_{succeeded_id.hex}"
            assert legacy.stripe_checkout_url == (
                "https://checkout.stripe.example/session"
            )
            assert legacy.stripe_checkout_expires_at == datetime(
                2026, 9, 18, 15, tzinfo=UTC
            )

        _upgrade(test_database_url, REVISION_0009)
        with test_database_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT succeeded_at FROM payments WHERE id = :id"),
                    {"id": succeeded_id},
                ).scalar_one()
                == earliest
            )
    finally:
        _upgrade(test_database_url, "head")
        _clear_head_data(test_database_engine)


def test_missing_success_evidence_fails_closed_without_partial_schema(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Roll back every 0009 change when a legacy success lacks evidence."""
    _clear_head_data(test_database_engine)
    try:
        _downgrade(test_database_url, REVISION_0008)
        version_length_before = (
            inspect(test_database_engine)
            .get_columns("alembic_version")[0]["type"]
            .length
        )
        with test_database_engine.begin() as connection:
            order_id = _insert_legacy_order(connection)
            payment_id = _insert_legacy_payment(
                connection,
                order_id=order_id,
                status="succeeded",
            )

        with pytest.raises(RuntimeError, match="authoritative success evidence"):
            _upgrade(test_database_url, REVISION_0009)

        assert _current_revision(test_database_url) == REVISION_0008
        inspector = inspect(test_database_engine)
        assert "data_origin" not in {
            column["name"] for column in inspector.get_columns("orders")
        }
        payment_columns = {
            column["name"] for column in inspector.get_columns("payments")
        }
        assert "provider" not in payment_columns
        assert "succeeded_at" not in payment_columns
        assert "stripe_idempotency_key" in payment_columns
        version_column = inspector.get_columns("alembic_version")[0]
        assert version_column["type"].length == version_length_before
        with test_database_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT status FROM payments WHERE id = :id"),
                    {"id": payment_id},
                ).scalar_one()
                == "succeeded"
            )
    finally:
        if _current_revision(test_database_url) == REVISION_0008:
            with test_database_engine.begin() as connection:
                connection.execute(text("DELETE FROM stripe_events"))
                connection.execute(text("DELETE FROM payments"))
                connection.execute(text("DELETE FROM orders"))
        _upgrade(test_database_url, "head")
        _clear_head_data(test_database_engine)


def test_downgrade_rejects_demo_provider_before_destructive_changes(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Fail before reinterpreting a non-Stripe provider row as Stripe."""
    _clear_head_data(test_database_engine)
    try:
        with test_database_engine.begin() as connection:
            order_id = uuid.uuid4()
            payment_id = uuid.uuid4()
            connection.execute(
                text(
                    "INSERT INTO orders ("
                    "id, public_order_number, order_access_token_hash, order_type, "
                    "table_id, table_number_snapshot, status, currency, "
                    "subtotal_amount, total_amount"
                    ") VALUES ("
                    ":id, 'ROA-23456789ABCD', :token_hash, 'takeaway', NULL, NULL, "
                    "'created', 'NOK', 100, 100"
                    ")"
                ),
                {"id": order_id, "token_hash": order_id.hex + order_id.hex},
            )
            connection.execute(
                text(
                    "INSERT INTO payments ("
                    "id, order_id, status, amount, currency, "
                    "request_idempotency_key, provider, provider_idempotency_key"
                    ") VALUES ("
                    ":id, :order_id, 'failed', 100, 'NOK', "
                    ":request_key, 'demo', :provider_key"
                    ")"
                ),
                {
                    "id": payment_id,
                    "order_id": order_id,
                    "request_key": uuid.uuid4(),
                    "provider_key": f"demo:{payment_id}",
                },
            )

        with pytest.raises(RuntimeError, match="non-Stripe payment provider"):
            _downgrade(test_database_url, REVISION_0008)

        assert _current_revision(test_database_url) == REVISION_0009
        inspector = inspect(test_database_engine)
        assert "data_origin" in {
            column["name"] for column in inspector.get_columns("orders")
        }
        assert {"provider", "succeeded_at"}.issubset(
            column["name"] for column in inspector.get_columns("payments")
        )
        with test_database_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT provider FROM payments WHERE id = :id"),
                    {"id": payment_id},
                ).scalar_one()
                == "demo"
            )
    finally:
        _upgrade(test_database_url, "head")
        _clear_head_data(test_database_engine)
