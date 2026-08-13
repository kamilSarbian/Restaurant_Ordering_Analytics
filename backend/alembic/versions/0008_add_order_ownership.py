"""Add nullable customer ownership to orders.

Revision ID: 0008_add_order_ownership
Revises: 0007_unify_user_auth_roles
Create Date: 2026-08-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0008_add_order_ownership"
down_revision: str | Sequence[str] | None = "0007_unify_user_auth_roles"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add optional registered-user ownership to durable orders."""
    op.add_column(
        "orders",
        sa.Column(
            "customer_user_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "fk_orders_customer_user_id_users",
        "orders",
        "users",
        ["customer_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_orders_customer_user_created_at_id",
        "orders",
        ["customer_user_id", "created_at", "id"],
        unique=False,
    )


def downgrade() -> None:
    """Remove registered-user ownership without deleting orders."""
    op.drop_index(
        "ix_orders_customer_user_created_at_id",
        table_name="orders",
    )
    op.drop_constraint(
        "fk_orders_customer_user_id_users",
        "orders",
        type_="foreignkey",
    )
    op.drop_column("orders", "customer_user_id")
