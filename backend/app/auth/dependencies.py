"""Reusable canonical user authentication and role dependencies."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.schemas import AdminPrincipal
from app.auth.service import (
    UserTokenConfigurationError,
    UserTokenInvalidError,
    UserTokenService,
)

user_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="UserBearer",
    bearerFormat="JWT user_access",
    description="Canonical registered-user access token",
)
UserBearerCredentials = Annotated[
    HTTPAuthorizationCredentials | None,
    Security(user_bearer),
]


def get_current_user(
    request: Request,
    credentials: UserBearerCredentials,
) -> User:
    """Authenticate and reload one active canonical User from PostgreSQL.

    Args:
        request: Current request containing app-scoped authentication state.
        credentials: Optional parsed canonical Bearer credentials.

    Returns:
        The current active User with database-authoritative role state.

    Raises:
        HTTPException: With the stable 503 or generic Bearer-challenged 401.
    """
    token_service: UserTokenService | None = getattr(
        request.app.state,
        "user_token_service",
        None,
    )
    if token_service is None:
        raise _service_unavailable_error()
    if (
        credentials is None
        or credentials.scheme.lower() != "bearer"
        or not credentials.credentials.strip()
    ):
        raise _invalid_authentication_error()

    try:
        claims = token_service.decode_access_token(credentials.credentials)
    except UserTokenInvalidError:
        raise _invalid_authentication_error() from None
    except UserTokenConfigurationError:
        raise _service_unavailable_error() from None

    session_factory: sessionmaker[Session] | None = getattr(
        request.app.state,
        "session_factory",
        None,
    )
    if session_factory is None:
        raise _service_unavailable_error()
    try:
        with session_factory() as session:
            user = session.scalar(select(User).where(User.id == claims.user_id))
            if user is None or not user.is_active:
                raise _invalid_authentication_error()
            session.expunge(user)
            return user
    except SQLAlchemyError:
        raise _service_unavailable_error() from None


def get_optional_current_user(
    request: Request,
    credentials: UserBearerCredentials,
) -> User | None:
    """Return no identity only when Authorization is completely absent.

    Args:
        request: Current request containing headers and authentication state.
        credentials: Credentials parsed by the canonical UserBearer scheme.

    Returns:
        The current active User, or None for a request without Authorization.

    Raises:
        HTTPException: With the strict canonical 401 or safe 503 contract when
            an Authorization header is present.
    """
    if request.headers.get("Authorization") is None:
        return None
    if (
        credentials is None
        or credentials.scheme.lower() != "bearer"
        or not credentials.credentials.strip()
    ):
        raise _invalid_authentication_error()
    return get_current_user(request, credentials)


def require_admin(
    user: Annotated[User, Depends(get_current_user)],
) -> AdminPrincipal:
    """Authorize one current active canonical admin or super-admin.

    Args:
        user: Current active User loaded by the canonical Bearer dependency.

    Returns:
        Immutable current administrator identity.

    Raises:
        HTTPException: With 403 when the current role is not administrative.
    """
    if user.role not in {UserRole.ADMIN, UserRole.SUPER_ADMIN}:
        raise _insufficient_role_error("Administrator access required")
    return AdminPrincipal(id=user.id, email=user.email)


def require_super_admin(
    user: Annotated[User, Depends(get_current_user)],
) -> AdminPrincipal:
    """Authorize one current active canonical super-admin.

    Args:
        user: Current active User loaded by the canonical Bearer dependency.

    Returns:
        Immutable current super-administrator identity.

    Raises:
        HTTPException: With 403 when the current role is not super-admin.
    """
    if user.role is not UserRole.SUPER_ADMIN:
        raise _insufficient_role_error("Super-administrator access required")
    return AdminPrincipal(id=user.id, email=user.email)


def _invalid_authentication_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _service_unavailable_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Authentication service unavailable",
    )


def _insufficient_role_error(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=detail,
    )
