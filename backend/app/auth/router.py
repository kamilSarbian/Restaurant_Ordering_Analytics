"""HTTP routes for administrator sign-in and current identity."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.auth.roles import UserRole
from app.auth.schemas import (
    AdminLoginRequest,
    AdminMeResponse,
    AdminPrincipal,
    AdminTokenResponse,
)
from app.auth.service import (
    UserTokenConfigurationError,
    UserTokenInvalidError,
    UserTokenService,
)
from app.auth.user_service import UserAuthenticationError, authenticate_user
from app.core.rate_limit import get_auth_login_rate_limiter, get_client_bucket_key
from app.database.dependencies import get_db_session

router = APIRouter(prefix="/api/v1/admin/auth", tags=["admin-auth"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]
CurrentAdmin = Annotated[AdminPrincipal, Depends(require_admin)]


@router.post(
    "/login",
    response_model=AdminTokenResponse,
    summary="Sign in an administrator",
    responses={
        401: {"description": "Invalid credentials"},
        429: {"description": "Administrator sign-in rate limit exceeded"},
        503: {"description": "Authentication service unavailable"},
    },
)
def login_admin(
    payload: AdminLoginRequest,
    request: Request,
    session: DatabaseSession,
) -> AdminTokenResponse:
    """Authenticate an administrator and issue one access token."""
    token_service: UserTokenService | None = getattr(
        request.app.state,
        "user_token_service",
        None,
    )
    if token_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        )

    limiter = get_auth_login_rate_limiter(request)
    rate_limit = limiter.check(get_client_bucket_key(request))
    if not rate_limit.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many sign-in attempts",
            headers={"Retry-After": str(rate_limit.retry_after_seconds)},
        )

    try:
        user = authenticate_user(
            session,
            email=payload.email,
            password=payload.password.get_secret_value(),
        )
        if user.role not in {UserRole.ADMIN, UserRole.SUPER_ADMIN}:
            raise UserAuthenticationError("Credentials are invalid")
    except UserAuthenticationError:
        raise _invalid_credentials_error() from None
    except SQLAlchemyError:
        raise _service_unavailable_error() from None

    try:
        access_token = token_service.create_access_token(user.id)
        claims = token_service.decode_access_token(access_token)
    except (UserTokenConfigurationError, UserTokenInvalidError):
        raise _service_unavailable_error() from None
    expires_in = int((claims.expires_at - claims.issued_at).total_seconds())
    return AdminTokenResponse(
        access_token=access_token,
        token_type="bearer",
        expires_in=expires_in,
    )


@router.get(
    "/me",
    response_model=AdminMeResponse,
    summary="Get current administrator",
    responses={
        401: {"description": "Invalid authentication credentials"},
        503: {"description": "Authentication service unavailable"},
    },
)
def get_current_admin(principal: CurrentAdmin) -> AdminMeResponse:
    """Return the already-authorized active administrator identity."""
    return AdminMeResponse(email=principal.email, is_active=True)


def _invalid_credentials_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _service_unavailable_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Authentication service unavailable",
    )
