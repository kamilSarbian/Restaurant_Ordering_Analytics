"""Database-backed administrator credential authentication."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import AdminUser
from app.auth.passwords import verify_dummy_password, verify_password
from app.auth.schemas import AdminPrincipal


class AdminAuthenticationError(Exception):
    """Report an administrator credential failure without distinguishing its cause."""


def authenticate_admin(
    session: Session,
    *,
    email: str,
    password: str,
) -> AdminPrincipal:
    """Authenticate one administrator through an exact normalized email lookup.

    Args:
        session: Database session used only for the identity lookup.
        email: Already-normalized administrator email address.
        password: Exact submitted password without normalization.

    Returns:
        Immutable authenticated administrator identity.

    Raises:
        AdminAuthenticationError: If the identity is unknown, the password is
            wrong, or the administrator is inactive.
    """
    admin = session.scalar(select(AdminUser).where(AdminUser.email == email))
    if admin is None:
        verify_dummy_password(password)
        raise AdminAuthenticationError("Administrator credentials are invalid")

    password_matches = verify_password(password, admin.password_hash)
    if not password_matches or not admin.is_active:
        raise AdminAuthenticationError("Administrator credentials are invalid")

    return AdminPrincipal(id=admin.id, email=admin.email)
