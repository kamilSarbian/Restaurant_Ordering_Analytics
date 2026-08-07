"""Create the payment-attempt persistence model.

Revision ID: 0004_create_payment_model
Revises: 0003_create_order_models
Create Date: 2026-08-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0004_create_payment_model"
down_revision: str | Sequence[str] | None = "0003_create_order_models"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the approved payment-attempt schema."""
    op.create_table(
        "payments",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "status",
            sa.String(length=16),
            server_default=sa.text("'pending'"),
            nullable=False,
        ),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column(
            "request_idempotency_key",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("stripe_idempotency_key", sa.String(length=64), nullable=False),
        sa.Column("stripe_checkout_session_id", sa.String(length=255), nullable=True),
        sa.Column("stripe_checkout_url", sa.Text(), nullable=True),
        sa.Column(
            "stripe_checkout_expires_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "amount > 0",
            name=op.f("ck_payments_amount_positive"),
        ),
        sa.CheckConstraint(
            "(stripe_checkout_session_id IS NULL "
            "AND stripe_checkout_url IS NULL "
            "AND stripe_checkout_expires_at IS NULL) OR "
            "(stripe_checkout_session_id IS NOT NULL "
            "AND stripe_checkout_url IS NOT NULL "
            "AND stripe_checkout_expires_at IS NOT NULL)",
            name=op.f("ck_payments_checkout_session_fields_consistent"),
        ),
        sa.CheckConstraint(
            "currency ~ '^[A-Z]{3}$'",
            name=op.f("ck_payments_currency_format"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'succeeded', 'failed', 'expired')",
            name=op.f("ck_payments_status_allowed"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name="fk_payments_order_id_orders",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_payments"),
        sa.UniqueConstraint(
            "order_id",
            "request_idempotency_key",
            name="uq_payments_order_id_request_idempotency_key",
        ),
        sa.UniqueConstraint(
            "stripe_checkout_session_id",
            name="uq_payments_stripe_checkout_session_id",
        ),
        sa.UniqueConstraint(
            "stripe_idempotency_key",
            name="uq_payments_stripe_idempotency_key",
        ),
    )
    op.create_index(
        "ix_payments_order_pending_unique",
        "payments",
        ["order_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_index(
        "ix_payments_order_succeeded_unique",
        "payments",
        ["order_id"],
        unique=True,
        postgresql_where=sa.text("status = 'succeeded'"),
    )
    op.create_index(
        "ix_payments_order_created_at_id",
        "payments",
        ["order_id", "created_at", "id"],
        unique=False,
    )


def downgrade() -> None:
    """Remove payment attempts while retaining the Stage 8 schema."""
    op.drop_index("ix_payments_order_created_at_id", table_name="payments")
    op.drop_index("ix_payments_order_succeeded_unique", table_name="payments")
    op.drop_index("ix_payments_order_pending_unique", table_name="payments")
    op.drop_table("payments")
