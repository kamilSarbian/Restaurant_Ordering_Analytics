"""Explicit local provisioning for the non-password portfolio demo admin."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from pydantic import PostgresDsn, ValidationError
from sqlalchemy import create_engine, or_, select, text
from sqlalchemy.engine import URL, Engine
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.roles import UserRole
from app.core.config import Settings
from app.database.session import create_session_factory
from app.seed.safety import (
    DEVELOPMENT_DATABASE_NAME,
    PINNED_HOST,
    REQUIRED_PORT,
    SeedSafetyError,
    validate_local_seed_database_url,
)

DEMO_ADMIN_ID = UUID("7f0c8d3f-4f58-4b2e-8d4a-2a5df7b40001")
DEMO_ADMIN_EMAIL = "demo-admin@example.com"
DEMO_ADMIN_DISABLED_PASSWORD_HASH = "!portfolio-demo-admin-login-disabled-v1"
DEMO_ADMIN_PROVISION_LOCK_KEY = 593_216_404_004

DemoAdminStatus = Literal["provisioned", "already_exact", "verified"]


class DemoAdminError(Exception):
    """Base class for sanitized demo-administrator command failures."""


class DemoAdminConflictError(DemoAdminError):
    """Report missing, conflicting, or drifted demo-administrator state."""


class DemoAdminDatabaseError(DemoAdminError):
    """Report a sanitized demo-administrator database failure."""


class DemoAdminSafetyError(DemoAdminError):
    """Report an unsafe local database target without connection details."""


@dataclass(frozen=True, slots=True)
class DemoAdminResult:
    """Describe a provision or verification result without credential data."""

    id: UUID
    email: str
    status: DemoAdminStatus


def is_demo_admin_identity(user: User) -> bool:
    """Return whether a user exactly matches the reserved demo identity."""
    return (
        user.id == DEMO_ADMIN_ID
        and user.email == DEMO_ADMIN_EMAIL
        and user.password_hash == DEMO_ADMIN_DISABLED_PASSWORD_HASH
        and user.role == UserRole.ADMIN
        and user.is_active is True
    )


def provision_demo_admin(
    session_factory: sessionmaker[Session],
) -> DemoAdminResult:
    """Create the exact demo administrator or verify an exact prior provision.

    Args:
        session_factory: Factory bound to the explicitly approved local database.

    Returns:
        The reserved identity and whether it was inserted or already exact.

    Raises:
        DemoAdminConflictError: If a reserved identifier collides or state drifted.
        DemoAdminDatabaseError: If the database operation does not complete.
    """
    result: DemoAdminResult | None = None
    sanitized_error: DemoAdminError | None = None

    try:
        with session_factory.begin() as session:
            session.execute(
                text("SELECT pg_advisory_xact_lock(:lock_key)"),
                {"lock_key": DEMO_ADMIN_PROVISION_LOCK_KEY},
            )
            candidates = _load_candidates(session, lock_rows=True)
            if not candidates:
                user = User(
                    id=DEMO_ADMIN_ID,
                    email=DEMO_ADMIN_EMAIL,
                    password_hash=DEMO_ADMIN_DISABLED_PASSWORD_HASH,
                    role=UserRole.ADMIN,
                    is_active=True,
                )
                session.add(user)
                session.flush()
                result = _result("provisioned")
            elif len(candidates) == 1 and is_demo_admin_identity(candidates[0]):
                result = _result("already_exact")
            else:
                raise DemoAdminConflictError(
                    "Demo administrator identity conflicts with existing data."
                )
    except DemoAdminError:
        raise
    except IntegrityError:
        sanitized_error = DemoAdminConflictError(
            "Demo administrator identity conflicts with existing data."
        )
    except SQLAlchemyError:
        sanitized_error = DemoAdminDatabaseError(
            "The demo administrator database operation did not complete."
        )

    # Raise outside the raw exception handler so private driver context cannot
    # remain reachable from the public domain exception.
    if sanitized_error is not None:
        raise sanitized_error
    if result is None:  # pragma: no cover - defensive invariant
        raise DemoAdminDatabaseError(
            "The demo administrator database operation did not complete."
        )
    return result


def verify_demo_admin(
    session_factory: sessionmaker[Session],
) -> DemoAdminResult:
    """Verify the exact reserved demo identity without performing any DML.

    Args:
        session_factory: Factory bound to the explicitly approved local database.

    Returns:
        The verified reserved demo identity.

    Raises:
        DemoAdminConflictError: If the identity is missing, conflicting, or drifted.
        DemoAdminDatabaseError: If the read-only database operation fails.
    """
    result: DemoAdminResult | None = None
    sanitized_error: DemoAdminError | None = None

    try:
        with session_factory() as session:
            candidates = _load_candidates(session, lock_rows=False)
            if len(candidates) != 1 or not is_demo_admin_identity(candidates[0]):
                raise DemoAdminConflictError(
                    "Demo administrator identity is missing or conflicts with existing data."
                )
            result = _result("verified")
    except DemoAdminError:
        raise
    except SQLAlchemyError:
        sanitized_error = DemoAdminDatabaseError(
            "The demo administrator database operation did not complete."
        )

    if sanitized_error is not None:
        raise sanitized_error
    if result is None:  # pragma: no cover - defensive invariant
        raise DemoAdminDatabaseError(
            "The demo administrator database operation did not complete."
        )
    return result


def validate_local_demo_admin_database_url(
    database_url: str | PostgresDsn,
) -> URL:
    """Validate the exact local development target before engine creation."""
    try:
        return validate_local_seed_database_url(database_url)
    except SeedSafetyError:
        raise DemoAdminSafetyError(
            "The demo administrator command requires the approved local development database."
        ) from None


def main(argv: Sequence[str] | None = None) -> int:
    """Run the explicit local demo-administrator command and return its exit code."""
    raw_arguments = tuple(sys.argv[1:] if argv is None else argv)
    if raw_arguments in (("-h",), ("--help",)):
        _build_parser().print_help()
        return 0
    if len(raw_arguments) != 1 or raw_arguments[0] not in ("provision", "verify"):
        print(
            "Demo administrator command failed: invalid command arguments.",
            file=sys.stderr,
        )
        return 2

    arguments = argparse.Namespace(action=raw_arguments[0])
    engine: Engine | None = None
    exit_code = 1

    try:
        settings = Settings()
        if settings.database_url is None:
            raise DemoAdminSafetyError(
                "The demo administrator command requires database configuration."
            )
        database_url = validate_local_demo_admin_database_url(settings.database_url)
        engine = create_engine(
            database_url,
            pool_pre_ping=True,
            hide_parameters=True,
            connect_args={
                "host": PINNED_HOST,
                "hostaddr": PINNED_HOST,
                "port": REQUIRED_PORT,
                "dbname": DEVELOPMENT_DATABASE_NAME,
            },
        )
        session_factory = create_session_factory(engine)
        if arguments.action == "provision":
            result = provision_demo_admin(session_factory)
            message = (
                "Demo administrator provisioned."
                if result.status == "provisioned"
                else "Demo administrator is already exact."
            )
        else:
            verify_demo_admin(session_factory)
            message = "Demo administrator verified."
        print(message)
        exit_code = 0
    except DemoAdminSafetyError:
        print(
            "Demo administrator command failed: local database target is not approved.",
            file=sys.stderr,
        )
    except DemoAdminConflictError:
        print(
            "Demo administrator command failed: identity is missing, conflicting, or drifted.",
            file=sys.stderr,
        )
    except DemoAdminDatabaseError:
        print(
            "Demo administrator command failed: database operation did not complete.",
            file=sys.stderr,
        )
    except ValidationError:
        print(
            "Demo administrator command failed: application configuration is invalid.",
            file=sys.stderr,
        )
    except SQLAlchemyError:
        print(
            "Demo administrator command failed: database operation did not complete.",
            file=sys.stderr,
        )
    finally:
        if engine is not None:
            try:
                engine.dispose()
            except SQLAlchemyError:
                print(
                    "Demo administrator command failed: database cleanup did not complete.",
                    file=sys.stderr,
                )
                exit_code = 1
    return exit_code


def _load_candidates(session: Session, *, lock_rows: bool) -> tuple[User, ...]:
    statement = select(User).where(
        or_(User.id == DEMO_ADMIN_ID, User.email == DEMO_ADMIN_EMAIL)
    )
    if lock_rows:
        statement = statement.with_for_update()
    return tuple(session.scalars(statement).all())


def _result(status: DemoAdminStatus) -> DemoAdminResult:
    return DemoAdminResult(id=DEMO_ADMIN_ID, email=DEMO_ADMIN_EMAIL, status=status)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.auth.demo_admin",
        description="Provision or verify the local portfolio demo administrator.",
        allow_abbrev=False,
    )
    parser.add_argument("action", choices=("provision", "verify"))
    return parser


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "DEMO_ADMIN_DISABLED_PASSWORD_HASH",
    "DEMO_ADMIN_EMAIL",
    "DEMO_ADMIN_ID",
    "DemoAdminConflictError",
    "DemoAdminDatabaseError",
    "DemoAdminResult",
    "DemoAdminSafetyError",
    "is_demo_admin_identity",
    "main",
    "provision_demo_admin",
    "validate_local_demo_admin_database_url",
    "verify_demo_admin",
]
