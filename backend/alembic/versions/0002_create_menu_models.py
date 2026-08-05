"""Create category and menu item tables.

Revision ID: 0002_create_menu_models
Revises: 0001_database_baseline
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0002_create_menu_models"
down_revision: str | Sequence[str] | None = "0001_database_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the approved menu model schema."""
    op.create_table(
        "categories",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "display_order", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
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
            "display_order >= 0",
            name=op.f("ck_categories_display_order_nonnegative"),
        ),
        sa.CheckConstraint(
            "char_length(btrim(name)) > 0",
            name=op.f("ck_categories_name_not_blank"),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_categories"),
    )
    op.create_index(
        "ix_categories_name_normalized_unique",
        "categories",
        [sa.literal_column("lower(btrim(name))")],
        unique=True,
    )
    op.create_index(
        "ix_categories_active_display_order",
        "categories",
        ["display_order", "id"],
        unique=False,
        postgresql_where=sa.text("is_active IS TRUE"),
    )

    op.create_table(
        "menu_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("category_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("image_url", sa.String(length=2048), nullable=True),
        sa.Column("price_amount", sa.Integer(), nullable=False),
        sa.Column("cost_amount", sa.Integer(), nullable=True),
        sa.Column(
            "currency",
            sa.String(length=3),
            server_default=sa.text("'NOK'"),
            nullable=False,
        ),
        sa.Column(
            "allergens",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
        sa.Column(
            "display_order", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        sa.Column(
            "is_available", sa.Boolean(), server_default=sa.text("true"), nullable=False
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
            "cost_amount IS NULL OR cost_amount >= 0",
            name=op.f("ck_menu_items_cost_amount_nonnegative"),
        ),
        sa.CheckConstraint(
            "currency ~ '^[A-Z]{3}$'",
            name=op.f("ck_menu_items_currency_format"),
        ),
        sa.CheckConstraint(
            "display_order >= 0",
            name=op.f("ck_menu_items_display_order_nonnegative"),
        ),
        sa.CheckConstraint(
            "char_length(btrim(name)) > 0",
            name=op.f("ck_menu_items_name_not_blank"),
        ),
        sa.CheckConstraint(
            "price_amount > 0",
            name=op.f("ck_menu_items_price_amount_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name="fk_menu_items_category_id_categories",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_menu_items"),
    )
    op.create_index(
        "ix_menu_items_category_name_normalized_unique",
        "menu_items",
        ["category_id", sa.literal_column("lower(btrim(name))")],
        unique=True,
    )
    op.create_index(
        "ix_menu_items_active_category_display_order",
        "menu_items",
        ["category_id", "display_order", "id"],
        unique=False,
        postgresql_where=sa.text("is_active IS TRUE"),
    )


def downgrade() -> None:
    """Remove the menu model schema while retaining the baseline."""
    op.drop_index(
        "ix_menu_items_active_category_display_order", table_name="menu_items"
    )
    op.drop_index(
        "ix_menu_items_category_name_normalized_unique", table_name="menu_items"
    )
    op.drop_table("menu_items")
    op.drop_index("ix_categories_active_display_order", table_name="categories")
    op.drop_index("ix_categories_name_normalized_unique", table_name="categories")
    op.drop_table("categories")
