"""Canonical public authentication and current-user HTTP routes."""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.demo_admin import (
    DemoAdminConflictError,
    DemoAdminDatabaseError,
    verify_demo_admin,
)
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
    DemoSessionClientIdentityError,
    FixedWindowRateLimiter,
    get_auth_login_rate_limiter,
    get_client_bucket_key,
    get_demo_session_bucket_key,
)

_PASSWORD_AUTH_PATHS = frozenset(
    {
        "/api/v1/auth/register",
        "/api/v1/auth/login",
    }
)
_DEMO_SESSION_PATH = "/api/v1/auth/demo-session"


def _public_password_auth_is_closed(request: Request) -> bool:
    """Return whether trusted runtime state forbids public password auth."""
    portfolio_demo_mode = getattr(request.app.state, "portfolio_demo_mode", None)
    payment_provider = getattr(request.app.state, "payment_provider", None)
    return portfolio_demo_mode is not False or payment_provider != "stripe_test"


def _public_demo_session_is_closed(request: Request) -> bool:
    """Return whether trusted runtime state forbids demo-session issuance."""
    portfolio_demo_mode = getattr(request.app.state, "portfolio_demo_mode", None)
    payment_provider = getattr(request.app.state, "payment_provider", None)
    issuance_enabled = getattr(
        request.app.state,
        "demo_session_issuance_enabled",
        None,
    )
    return (
        issuance_enabled is not True
        or portfolio_demo_mode is not True
        or payment_provider != "demo"
    )


class _PublicAuthenticationBoundaryRoute(APIRoute):
    """Close unavailable public auth routes before FastAPI handles their bodies."""

    def get_route_handler(
        self,
    ) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original_route_handler = super().get_route_handler()
        protects_password_auth = self.path in _PASSWORD_AUTH_PATHS
        protects_demo_session = self.path == _DEMO_SESSION_PATH

        async def guarded_route_handler(request: Request) -> Response:
            if protects_password_auth and _public_password_auth_is_closed(request):
                return JSONResponse(
                    status_code=status.HTTP_404_NOT_FOUND,
                    content={"detail": "Not Found"},
                )
            if protects_demo_session and _public_demo_session_is_closed(request):
                return JSONResponse(
                    status_code=status.HTTP_404_NOT_FOUND,
                    content={"detail": "Not Found"},
                )
            return await original_route_handler(request)

        return guarded_route_handler


router = APIRouter(
    prefix="/api/v1/auth",
    tags=["auth"],
    route_class=_PublicAuthenticationBoundaryRoute,
)
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


@router.post(
    "/demo-session",
    response_model=TokenResponse,
    summary="Start the portfolio demo administrator session",
    responses={
        404: {"description": "Demo session is unavailable"},
        429: {"description": "Demo-session rate limit exceeded"},
        503: {"description": "Authentication service unavailable"},
    },
)
def create_demo_session(request: Request) -> TokenResponse:
    """Issue a canonical token for the verified reserved demo administrator."""
    _enforce_demo_session_rate_limit(request)
    token_service = _get_token_service(request)
    session_factory = _get_session_factory(request)
    try:
        demo_admin = verify_demo_admin(session_factory)
    except (DemoAdminConflictError, DemoAdminDatabaseError):
        raise _service_unavailable_error() from None
    return _issue_token(token_service, demo_admin.id)


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
    _enforce_rate_limit_for_bucket(
        request,
        state_name,
        get_client_bucket_key(request),
    )


def _enforce_demo_session_rate_limit(request: Request) -> None:
    try:
        bucket_key = get_demo_session_bucket_key(request)
    except DemoSessionClientIdentityError:
        raise _service_unavailable_error() from None
    _enforce_rate_limit_for_bucket(
        request,
        "demo_session_rate_limiter",
        bucket_key,
    )


def _enforce_rate_limit_for_bucket(
    request: Request,
    state_name: str,
    bucket_key: str,
) -> None:
    limiter = getattr(request.app.state, state_name, None)
    if not isinstance(limiter, FixedWindowRateLimiter):
        raise _service_unavailable_error()
    rate_limit = limiter.check(bucket_key)
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
