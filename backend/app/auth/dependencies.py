"""Reusable legacy administrator and canonical user dependencies."""

from __future__ import annotations

from typing import Annotated

from fastapi import HTTPException, Request, Security, status
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
    decode_admin_compatible_token,
)
from app.auth.tokens import (
    AdminTokenConfigurationError,
    AdminTokenService,
)

admin_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="AdminBearer",
    bearerFormat="JWT",
)
user_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="UserBearer",
    bearerFormat="JWT user_access",
    description="Canonical registered-user access token",
)


def get_current_user(
    request: Request,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Security(user_bearer),
    ],
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


def require_admin(
    request: Request,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Security(admin_bearer),
    ],
) -> AdminPrincipal:
    """Authorize one current active admin or super_admin from either token family.

    Args:
        request: Current request containing app-scoped authentication state.
        credentials: Optional parsed HTTP Bearer credentials.

    Returns:
        Immutable current administrator identity.

    Raises:
        HTTPException: With the stable 503 or 401 authentication contract.
        HTTPException: With 401, 403, or safe 503 administrator semantics.
    """
    return _require_current_role(
        request,
        credentials,
        allowed_roles={UserRole.ADMIN, UserRole.SUPER_ADMIN},
        forbidden_detail="Administrator access required",
    )


def require_super_admin(
    request: Request,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Security(admin_bearer),
    ],
) -> AdminPrincipal:
    """Authorize one current active super_admin from either token family.

    Args:
        request: Current request containing app-scoped authentication state.
        credentials: Optional parsed HTTP Bearer credentials.

    Returns:
        Immutable current super-administrator identity.

    Raises:
        HTTPException: With 401, 403, or safe 503 authorization semantics.
    """
    return _require_current_role(
        request,
        credentials,
        allowed_roles={UserRole.SUPER_ADMIN},
        forbidden_detail="Super-administrator access required",
    )


def _require_current_role(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
    *,
    allowed_roles: set[UserRole],
    forbidden_detail: str,
) -> AdminPrincipal:
    user_token_service: UserTokenService | None = getattr(
        request.app.state,
        "user_token_service",
        None,
    )
    legacy_token_service: AdminTokenService | None = getattr(
        request.app.state,
        "admin_token_service",
        None,
    )
    if user_token_service is None and legacy_token_service is None:
        raise _service_unavailable_error()
    if (
        credentials is None
        or credentials.scheme.lower() != "bearer"
        or not credentials.credentials.strip()
    ):
        raise _invalid_authentication_error()

    try:
        user_id = decode_admin_compatible_token(
            credentials.credentials,
            user_token_service=user_token_service,
            legacy_token_service=legacy_token_service,
        )
    except UserTokenInvalidError:
        raise _invalid_authentication_error() from None
    except (UserTokenConfigurationError, AdminTokenConfigurationError):
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
            user = session.scalar(select(User).where(User.id == user_id))
            if user is None or not user.is_active:
                raise _invalid_authentication_error()
            if user.role not in allowed_roles:
                raise _insufficient_role_error(forbidden_detail)
            return AdminPrincipal(id=user.id, email=user.email)
    except SQLAlchemyError:
        raise _service_unavailable_error() from None


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
