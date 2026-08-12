"""Canonical registration, login, and current-user HTTP routes."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.auth.service import (
    UserTokenConfigurationError,
    UserTokenInvalidError,
    UserTokenService,
)
from app.auth.user_schemas import (
    CurrentUserResponse,
    TokenResponse,
    UserLoginRequest,
    UserRegisterRequest,
)
from app.auth.user_service import (
    UserAuthenticationError,
    UserRegistrationConflictError,
    authenticate_user,
    create_customer,
)
from app.core.rate_limit import (
    FixedWindowRateLimiter,
    get_auth_login_rate_limiter,
    get_client_bucket_key,
)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post(
    "/register",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a customer account",
    responses={
        409: {"description": "Account already exists"},
        429: {"description": "Registration rate limit exceeded"},
        503: {"description": "Authentication service unavailable"},
    },
)
def register_user(payload: UserRegisterRequest, request: Request) -> TokenResponse:
    """Create one customer account and issue a canonical access token."""
    token_service = _get_token_service(request)
    _enforce_rate_limit(request, "user_register_rate_limiter")
    session_factory = _get_session_factory(request)
    try:
        with session_factory() as session:
            user = create_customer(
                session,
                email=payload.email,
                password=payload.password.get_secret_value(),
            )
            user_id = user.id
    except UserRegistrationConflictError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Account already exists",
        ) from None
    except SQLAlchemyError:
        raise _service_unavailable_error() from None
    return _issue_token(token_service, user_id)


@router.post(
    "/login",
    response_model=TokenResponse,
    summary="Sign in a registered user",
    responses={
        401: {"description": "Invalid credentials"},
        429: {"description": "User sign-in rate limit exceeded"},
        503: {"description": "Authentication service unavailable"},
    },
)
def login_user(payload: UserLoginRequest, request: Request) -> TokenResponse:
    """Authenticate any active registered role and issue a canonical token."""
    token_service = _get_token_service(request)
    _enforce_login_rate_limit(request)
    session_factory = _get_session_factory(request)
    try:
        with session_factory() as session:
            user = authenticate_user(
                session,
                email=payload.email,
                password=payload.password.get_secret_value(),
            )
            user_id = user.id
    except UserAuthenticationError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None
    except SQLAlchemyError:
        raise _service_unavailable_error() from None
    return _issue_token(token_service, user_id)


@router.get(
    "/me",
    response_model=CurrentUserResponse,
    summary="Get the current registered user",
    responses={
        401: {"description": "Invalid authentication credentials"},
        503: {"description": "Authentication service unavailable"},
    },
)
def get_current_registered_user(user: CurrentUser) -> CurrentUserResponse:
    """Return the current database-authoritative identity and role."""
    return CurrentUserResponse(
        id=user.id,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
    )


def _get_token_service(request: Request) -> UserTokenService:
    token_service: UserTokenService | None = getattr(
        request.app.state,
        "user_token_service",
        None,
    )
    if token_service is None:
        raise _service_unavailable_error()
    return token_service


def _get_session_factory(request: Request) -> sessionmaker[Session]:
    session_factory: sessionmaker[Session] | None = getattr(
        request.app.state,
        "session_factory",
        None,
    )
    if session_factory is None:
        raise _service_unavailable_error()
    return session_factory


def _enforce_rate_limit(request: Request, state_name: str) -> None:
    limiter: FixedWindowRateLimiter = getattr(request.app.state, state_name)
    rate_limit = limiter.check(get_client_bucket_key(request))
    if not rate_limit.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many authentication attempts",
            headers={"Retry-After": str(rate_limit.retry_after_seconds)},
        )


def _enforce_login_rate_limit(request: Request) -> None:
    limiter = get_auth_login_rate_limiter(request)
    rate_limit = limiter.check(get_client_bucket_key(request))
    if not rate_limit.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many authentication attempts",
            headers={"Retry-After": str(rate_limit.retry_after_seconds)},
        )


def _issue_token(token_service: UserTokenService, user_id: UUID) -> TokenResponse:
    try:
        access_token = token_service.create_access_token(user_id)
        claims = token_service.decode_access_token(access_token)
    except (UserTokenConfigurationError, UserTokenInvalidError):
        raise _service_unavailable_error() from None
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        expires_in=int((claims.expires_at - claims.issued_at).total_seconds()),
    )


def _service_unavailable_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Authentication service unavailable",
    )
