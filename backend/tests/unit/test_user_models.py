"""Unit tests for unified User metadata and role definitions."""

from sqlalchemy import CheckConstraint, Enum

from app.auth.models import AdminUser, User
from app.auth.roles import UserRole
from app.database.model_registry import metadata


def test_user_role_has_exact_registered_values_without_guest() -> None:
    """Keep the role vocabulary minimal and exclude anonymous guests."""
    assert [role.value for role in UserRole] == [
        "customer",
        "admin",
        "super_admin",
    ]
    assert "guest" not in UserRole._value2member_map_


def test_user_model_has_exact_table_columns_and_role_storage() -> None:
    """Describe one non-native string role without a privileged default."""
    assert User.__tablename__ == "users"
    assert set(User.__table__.columns.keys()) == {
        "id",
        "email",
        "password_hash",
        "role",
        "is_active",
        "created_at",
        "updated_at",
    }
    role_column = User.__table__.c.role
    assert isinstance(role_column.type, Enum)
    assert role_column.type.native_enum is False
    assert role_column.type.length == 11
    assert role_column.nullable is False
    assert role_column.default is None
    assert role_column.server_default is None
    assert role_column.type.enums == ["customer", "admin", "super_admin"]


def test_user_metadata_has_canonical_constraints_and_one_mapping() -> None:
    """Keep canonical constraint names and one mapped identity table."""
    check_names = {
        constraint.name
        for constraint in User.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }
    assert check_names == {
        "ck_users_email_normalized",
        "ck_users_email_not_blank",
        "ck_users_password_hash_not_blank",
        "ck_users_role_allowed",
    }
    assert User.__table__.primary_key.name == "pk_users"
    assert {constraint.name for constraint in User.__table__.constraints} >= {
        "uq_users_email"
    }
    assert AdminUser is User
    assert "users" in metadata.tables
    assert "admin_users" not in metadata.tables
