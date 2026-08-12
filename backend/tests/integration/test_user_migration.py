"""Integration tests for the unified User migration lifecycle."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.engine import URL, Engine
from sqlalchemy.exc import IntegrityError

from alembic import command
from tests.integration.conftest import (
    HEAD_REVISION,
    _alembic_config,
    _current_revision,
    _public_tables,
    _temporary_database_url,
)

pytestmark = pytest.mark.integration

REVISION_0006 = "0006_create_admin_user_model"
REVISION_0007 = "0007_unify_user_auth_roles"
SYNTHETIC_HASH = "synthetic-user-migration-hash"
EXPECTED_USER_CHECKS = {
    "ck_users_email_normalized",
    "ck_users_email_not_blank",
    "ck_users_password_hash_not_blank",
    "ck_users_role_allowed",
}


def _upgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.upgrade(config, revision)


def _downgrade(database_url: URL, revision: str) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.downgrade(config, revision)


def _empty_head(database_url: URL, engine: Engine) -> None:
    _upgrade(database_url, "head")
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM users"))


def _insert_admin_user(
    engine: Engine,
    *,
    user_id: uuid.UUID,
    email: str,
    is_active: bool,
    created_at: datetime,
    updated_at: datetime,
) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO admin_users "
                "(id, email, password_hash, is_active, created_at, updated_at) "
                "VALUES (:id, :email, :password_hash, :is_active, "
                ":created_at, :updated_at)"
            ),
            {
                "id": user_id,
                "email": email,
                "password_hash": SYNTHETIC_HASH,
                "is_active": is_active,
                "created_at": created_at,
                "updated_at": updated_at,
            },
        )


def _insert_user(engine: Engine, *, role: str, email: str) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users (id, email, password_hash, role, is_active) "
                "VALUES (:id, :email, :password_hash, :role, true)"
            ),
            {
                "id": uuid.uuid4(),
                "email": email,
                "password_hash": SYNTHETIC_HASH,
                "role": role,
            },
        )


def test_revision_is_the_single_child_of_admin_user_migration() -> None:
    """Keep the unified migration on one linear Alembic branch."""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(_alembic_config())
    revision = script.get_revision(REVISION_0007)
    assert revision is not None
    assert revision.revision == REVISION_0007
    assert revision.down_revision == REVISION_0006
    assert script.get_current_head() == REVISION_0007 == HEAD_REVISION


def test_zero_row_upgrade_creates_empty_constrained_users_table(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Upgrade an empty administrator table without inventing an identity."""
    _empty_head(test_database_url, test_database_engine)
    try:
        _downgrade(test_database_url, REVISION_0006)
        _upgrade(test_database_url, REVISION_0007)
        inspector = inspect(test_database_engine)
        tables = set(inspector.get_table_names(schema="public"))
        columns = {column["name"]: column for column in inspector.get_columns("users")}
        assert "users" in tables
        assert "admin_users" not in tables
        assert columns["role"]["nullable"] is False
        assert columns["role"]["default"] is None
        assert columns["role"]["type"].length == 11
        assert {
            constraint["name"]
            for constraint in inspector.get_check_constraints("users")
        } == EXPECTED_USER_CHECKS
        with test_database_engine.connect() as connection:
            assert (
                connection.execute(text("SELECT count(*) FROM users")).scalar_one() == 0
            )
    finally:
        _empty_head(test_database_url, test_database_engine)


def test_one_row_upgrade_preserves_identity_and_backfills_super_admin(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Preserve every administrator value and add only the approved role."""
    user_id = uuid.uuid4()
    created_at = datetime(2026, 8, 1, 9, 30, 15, 123456, tzinfo=UTC)
    updated_at = datetime(2026, 8, 2, 10, 45, 20, 654321, tzinfo=UTC)
    _empty_head(test_database_url, test_database_engine)
    try:
        _downgrade(test_database_url, REVISION_0006)
        _insert_admin_user(
            test_database_engine,
            user_id=user_id,
            email="migration-admin@example.com",
            is_active=False,
            created_at=created_at,
            updated_at=updated_at,
        )
        _upgrade(test_database_url, REVISION_0007)
        with test_database_engine.connect() as connection:
            row = (
                connection.execute(
                    text(
                        "SELECT id, email, password_hash, role, is_active, "
                        "created_at, updated_at FROM users"
                    )
                )
                .mappings()
                .one()
            )
        assert dict(row) == {
            "id": user_id,
            "email": "migration-admin@example.com",
            "password_hash": SYNTHETIC_HASH,
            "role": "super_admin",
            "is_active": False,
            "created_at": created_at,
            "updated_at": updated_at,
        }
    finally:
        _empty_head(test_database_url, test_database_engine)


def test_multiple_admin_upgrade_fails_and_rolls_back_complete_revision(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Reject ambiguous highest-trust assignment without partial DDL or data loss."""
    _empty_head(test_database_url, test_database_engine)
    try:
        _downgrade(test_database_url, REVISION_0006)
        for position in range(2):
            _insert_admin_user(
                test_database_engine,
                user_id=uuid.uuid4(),
                email=f"migration-admin-{position}@example.com",
                is_active=True,
                created_at=datetime(2026, 8, position + 1, tzinfo=UTC),
                updated_at=datetime(2026, 8, position + 1, tzinfo=UTC),
            )
        with pytest.raises(RuntimeError, match="at most one existing administrator"):
            _upgrade(test_database_url, REVISION_0007)

        inspector = inspect(test_database_engine)
        assert _current_revision(test_database_url) == REVISION_0006
        assert "admin_users" in inspector.get_table_names(schema="public")
        assert "users" not in inspector.get_table_names(schema="public")
        assert "role" not in {
            column["name"] for column in inspector.get_columns("admin_users")
        }
        with test_database_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT count(*) FROM admin_users")
                ).scalar_one()
                == 2
            )
        with test_database_engine.begin() as connection:
            connection.execute(text("DELETE FROM admin_users"))
    finally:
        if _current_revision(test_database_url) == REVISION_0006:
            with test_database_engine.begin() as connection:
                connection.execute(text("DELETE FROM admin_users"))
        _upgrade(test_database_url, "head")


