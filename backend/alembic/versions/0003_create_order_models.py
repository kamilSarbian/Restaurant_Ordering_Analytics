"""Create persistent order aggregate tables.

Revision ID: 0003_create_order_models
Revises: 0002_create_menu_models
Create Date: 2026-08-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0003_create_order_models"
down_revision: str | Sequence[str] | None = "0002_create_menu_models"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the approved persistent order model schema."""
    op.create_table(
        "restaurant_tables",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column(
            "is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False
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
            "number > 0",
            name=op.f("ck_restaurant_tables_number_positive"),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_restaurant_tables"),
        sa.UniqueConstraint("number", name="uq_restaurant_tables_number"),
    )

    op.create_table(
        "orders",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("public_order_number", sa.String(length=16), nullable=False),
        sa.Column("order_access_token_hash", sa.String(length=64), nullable=False),
        sa.Column("order_type", sa.String(length=16), nullable=False),
        sa.Column("table_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("table_number_snapshot", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("subtotal_amount", sa.BigInteger(), nullable=False),
        sa.Column("total_amount", sa.BigInteger(), nullable=False),
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
            "order_access_token_hash ~ '^[0-9a-f]{64}$'",
            name=op.f("ck_orders_access_token_hash_format"),
        ),
        sa.CheckConstraint(
            "currency ~ '^[A-Z]{3}$'",
            name=op.f("ck_orders_currency_format"),
        ),
        sa.CheckConstraint(
            "order_type IN ('dine_in', 'takeaway')",
            name=op.f("ck_orders_order_type_allowed"),
        ),
        sa.CheckConstraint(
            "(order_type = 'takeaway' AND table_id IS NULL "
            "AND table_number_snapshot IS NULL) OR "
            "(order_type = 'dine_in' AND table_id IS NOT NULL "
            "AND table_number_snapshot IS NOT NULL "
            "AND table_number_snapshot > 0)",
            name=op.f("ck_orders_order_type_table_consistency"),
        ),
        sa.CheckConstraint(
            "public_order_number ~ " "'^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$'",
            name=op.f("ck_orders_public_order_number_format"),
        ),
        sa.CheckConstraint(
            "status IN ('created', 'accepted', 'preparing', 'ready', "
            "'completed', 'cancelled')",
            name=op.f("ck_orders_status_allowed"),
        ),
        sa.CheckConstraint(
            "subtotal_amount > 0",
            name=op.f("ck_orders_subtotal_amount_positive"),
        ),
        sa.CheckConstraint(
            "table_number_snapshot IS NULL OR table_number_snapshot > 0",
            name=op.f("ck_orders_table_number_snapshot_positive"),
        ),
        sa.CheckConstraint(
            "total_amount > 0",
            name=op.f("ck_orders_total_amount_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["table_id"],
            ["restaurant_tables.id"],
            name="fk_orders_table_id_restaurant_tables",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_orders"),
        sa.UniqueConstraint(
            "order_access_token_hash",
            name="uq_orders_order_access_token_hash",
        ),
        sa.UniqueConstraint(
            "public_order_number",
            name="uq_orders_public_order_number",
        ),
    )

    op.create_table(
        "order_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("menu_item_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("category_name_snapshot", sa.String(length=120), nullable=False),
        sa.Column("name_snapshot", sa.String(length=120), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("unit_price_amount", sa.Integer(), nullable=False),
        sa.Column("unit_cost_amount", sa.Integer(), nullable=True),
        sa.Column("tax_rate_bps_snapshot", sa.Integer(), nullable=True),
        sa.Column(
            "discount_amount_snapshot",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("line_total_amount", sa.BigInteger(), nullable=False),
        sa.CheckConstraint(
            "char_length(btrim(category_name_snapshot)) > 0",
            name=op.f("ck_order_items_category_name_snapshot_not_blank"),
        ),
        sa.CheckConstraint(
            "discount_amount_snapshot >= 0",
            name=op.f("ck_order_items_discount_amount_snapshot_nonnegative"),
        ),
        sa.CheckConstraint(
            "line_total_amount = CAST(unit_price_amount AS BIGINT) "
            "* CAST(quantity AS BIGINT)",
            name=op.f("ck_order_items_line_total_matches_quantity"),
        ),
        sa.CheckConstraint(
            "line_total_amount > 0",
            name=op.f("ck_order_items_line_total_amount_positive"),
        ),
        sa.CheckConstraint(
            "char_length(btrim(name_snapshot)) > 0",
            name=op.f("ck_order_items_name_snapshot_not_blank"),
        ),
        sa.CheckConstraint(
            "position >= 0",
            name=op.f("ck_order_items_position_nonnegative"),
        ),
        sa.CheckConstraint(
            "quantity BETWEEN 1 AND 99",
            name=op.f("ck_order_items_quantity_range"),
        ),
        sa.CheckConstraint(
            "tax_rate_bps_snapshot IS NULL OR "
            "tax_rate_bps_snapshot BETWEEN 0 AND 10000",
            name=op.f("ck_order_items_tax_rate_bps_snapshot_range"),
        ),
        sa.CheckConstraint(
            "unit_cost_amount IS NULL OR unit_cost_amount >= 0",
            name=op.f("ck_order_items_unit_cost_amount_nonnegative"),
        ),
        sa.CheckConstraint(
            "unit_price_amount > 0",
            name=op.f("ck_order_items_unit_price_amount_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["menu_item_id"],
            ["menu_items.id"],
            name="fk_order_items_menu_item_id_menu_items",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name="fk_order_items_order_id_orders",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_order_items"),
        sa.UniqueConstraint(
            "order_id",
            "menu_item_id",
            name="uq_order_items_order_id_menu_item_id",
        ),
        sa.UniqueConstraint(
            "order_id",
            "position",
            name="uq_order_items_order_id_position",
        ),
    )

    op.create_table(
        "order_status_history",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("previous_status", sa.String(length=16), nullable=True),
        sa.Column("new_status", sa.String(length=16), nullable=False),
        sa.Column(
            "changed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(sequence = 0 AND previous_status IS NULL "
            "AND new_status = 'created') OR "
            "(sequence > 0 AND previous_status IS NOT NULL)",
            name=op.f("ck_order_status_history_initial_entry"),
        ),
        sa.CheckConstraint(
            "new_status IN ('created', 'accepted', 'preparing', 'ready', "
            "'completed', 'cancelled')",
            name=op.f("ck_order_status_history_new_status_allowed"),
        ),
        sa.CheckConstraint(
            "previous_status IS NULL OR previous_status IN "
            "('created', 'accepted', 'preparing', 'ready', 'completed', "
            "'cancelled')",
            name=op.f("ck_order_status_history_previous_status_allowed"),
        ),
        sa.CheckConstraint(
            "sequence >= 0",
            name=op.f("ck_order_status_history_sequence_nonnegative"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name="fk_order_status_history_order_id_orders",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_order_status_history"),
        sa.UniqueConstraint(
            "order_id",
            "sequence",
            name="uq_order_status_history_order_id_sequence",
        ),
    )


def downgrade() -> None:
    """Remove the persistent order model schema while retaining menu tables."""
    op.drop_table("order_status_history")
    op.drop_table("order_items")
    op.drop_table("orders")
    op.drop_table("restaurant_tables")
