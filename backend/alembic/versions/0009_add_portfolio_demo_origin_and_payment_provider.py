"""Add portfolio origin and provider-neutral payment persistence.

Revision ID: 0009_add_portfolio_demo_origin_and_payment_provider
Revises: 0008_add_order_ownership
Create Date: 2026-09-18
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0009_add_portfolio_demo_origin_and_payment_provider"
down_revision: str | Sequence[str] | None = "0008_add_order_ownership"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the approved portfolio-origin and provider-neutral contracts."""
    # Alembic writes the new 51-character revision after upgrade() returns.
    op.alter_column(
        "alembic_version",
        "version_num",
        existing_type=sa.String(length=32),
        type_=sa.String(length=64),
        existing_nullable=False,
    )

    op.add_column(
        "orders",
        sa.Column(
            "data_origin",
            sa.String(length=17),
            server_default=sa.text("'live'"),
            nullable=True,
        ),
    )
    op.execute(sa.text("UPDATE orders SET data_origin = 'live'"))
    op.alter_column(
        "orders",
        "data_origin",
        existing_type=sa.String(length=17),
        existing_server_default=sa.text("'live'"),
        nullable=False,
    )
    op.create_check_constraint(
        op.f("ck_orders_data_origin_allowed"),
        "orders",
        "data_origin IN ('live', 'portfolio_seed', 'portfolio_runtime')",
    )

    op.add_column(
        "payments",
        sa.Column(
            "provider",
            sa.String(length=11),
            server_default=sa.text("'stripe_test'"),
            nullable=True,
        ),
    )
    op.execute(sa.text("UPDATE payments SET provider = 'stripe_test'"))
    op.alter_column(
        "payments",
        "provider",
        existing_type=sa.String(length=11),
        existing_server_default=sa.text("'stripe_test'"),
        server_default=None,
        nullable=False,
    )

    op.drop_constraint(
        op.f("ck_payments_checkout_session_fields_consistent"),
        "payments",
        type_="check",
    )
    op.drop_constraint(
        op.f("uq_payments_stripe_checkout_session_id"),
        "payments",
        type_="unique",
    )
    op.drop_constraint(
        op.f("uq_payments_stripe_idempotency_key"),
        "payments",
        type_="unique",
    )
    op.alter_column(
        "payments",
        "stripe_idempotency_key",
        new_column_name="provider_idempotency_key",
        existing_type=sa.String(length=64),
        existing_nullable=False,
    )
    op.alter_column(
        "payments",
        "stripe_checkout_session_id",
        new_column_name="provider_session_id",
        existing_type=sa.String(length=255),
        existing_nullable=True,
    )
    op.alter_column(
        "payments",
        "stripe_checkout_url",
        new_column_name="provider_checkout_url",
        existing_type=sa.Text(),
        existing_nullable=True,
    )
    op.alter_column(
        "payments",
        "stripe_checkout_expires_at",
        new_column_name="provider_checkout_expires_at",
        existing_type=sa.DateTime(timezone=True),
        existing_nullable=True,
    )
    op.add_column(
        "payments",
        sa.Column("succeeded_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.execute(
        sa.text(
            "UPDATE payments AS payment "
            "SET succeeded_at = evidence.succeeded_at "
            "FROM ("
            "SELECT payment_id, MIN(stripe_created_at) AS succeeded_at "
            "FROM stripe_events "
            "WHERE payment_id IS NOT NULL "
            "AND processing_result = 'transitioned' "
            "AND event_type IN ("
            "'checkout.session.completed', "
            "'checkout.session.async_payment_succeeded'"
            ") GROUP BY payment_id"
            ") AS evidence "
            "WHERE payment.id = evidence.payment_id "
            "AND payment.status = 'succeeded'"
        )
    )
    missing_success_evidence = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT EXISTS ("
                "SELECT 1 FROM payments "
                "WHERE status = 'succeeded' AND succeeded_at IS NULL"
                ")"
            )
        )
        .scalar_one()
    )
    if missing_success_evidence:
        raise RuntimeError(
            "Cannot migrate succeeded payments without authoritative success evidence"
        )

    op.create_check_constraint(
        op.f("ck_payments_provider_allowed"),
        "payments",
        "provider IN ('stripe_test', 'demo')",
    )
    op.create_check_constraint(
        op.f("ck_payments_provider_idempotency_key_not_blank"),
        "payments",
        "provider_idempotency_key ~ '[^[:space:]]'",
    )
    op.create_check_constraint(
        op.f("ck_payments_checkout_session_fields_consistent"),
        "payments",
        "(provider_session_id IS NULL "
        "AND provider_checkout_url IS NULL "
        "AND provider_checkout_expires_at IS NULL) OR "
        "(provider_session_id IS NOT NULL "
        "AND provider_checkout_url IS NOT NULL "
        "AND provider_checkout_expires_at IS NOT NULL)",
    )
    op.create_check_constraint(
        op.f("ck_payments_succeeded_at_status_consistent"),
        "payments",
        "(status = 'succeeded' AND succeeded_at IS NOT NULL) OR "
        "(status IN ('pending', 'failed', 'expired') AND succeeded_at IS NULL)",
    )
    op.create_unique_constraint(
        op.f("uq_payments_provider_provider_idempotency_key"),
        "payments",
        ["provider", "provider_idempotency_key"],
    )
    op.create_unique_constraint(
        op.f("uq_payments_provider_provider_session_id"),
        "payments",
        ["provider", "provider_session_id"],
    )
    op.create_index(
        op.f("ix_payments_succeeded_at_id"),
        "payments",
        ["succeeded_at", "id"],
        unique=False,
        postgresql_where=sa.text("status = 'succeeded'"),
    )


