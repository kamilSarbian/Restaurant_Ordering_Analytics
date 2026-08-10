"""Explicit administrator bootstrap service and command-line boundary."""

from __future__ import annotations

import argparse
import getpass
import sys
from collections.abc import Callable, Sequence

from pydantic import PostgresDsn, ValidationError
from sqlalchemy.engine import URL, Engine, make_url
from sqlalchemy.exc import ArgumentError, IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth.models import AdminUser
from app.auth.passwords import (
    AdminPasswordPolicyError,
    hash_password,
    validate_bootstrap_password,
)
from app.auth.schemas import AdminPrincipal, normalize_admin_email
from app.core.config import Settings
from app.database.session import create_database_engine, create_session_factory

ADMIN_EMAIL_UNIQUE_CONSTRAINT = "uq_admin_users_email"
ADMIN_DATABASE_NAME = "postgres"
TEST_DATABASE_NAME = "restaurant_ordering_analytics_test"
REQUIRED_DATABASE_DRIVER = "postgresql+psycopg"

PasswordPrompt = Callable[[str], str]


class AdminBootstrapConflictError(Exception):
    """Report that an administrator identity already exists."""


class AdminBootstrapInputError(ValueError):
    """Report invalid bootstrap input without exposing credential material."""


def create_admin(
    session: Session,
    *,
    email: str,
    password: str,
) -> AdminPrincipal:
    """Create one active administrator in a short database transaction.

    Args:
        session: Database session used for the single insert transaction.
        email: Administrator email to validate and normalize.
        password: Exact bootstrap password, including any whitespace.

    Returns:
        Immutable administrator identity without credential material.

    Raises:
        AdminBootstrapInputError: If the email or password policy is invalid.
        AdminBootstrapConflictError: If the normalized identity already exists.
        IntegrityError: If an unrelated database constraint rejects the insert.
    """
    try:
        normalized_email = normalize_admin_email(email)
    except ValueError:
        raise AdminBootstrapInputError("Administrator email is invalid") from None

    try:
        validated_password = validate_bootstrap_password(password)
    except AdminPasswordPolicyError as exc:
        raise AdminBootstrapInputError(str(exc)) from None

    password_hash = hash_password(validated_password)
    try:
        with session.begin():
            admin = AdminUser(
                email=normalized_email,
                password_hash=password_hash,
                is_active=True,
            )
            session.add(admin)
            session.flush()
            principal = AdminPrincipal(id=admin.id, email=admin.email)
    except IntegrityError as exc:
        if _constraint_name(exc) == ADMIN_EMAIL_UNIQUE_CONSTRAINT:
            raise AdminBootstrapConflictError(
                "Administrator identity already exists"
            ) from None
        raise
    return principal


def _constraint_name(error: IntegrityError) -> str | None:
    diagnostic = getattr(error.orig, "diag", None)
    value = getattr(diagnostic, "constraint_name", None)
    return value if isinstance(value, str) else None


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create an administrator through an explicit local command."
    )
    parser.add_argument("--email", required=True, help="Administrator email address.")
    return parser


def _validate_application_database_url(database_url: str | PostgresDsn) -> URL:
    try:
        parsed_url = make_url(str(database_url))
    except ArgumentError:
        raise AdminBootstrapInputError(
            "Application database configuration is invalid"
        ) from None

    if parsed_url.drivername != REQUIRED_DATABASE_DRIVER:
        raise AdminBootstrapInputError(
            "Administrator bootstrap requires the PostgreSQL Psycopg driver"
        )
    if not parsed_url.database:
        raise AdminBootstrapInputError("Application database name is required")
    if parsed_url.database in {ADMIN_DATABASE_NAME, TEST_DATABASE_NAME}:
        raise AdminBootstrapInputError(
            "Administrator bootstrap requires an application database"
        )
    return parsed_url


def main(
    argv: Sequence[str] | None = None,
    *,
    getpass_fn: PasswordPrompt | None = None,
) -> int:
    """Run the explicit administrator bootstrap command.

    Args:
        argv: Optional command arguments excluding the executable name.
        getpass_fn: Optional injectable non-echoing password prompt.

    Returns:
        Zero after creation and one after a handled failure.
    """
    arguments = _build_parser().parse_args(argv)
    prompt = getpass_fn or getpass.getpass
    try:
        password = prompt("Password: ")
        confirmation = prompt("Confirm password: ")
    except (EOFError, KeyboardInterrupt):
        print(
            "Administrator creation failed: password input was cancelled.",
            file=sys.stderr,
        )
        return 1

    if password != confirmation:
        print("Administrator creation failed: passwords do not match.", file=sys.stderr)
        return 1

    engine: Engine | None = None
    try:
        settings = Settings()
        if settings.database_url is None:
            raise AdminBootstrapInputError(
                "Application database configuration is required"
            )
        database_url = _validate_application_database_url(settings.database_url)
        engine = create_database_engine(
            database_url.render_as_string(hide_password=False)
        )
        session_factory = create_session_factory(engine)
        with session_factory() as session:
            create_admin(session, email=arguments.email, password=password)
        print("Administrator created.")
        return 0
    except (AdminBootstrapConflictError, AdminBootstrapInputError) as exc:
        print(f"Administrator creation failed: {exc}.", file=sys.stderr)
        return 1
    except ValidationError:
        print(
            "Administrator creation failed: application configuration is invalid.",
            file=sys.stderr,
        )
        return 1
    except SQLAlchemyError:
        print(
            "Administrator creation failed: the database operation did not complete.",
            file=sys.stderr,
        )
        return 1
    finally:
        if engine is not None:
            engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "AdminBootstrapConflictError",
    "AdminBootstrapInputError",
    "create_admin",
    "main",
]
