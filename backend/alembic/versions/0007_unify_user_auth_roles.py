"""Unify registered identity persistence and add constrained user roles.

Revision ID: 0007_unify_user_auth_roles
Revises: 0006_create_admin_user_model
Create Date: 2026-08-12
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0007_unify_user_auth_roles"
down_revision: str | Sequence[str] | None = "0006_create_admin_user_model"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_UPGRADE_CONSTRAINT_RENAMES = (
    ("pk_admin_users", "pk_users"),
    ("uq_admin_users_email", "uq_users_email"),
    ("ck_admin_users_email_not_blank", "ck_users_email_not_blank"),
    ("ck_admin_users_email_normalized", "ck_users_email_normalized"),
    (
        "ck_admin_users_password_hash_not_blank",
        "ck_users_password_hash_not_blank",
    ),
)


def _rename_constraint(table_name: str, old_name: str, new_name: str) -> None:
    op.execute(
        sa.text(
            f'ALTER TABLE "{table_name}" RENAME CONSTRAINT '
            f'"{old_name}" TO "{new_name}"'
        )
    )


def upgrade() -> None:
    """Evolve the administrator table into one safely constrained user table."""
    op.rename_table("admin_users", "users")
    for old_name, new_name in _UPGRADE_CONSTRAINT_RENAMES:
        _rename_constraint("users", old_name, new_name)

    op.add_column("users", sa.Column("role", sa.String(length=11), nullable=True))
    connection = op.get_bind()
    user_count = connection.execute(sa.text("SELECT count(*) FROM users")).scalar_one()
    if user_count > 1:
        raise RuntimeError(
            "Unified user migration requires at most one existing administrator"
        )
    if user_count == 1:
        connection.execute(sa.text("UPDATE users SET role = 'super_admin'"))

    op.alter_column(
        "users",
        "role",
        existing_type=sa.String(length=11),
        nullable=False,
    )
    op.create_check_constraint(
        "role_allowed",
        "users",
        "role IN ('customer', 'admin', 'super_admin')",
    )


def downgrade() -> None:
    """Restore AdminUser storage only when all data remains representable."""
    connection = op.get_bind()
    roles = (
        connection.execute(sa.text("SELECT role FROM users ORDER BY id"))
        .scalars()
        .all()
    )
    if len(roles) > 1 or (roles and roles[0] != "super_admin"):
        raise RuntimeError(
            "Unified user data cannot be represented by the administrator schema"
        )

    op.drop_constraint(op.f("ck_users_role_allowed"), "users", type_="check")
    op.drop_column("users", "role")
    for old_name, new_name in reversed(_UPGRADE_CONSTRAINT_RENAMES):
        _rename_constraint("users", new_name, old_name)
    op.rename_table("users", "admin_users")
