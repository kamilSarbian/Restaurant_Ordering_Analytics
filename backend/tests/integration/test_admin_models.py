"""Integration tests for the persisted administrator identity model."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import Boolean, DateTime, Enum, String, Text, inspect, select
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import models as auth_models
from app.auth.models import User
from app.auth.roles import UserRole

pytestmark = pytest.mark.integration

SYNTHETIC_PASSWORD_HASH = "synthetic-password-hash"
EXPECTED_COLUMNS = {
    "created_at",
    "email",
    "id",
    "is_active",
    "password_hash",
    "role",
    "updated_at",
}
EXPECTED_CHECKS = {
    "ck_users_email_normalized",
    "ck_users_email_not_blank",
    "ck_users_password_hash_not_blank",
    "ck_users_role_allowed",
}


def _admin(email: str = "admin@example.com", **values: object) -> User:
    defaults: dict[str, object] = {
        "email": email,
        "password_hash": SYNTHETIC_PASSWORD_HASH,
        "role": UserRole.SUPER_ADMIN,
    }
    defaults.update(values)
    return User(**defaults)


def _assert_integrity_error(session: Session, admin: User) -> None:
    session.add(admin)
    with pytest.raises(IntegrityError):
        session.flush()
    session.rollback()
    assert session.execute(select(1)).scalar_one() == 1


def test_admin_table_has_exact_columns_types_defaults_and_constraints(
    test_database_engine,
) -> None:
    """Inspect the exact PostgreSQL contract for administrator identities."""
    inspector = inspect(test_database_engine)
    assert "users" in inspector.get_table_names(schema="public")
    assert "admin_users" not in inspector.get_table_names(schema="public")
    columns = {column["name"]: column for column in inspector.get_columns("users")}
    assert set(columns) == EXPECTED_COLUMNS
    assert isinstance(columns["id"]["type"], PostgreSQLUUID)
    assert columns["id"]["default"] is None
    assert isinstance(columns["email"]["type"], String)
    assert columns["email"]["type"].length == 320
    assert isinstance(columns["password_hash"]["type"], Text)
    assert isinstance(columns["role"]["type"], String)
    assert columns["role"]["type"].length == 11
    assert columns["role"]["default"] is None
    assert isinstance(columns["is_active"]["type"], Boolean)
    for column_name in ("created_at", "updated_at"):
        assert isinstance(columns[column_name]["type"], DateTime)
        assert columns[column_name]["type"].timezone is True
        assert columns[column_name]["default"] is not None
    assert columns["is_active"]["default"] is not None
    assert all(column["nullable"] is False for column in columns.values())
    assert inspector.get_pk_constraint("users")["name"] == "pk_users"
    assert {
        constraint["name"] for constraint in inspector.get_unique_constraints("users")
    } == {"uq_users_email"}
    assert {
        constraint["name"] for constraint in inspector.get_check_constraints("users")
    } == EXPECTED_CHECKS


def test_runtime_exposes_only_the_canonical_user_model() -> None:
    """Keep one mapped User identity without a legacy runtime alias."""
    assert not hasattr(auth_models, "AdminUser")
    assert User.__name__ == "User"
    assert User.__tablename__ == "users"
    assert set(User.__table__.columns.keys()) == EXPECTED_COLUMNS
    assert {
        "password",
        "username",
        "last_login_at",
        "token_version",
        "deleted_at",
    }.isdisjoint(User.__table__.columns.keys())


def test_admin_defaults_uuid_activity_and_aware_timestamps(
    db_session: Session,
) -> None:
    """Generate UUID in Python and populate activity and timestamps on insert."""
    id_column = User.__table__.c.id
    assert id_column.default is not None
    assert id_column.default.is_callable
    assert id_column.server_default is None

    admin = _admin()
    db_session.add(admin)
    db_session.flush()
    assert isinstance(admin.id, uuid.UUID)
    assert admin.is_active is True
    assert admin.created_at.tzinfo is not None
    assert admin.updated_at.tzinfo is not None
    assert admin.role is UserRole.SUPER_ADMIN


def test_user_role_mapping_is_non_native_required_and_has_no_default() -> None:
    """Persist an explicit constrained role without a privileged default."""
    role_column = User.__table__.c.role
    assert isinstance(role_column.type, Enum)
    assert role_column.type.native_enum is False
    assert role_column.nullable is False
    assert role_column.default is None
    assert role_column.server_default is None


def test_admin_updated_at_uses_the_approved_orm_onupdate() -> None:
    """Apply the project func.now convention to administrator updates."""
    onupdate = User.__table__.c.updated_at.onupdate
    assert onupdate is not None
    assert str(onupdate.arg).lower() == "now()"


def test_normalized_email_and_two_distinct_identities_persist(
    db_session: Session,
) -> None:
    """Accept normalized lowercase identities while keeping them distinct."""
    first = _admin("first@example.com")
    second = _admin("second@example.com")
    db_session.add_all([first, second])
    db_session.flush()
    assert first.email == "first@example.com"
    assert second.email == "second@example.com"


def test_duplicate_normalized_email_is_rejected(db_session: Session) -> None:
    """Enforce normalized identity uniqueness through the named constraint."""
    db_session.add(_admin("admin@example.com"))
    db_session.commit()
    _assert_integrity_error(db_session, _admin("admin@example.com"))


@pytest.mark.parametrize(
    "email",
    ["Admin@example.com", " admin@example.com", "admin@example.com "],
)
def test_non_normalized_email_is_rejected(
    db_session: Session,
    email: str,
) -> None:
    """Reject case and outer whitespace that future application logic must remove."""
    _assert_integrity_error(db_session, _admin(email))


@pytest.mark.parametrize("email", ["", "   "])
def test_blank_email_is_rejected(db_session: Session, email: str) -> None:
    """Reject empty and whitespace-only administrator identities."""
    _assert_integrity_error(db_session, _admin(email))


@pytest.mark.parametrize("password_hash", ["", "   "])
def test_blank_password_hash_is_rejected(
    db_session: Session,
    password_hash: str,
) -> None:
    """Reject empty and whitespace-only persisted credential hashes."""
    _assert_integrity_error(db_session, _admin(password_hash=password_hash))


def test_admin_repr_and_str_do_not_expose_password_hash() -> None:
    """Keep the persisted credential hash out of ordinary object representations."""
    admin = _admin()
    assert SYNTHETIC_PASSWORD_HASH not in repr(admin)
    assert SYNTHETIC_PASSWORD_HASH not in str(admin)