def downgrade() -> None:
    """Restore the Stripe-only schema when every row is representable."""
    has_non_stripe_payment = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT EXISTS (SELECT 1 FROM payments WHERE provider != 'stripe_test')"
            )
        )
        .scalar_one()
    )
    if has_non_stripe_payment:
        raise RuntimeError(
            "Cannot downgrade while non-Stripe payment provider rows exist"
        )

    op.drop_index(op.f("ix_payments_succeeded_at_id"), table_name="payments")
    op.drop_constraint(
        op.f("ck_payments_succeeded_at_status_consistent"),
        "payments",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_payments_checkout_session_fields_consistent"),
        "payments",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_payments_provider_idempotency_key_not_blank"),
        "payments",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_payments_provider_allowed"),
        "payments",
        type_="check",
    )
    op.drop_constraint(
        op.f("uq_payments_provider_provider_session_id"),
        "payments",
        type_="unique",
    )
    op.drop_constraint(
        op.f("uq_payments_provider_provider_idempotency_key"),
        "payments",
        type_="unique",
    )
    op.alter_column(
        "payments",
        "provider_idempotency_key",
        new_column_name="stripe_idempotency_key",
        existing_type=sa.String(length=64),
        existing_nullable=False,
    )
    op.alter_column(
        "payments",
        "provider_session_id",
        new_column_name="stripe_checkout_session_id",
        existing_type=sa.String(length=255),
        existing_nullable=True,
    )
    op.alter_column(
        "payments",
        "provider_checkout_url",
        new_column_name="stripe_checkout_url",
        existing_type=sa.Text(),
        existing_nullable=True,
    )
    op.alter_column(
        "payments",
        "provider_checkout_expires_at",
        new_column_name="stripe_checkout_expires_at",
        existing_type=sa.DateTime(timezone=True),
        existing_nullable=True,
    )
    op.create_check_constraint(
        op.f("ck_payments_checkout_session_fields_consistent"),
        "payments",
        "(stripe_checkout_session_id IS NULL "
        "AND stripe_checkout_url IS NULL "
        "AND stripe_checkout_expires_at IS NULL) OR "
        "(stripe_checkout_session_id IS NOT NULL "
        "AND stripe_checkout_url IS NOT NULL "
        "AND stripe_checkout_expires_at IS NOT NULL)",
    )
    op.create_unique_constraint(
        op.f("uq_payments_stripe_idempotency_key"),
        "payments",
        ["stripe_idempotency_key"],
    )
    op.create_unique_constraint(
        op.f("uq_payments_stripe_checkout_session_id"),
        "payments",
        ["stripe_checkout_session_id"],
    )
    op.drop_column("payments", "succeeded_at")
    op.drop_column("payments", "provider")

    op.drop_constraint(
        op.f("ck_orders_data_origin_allowed"),
        "orders",
        type_="check",
    )
    op.drop_column("orders", "data_origin")

    # Keep VARCHAR(64): Alembic stamps the 51-character 0009 revision only after
    # this function returns, so shrinking here could fail before it writes 0008.
