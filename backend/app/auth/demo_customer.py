"""Reserved non-password customer identity for the portfolio demo."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import or_, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.roles import UserRole

DEMO_CUSTOMER_ID = UUID("7f0c8d3f-4f58-4b2e-8d4a-2a5df7b40002")
DEMO_CUSTOMER_EMAIL = "demo-customer@example.com"
DEMO_CUSTOMER_DISABLED_PASSWORD_HASH = "!portfolio-demo-customer-login-disabled-v1"
DEMO_CUSTOMER_PROVISION_LOCK_KEY = 593_216_404_005

DemoCustomerStatus = Literal[
    "provisioned",
    "already_exact",
    "verified",
    "missing",
    "active",
    "inactive",
    "deactivated",
    "already_inactive",
]


class DemoCustomerError(Exception):
    """Base class for sanitized demo-customer identity failures."""


class DemoCustomerConflictError(DemoCustomerError):
    """Report missing, conflicting, or drifted demo-customer state."""


class DemoCustomerDatabaseError(DemoCustomerError):
    """Report a sanitized demo-customer database failure."""


@dataclass(frozen=True, slots=True)
class DemoCustomerResult:
    """Describe a demo-customer operation without credential data."""

    id: UUID
    email: str
    status: DemoCustomerStatus


def has_reserved_demo_customer_identifier(user: User) -> bool:
    """Return whether either protected demo-customer identifier is present."""
    return user.id == DEMO_CUSTOMER_ID or user.email == DEMO_CUSTOMER_EMAIL


def is_demo_customer_identity(user: User) -> bool:
    """Return whether a user exactly matches the active reserved identity."""
    return _is_reserved_demo_customer(user, expected_active=True)


def inspect_demo_customer(
    session_factory: sessionmaker[Session],
) -> DemoCustomerResult:
    """Inspect the reserved identity without performing DML.

    Args:
        session_factory: Factory bound to an explicitly approved database.

    Returns:
        The exact reserved identity state: missing, active, or inactive.

    Raises:
        DemoCustomerConflictError: If reserved identity data collides or drifted.
        DemoCustomerDatabaseError: If the read-only database operation fails.
    """
    result: DemoCustomerResult | None = None
    sanitized_error: DemoCustomerError | None = None

    try:
        with session_factory() as session:
            candidates = _load_candidates(session, lock_rows=False)
            if not candidates:
                result = _result("missing")
            elif len(candidates) != 1:
                raise DemoCustomerConflictError(
                    "Demo customer identity conflicts with existing data."
                )
            elif _is_reserved_demo_customer(candidates[0], expected_active=True):
                result = _result("active")
            elif _is_reserved_demo_customer(candidates[0], expected_active=False):
                result = _result("inactive")
            else:
                raise DemoCustomerConflictError(
                    "Demo customer identity conflicts with existing data."
                )
    except DemoCustomerError:
        raise
    except SQLAlchemyError:
        sanitized_error = DemoCustomerDatabaseError(
            "The demo customer database operation did not complete."
        )

    if sanitized_error is not None:
        raise sanitized_error
    if result is None:  # pragma: no cover - defensive invariant
        raise DemoCustomerDatabaseError(
            "The demo customer database operation did not complete."
        )
    return result


def provision_demo_customer(
    session_factory: sessionmaker[Session],
) -> DemoCustomerResult:
    """Create the exact demo customer or verify an exact prior provision.

    Args:
        session_factory: Factory bound to an explicitly approved database.

    Returns:
        The reserved identity and whether it was inserted or already exact.

    Raises:
        DemoCustomerConflictError: If a reserved identifier collides or drifted.
        DemoCustomerDatabaseError: If the database operation does not complete.
    """
    result: DemoCustomerResult | None = None
    sanitized_error: DemoCustomerError | None = None

    try:
        with session_factory.begin() as session:
            _acquire_identity_lock(session)
            candidates = _load_candidates(session, lock_rows=True)
            if not candidates:
                user = User(
                    id=DEMO_CUSTOMER_ID,
                    email=DEMO_CUSTOMER_EMAIL,
                    password_hash=DEMO_CUSTOMER_DISABLED_PASSWORD_HASH,
                    role=UserRole.CUSTOMER,
                    is_active=True,
                )
                session.add(user)
                session.flush()
                result = _result("provisioned")
            elif len(candidates) == 1 and is_demo_customer_identity(candidates[0]):
                result = _result("already_exact")
            else:
                raise DemoCustomerConflictError(
                    "Demo customer identity conflicts with existing data."
                )
    except DemoCustomerError:
        raise
    except IntegrityError:
        sanitized_error = DemoCustomerConflictError(
            "Demo customer identity conflicts with existing data."
        )
    except SQLAlchemyError:
        sanitized_error = DemoCustomerDatabaseError(
            "The demo customer database operation did not complete."
        )

    if sanitized_error is not None:
        raise sanitized_error
    if result is None:  # pragma: no cover - defensive invariant
        raise DemoCustomerDatabaseError(
            "The demo customer database operation did not complete."
        )
    return result


def verify_demo_customer(
    session_factory: sessionmaker[Session],
) -> DemoCustomerResult:
    """Verify the exact active demo-customer identity without DML.

    Args:
        session_factory: Factory bound to an explicitly approved database.

    Returns:
        The verified reserved demo-customer identity.

    Raises:
        DemoCustomerConflictError: If the identity is missing, colliding, or drifted.
        DemoCustomerDatabaseError: If the read-only database operation fails.
    """
    result: DemoCustomerResult | None = None
    sanitized_error: DemoCustomerError | None = None

    try:
        with session_factory() as session:
            candidates = _load_candidates(session, lock_rows=False)
            if len(candidates) != 1 or not is_demo_customer_identity(candidates[0]):
                raise DemoCustomerConflictError(
                    "Demo customer identity is missing or conflicts with existing data."
                )
            result = _result("verified")
    except DemoCustomerError:
        raise
    except SQLAlchemyError:
        sanitized_error = DemoCustomerDatabaseError(
            "The demo customer database operation did not complete."
        )

    if sanitized_error is not None:
        raise sanitized_error
    if result is None:  # pragma: no cover - defensive invariant
        raise DemoCustomerDatabaseError(
            "The demo customer database operation did not complete."
        )
    return result


def deactivate_demo_customer(
    session_factory: sessionmaker[Session],
) -> DemoCustomerResult:
    """Deactivate the exact reserved identity or report an exact no-op.

    Args:
        session_factory: Factory bound to an explicitly approved database.

    Returns:
        The reserved identity and whether it changed or was already inactive.

    Raises:
        DemoCustomerConflictError: If the identity is missing, colliding, or drifted.
        DemoCustomerDatabaseError: If the database operation does not complete.
    """
    result: DemoCustomerResult | None = None
    sanitized_error: DemoCustomerError | None = None

    try:
        with session_factory.begin() as session:
            _acquire_identity_lock(session)
            candidates = _load_candidates(session, lock_rows=True)
            if len(candidates) != 1:
                raise DemoCustomerConflictError(
                    "Demo customer identity is missing or conflicts with existing data."
                )
            user = candidates[0]
            if _is_reserved_demo_customer(user, expected_active=True):
                user.is_active = False
                session.flush()
                result = _result("deactivated")
            elif _is_reserved_demo_customer(user, expected_active=False):
                result = _result("already_inactive")
            else:
                raise DemoCustomerConflictError(
                    "Demo customer identity conflicts with existing data."
                )
    except DemoCustomerError:
        raise
    except IntegrityError:
        sanitized_error = DemoCustomerConflictError(
            "Demo customer identity conflicts with existing data."
        )
    except SQLAlchemyError:
        sanitized_error = DemoCustomerDatabaseError(
            "The demo customer database operation did not complete."
        )

    if sanitized_error is not None:
        raise sanitized_error
    if result is None:  # pragma: no cover - defensive invariant
        raise DemoCustomerDatabaseError(
            "The demo customer database operation did not complete."
        )
    return result


def _is_reserved_demo_customer(user: User, *, expected_active: bool) -> bool:
    return (
        user.id == DEMO_CUSTOMER_ID
        and user.email == DEMO_CUSTOMER_EMAIL
        and user.password_hash == DEMO_CUSTOMER_DISABLED_PASSWORD_HASH
        and user.role == UserRole.CUSTOMER
        and user.is_active is expected_active
    )


def _acquire_identity_lock(session: Session) -> None:
    session.execute(
        text("SELECT pg_advisory_xact_lock(:lock_key)"),
        {"lock_key": DEMO_CUSTOMER_PROVISION_LOCK_KEY},
    )


def _load_candidates(session: Session, *, lock_rows: bool) -> tuple[User, ...]:
    statement = select(User).where(
        or_(User.id == DEMO_CUSTOMER_ID, User.email == DEMO_CUSTOMER_EMAIL)
    )
    if lock_rows:
        statement = statement.with_for_update()
    return tuple(session.scalars(statement).all())


def _result(status: DemoCustomerStatus) -> DemoCustomerResult:
    return DemoCustomerResult(
        id=DEMO_CUSTOMER_ID,
        email=DEMO_CUSTOMER_EMAIL,
        status=status,
    )
