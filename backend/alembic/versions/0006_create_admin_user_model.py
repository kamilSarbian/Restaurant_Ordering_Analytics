"""Create the persisted administrator identity model.

Revision ID: 0006_create_admin_user_model
Revises: 0005_create_stripe_event_model
Create Date: 2026-08-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0006_create_admin_user_model"
down_revision: str | Sequence[str] | None = "0005_create_stripe_event_model"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the schema-only administrator identity table."""
    op.create_table(
        "admin_users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column(
            "is_active",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
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
            "btrim(email) <> ''",
            name=op.f("ck_admin_users_email_not_blank"),
        ),
        sa.CheckConstraint(
            "email = lower(btrim(email))",
            name=op.f("ck_admin_users_email_normalized"),
        ),
        sa.CheckConstraint(
            "btrim(password_hash) <> ''",
            name=op.f("ck_admin_users_password_hash_not_blank"),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_admin_users"),
        sa.UniqueConstraint("email", name="uq_admin_users_email"),
    )


def downgrade() -> None:
    """Remove only the administrator identity table."""
    op.drop_table("admin_users")
