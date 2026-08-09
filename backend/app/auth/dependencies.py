"""Reusable FastAPI administrator authorization dependencies."""

from __future__ import annotations

from typing import Annotated

from fastapi import HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import AdminUser
from app.auth.schemas import AdminPrincipal
from app.auth.tokens import (
    AdminTokenConfigurationError,
    AdminTokenInvalidError,
    AdminTokenService,
)

admin_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="AdminBearer",
    bearerFormat="JWT",
)


def require_admin(
    request: Request,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Security(admin_bearer),
    ],
) -> AdminPrincipal:
    """Authenticate one active administrator for a protected request.

    Args:
        request: Current request containing app-scoped authentication state.
        credentials: Optional parsed HTTP Bearer credentials.

    Returns:
        Immutable current administrator identity.

    Raises:
        HTTPException: With the stable 503 or 401 authentication contract.
        RuntimeError: If a valid token reaches an app without a session factory.
    """
    token_service: AdminTokenService | None = getattr(
        request.app.state,
        "admin_token_service",
        None,
    )
    if token_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        )

    if (
        credentials is None
        or credentials.scheme.lower() != "bearer"
        or not credentials.credentials.strip()
    ):
        raise _invalid_authentication_error()

    try:
        claims = token_service.decode_access_token(credentials.credentials)
    except AdminTokenInvalidError:
        raise _invalid_authentication_error() from None
    except AdminTokenConfigurationError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        ) from None

    session_factory: sessionmaker[Session] | None = getattr(
        request.app.state,
        "session_factory",
        None,
    )
    if session_factory is None:
        raise RuntimeError("Database session factory is not configured")

    with session_factory() as session:
        admin = session.scalar(select(AdminUser).where(AdminUser.id == claims.admin_id))
        if admin is None or not admin.is_active:
            raise _invalid_authentication_error()
        return AdminPrincipal(id=admin.id, email=admin.email)


def _invalid_authentication_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
