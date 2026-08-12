"""Database services for canonical registered-user authentication."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.models import User
from app.auth.passwords import hash_password, verify_dummy_password, verify_password
from app.auth.roles import UserRole
from app.auth.schemas import normalize_admin_email
from app.auth.user_schemas import (
    UserAdminListItem,
    UserAdminListResponse,
    UserRoleUpdateRequest,
    UserRoleUpdateResponse,
)

USER_EMAIL_UNIQUE_CONSTRAINT = "uq_users_email"


class UserRegistrationConflictError(Exception):
    """Report an existing normalized account without exposing its state."""


class UserAuthenticationError(Exception):
    """Report a canonical credential failure without distinguishing its cause."""


class UserNotFoundError(Exception):
    """Report that a requested registered user does not exist."""


class UserRoleConflictError(Exception):
    """Report a forbidden or ineffective ordinary role transition."""


def find_user_by_email(session: Session, *, email: str) -> User | None:
    """Find one User by the canonical form of an email address.

    Args:
        session: Database session used for the identity lookup.
        email: Email address to validate and normalize.

    Returns:
        The matching User or None.
    """
    normalized_email = normalize_admin_email(email)
    return session.scalar(select(User).where(User.email == normalized_email))


def create_customer(session: Session, *, email: str, password: str) -> User:
    """Create one active customer in a short transaction.

    Args:
        session: Database session controlling the insert transaction.
        email: Email address to validate and normalize.
        password: Exact registration password without normalization.

    Returns:
        The newly persisted customer.

    Raises:
        UserRegistrationConflictError: If the normalized email already exists.
        IntegrityError: If an unrelated database constraint rejects the insert.
    """
    normalized_email = normalize_admin_email(email)
    password_hash = hash_password(password)
    try:
        with session.begin():
            user = User(
                email=normalized_email,
                password_hash=password_hash,
                role=UserRole.CUSTOMER,
                is_active=True,
            )
            session.add(user)
            session.flush()
    except IntegrityError as exc:
        if _constraint_name(exc) == USER_EMAIL_UNIQUE_CONSTRAINT:
            raise UserRegistrationConflictError("Account already exists") from None
        raise
    return user


def authenticate_user(session: Session, *, email: str, password: str) -> User:
    """Authenticate one active User without role-specific behavior.

    Args:
        session: Database session used only for the identity lookup.
        email: Email address to validate and normalize.
        password: Exact submitted password without normalization.

    Returns:
        The authenticated active User for any registered role.

    Raises:
        UserAuthenticationError: If the identity is missing, inactive, or the
            password is wrong.
    """
    user = find_user_by_email(session, email=email)
    if user is None:
        verify_dummy_password(password)
        raise UserAuthenticationError("Credentials are invalid")

    password_matches = verify_password(password, user.password_hash)
    if not password_matches or not user.is_active:
        raise UserAuthenticationError("Credentials are invalid")
    return user


def list_users(
    session: Session,
    *,
    limit: int,
    offset: int,
) -> UserAdminListResponse:
    """Return one deterministic safe page of registered users.

    Args:
        session: Open request-scoped database session.
        limit: Maximum number of identities returned.
        offset: Number of identities skipped before the page.

    Returns:
        Safe user identities ordered by creation time and UUID.
    """
    total = session.scalar(select(func.count()).select_from(User))
    users = session.scalars(
        select(User)
        .order_by(User.created_at.asc(), User.id.asc())
        .limit(limit)
        .offset(offset)
    ).all()
    return UserAdminListResponse(
        items=[_build_user_list_item(user) for user in users],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


def update_user_role(
    session: Session,
    *,
    user_id: UUID,
    request: UserRoleUpdateRequest,
) -> UserRoleUpdateResponse:
    """Serialize and apply one ordinary user-role transition.

    Args:
        session: Request-scoped session with no active transaction.
        user_id: Registered identity to update.
        request: Validated customer or administrator target role.

    Returns:
        Safe detached representation of the changed role.

    Raises:
        UserNotFoundError: If the target identity does not exist.
        UserRoleConflictError: If the transition is ineffective or targets a
            super-administrator.
    """
    response: UserRoleUpdateResponse | None = None
    with session.begin():
        user = session.scalar(select(User).where(User.id == user_id).with_for_update())
        if user is None:
            raise UserNotFoundError
        if user.role is UserRole.SUPER_ADMIN:
            raise UserRoleConflictError
        target_role = UserRole(request.role)
        if user.role is target_role:
            raise UserRoleConflictError
        user.role = target_role
        session.flush()
        session.refresh(user, attribute_names=["updated_at"])
        response = UserRoleUpdateResponse(
            id=user.id,
            email=user.email,
            role=user.role,
            updated_at=user.updated_at,
        )
    if response is None:
        raise RuntimeError("User role update produced no response")
    return response


def _build_user_list_item(user: User) -> UserAdminListItem:
    return UserAdminListItem(
        id=user.id,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


def _constraint_name(error: IntegrityError) -> str | None:
    diagnostic = getattr(error.orig, "diag", None)
    value = getattr(diagnostic, "constraint_name", None)
    return value if isinstance(value, str) else None


__all__ = [
    "UserAuthenticationError",
    "UserNotFoundError",
    "UserRegistrationConflictError",
    "UserRoleConflictError",
    "authenticate_user",
    "create_customer",
    "find_user_by_email",
    "list_users",
    "update_user_role",
]