def test_constraints_and_unique_email_survive_upgrade(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Retain identity invariants and reject roles outside the exact vocabulary."""
    _empty_head(test_database_url, test_database_engine)
    try:
        inspector = inspect(test_database_engine)
        assert inspector.get_pk_constraint("users")["name"] == "pk_users"
        assert {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("users")
        } == {"uq_users_email"}

        _insert_user(
            test_database_engine,
            role="customer",
            email="constraint-user@example.com",
        )
        invalid_rows = (
            ("constraint-user@example.com", "admin", SYNTHETIC_HASH),
            ("Not-Normalized@example.com", "admin", SYNTHETIC_HASH),
            ("blank-hash@example.com", "admin", " "),
            ("invalid-role@example.com", "guest", SYNTHETIC_HASH),
        )
        for email, role, password_hash in invalid_rows:
            with pytest.raises(IntegrityError):
                with test_database_engine.begin() as connection:
                    connection.execute(
                        text(
                            "INSERT INTO users "
                            "(id, email, password_hash, role, is_active) "
                            "VALUES (:id, :email, :password_hash, :role, true)"
                        ),
                        {
                            "id": uuid.uuid4(),
                            "email": email,
                            "password_hash": password_hash,
                            "role": role,
                        },
                    )
    finally:
        _empty_head(test_database_url, test_database_engine)


@pytest.mark.parametrize("row_count", [0, 1])
def test_representable_downgrade_and_second_upgrade_succeed(
    test_database_url: URL,
    test_database_engine: Engine,
    row_count: int,
) -> None:
    """Cycle representable empty and one-super-admin states without data loss."""
    _empty_head(test_database_url, test_database_engine)
    try:
        if row_count == 1:
            _insert_user(
                test_database_engine,
                role="super_admin",
                email="representable-super-admin@example.com",
            )
        _downgrade(test_database_url, REVISION_0006)
        assert _current_revision(test_database_url) == REVISION_0006
        assert "admin_users" in _public_tables(test_database_url)
        with test_database_engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT count(*) FROM admin_users")
                ).scalar_one()
                == row_count
            )
        _upgrade(test_database_url, "head")
        assert _current_revision(test_database_url) == HEAD_REVISION
        with test_database_engine.connect() as connection:
            rows = connection.execute(text("SELECT role FROM users")).scalars().all()
        assert rows == (["super_admin"] if row_count else [])
    finally:
        _empty_head(test_database_url, test_database_engine)


@pytest.mark.parametrize("role", ["customer", "admin"])
def test_downgrade_rejects_non_super_admin_role(
    test_database_url: URL,
    test_database_engine: Engine,
    role: str,
) -> None:
    """Refuse to squeeze a customer or administrator into the old schema."""
    _empty_head(test_database_url, test_database_engine)
    try:
        _insert_user(
            test_database_engine,
            role=role,
            email=f"blocked-{role}@example.com",
        )
        with pytest.raises(RuntimeError, match="cannot be represented"):
            _downgrade(test_database_url, REVISION_0006)
        assert _current_revision(test_database_url) == HEAD_REVISION
        assert "users" in _public_tables(test_database_url)
    finally:
        _empty_head(test_database_url, test_database_engine)


def test_downgrade_rejects_multiple_users(
    test_database_url: URL,
    test_database_engine: Engine,
) -> None:
    """Refuse downgrade when multiple unified identities would be ambiguous."""
    _empty_head(test_database_url, test_database_engine)
    try:
        for position in range(2):
            _insert_user(
                test_database_engine,
                role="super_admin",
                email=f"blocked-super-admin-{position}@example.com",
            )
        with pytest.raises(RuntimeError, match="cannot be represented"):
            _downgrade(test_database_url, REVISION_0006)
        assert _current_revision(test_database_url) == HEAD_REVISION
        with test_database_engine.connect() as connection:
            assert (
                connection.execute(text("SELECT count(*) FROM users")).scalar_one() == 2
            )
    finally:
        _empty_head(test_database_url, test_database_engine)
