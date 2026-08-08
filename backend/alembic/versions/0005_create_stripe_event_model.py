"""Create the durable Stripe event receipt model.

Revision ID: 0005_create_stripe_event_model
Revises: 0004_create_payment_model
Create Date: 2026-08-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0005_create_stripe_event_model"
down_revision: str | Sequence[str] | None = "0004_create_payment_model"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the approved durable Stripe event receipt schema."""
    op.create_table(
        "stripe_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("stripe_event_id", sa.String(length=255), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("livemode", sa.Boolean(), nullable=False),
        sa.Column(
            "stripe_created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "stripe_checkout_session_id",
            sa.String(length=255),
            nullable=False,
        ),
        sa.Column("payment_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("processing_result", sa.String(length=32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "char_length(btrim(stripe_checkout_session_id)) > 0",
            name=op.f("ck_stripe_events_checkout_session_id_not_blank"),
        ),
        sa.CheckConstraint(
            "event_type IN ("
            "'checkout.session.completed', "
            "'checkout.session.async_payment_succeeded', "
            "'checkout.session.async_payment_failed', "
            "'checkout.session.expired'"
            ")",
            name=op.f("ck_stripe_events_event_type_allowed"),
        ),
        sa.CheckConstraint(
            "processing_result IN ("
            "'transitioned', "
            "'awaiting_async_payment', "
            "'already_applied', "
            "'reconciliation_required'"
            ")",
            name=op.f("ck_stripe_events_processing_result_allowed"),
        ),
        sa.CheckConstraint(
            "char_length(btrim(stripe_event_id)) > 0",
            name=op.f("ck_stripe_events_stripe_event_id_not_blank"),
        ),
        sa.ForeignKeyConstraint(
            ["payment_id"],
            ["payments.id"],
            name="fk_stripe_events_payment_id_payments",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_stripe_events"),
        sa.UniqueConstraint(
            "stripe_event_id",
            name="uq_stripe_events_stripe_event_id",
        ),
    )
    op.create_index(
        "ix_stripe_events_payment_created_at_id",
        "stripe_events",
        ["payment_id", "stripe_created_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_stripe_events_session_created_at_id",
        "stripe_events",
        ["stripe_checkout_session_id", "stripe_created_at", "id"],
        unique=False,
    )


def downgrade() -> None:
    """Remove Stripe event receipts while retaining payment attempts."""
    op.drop_index(
        "ix_stripe_events_session_created_at_id",
        table_name="stripe_events",
    )
    op.drop_index(
        "ix_stripe_events_payment_created_at_id",
        table_name="stripe_events",
    )
    op.drop_table("stripe_events")
