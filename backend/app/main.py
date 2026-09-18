from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session, sessionmaker
from starlette.datastructures import MutableHeaders
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.analytics.router import router as analytics_router
from app.api.health import router as health_router
from app.auth.admin_router import router as admin_users_router
from app.auth.service import UserTokenService, create_user_token_service
from app.auth.users_router import router as users_router
from app.core.config import Settings
from app.core.rate_limit import FixedWindowRateLimiter
from app.database.session import create_database_engine, create_session_factory
from app.menu.admin_router import router as admin_menu_router
from app.menu.router import router as menu_router
from app.menu.schemas import PublicMenuResponse
from app.orders.account_router import router as account_orders_router
from app.orders.admin_router import router as admin_orders_router
from app.orders.router import router as orders_router
from app.payments.checkout import utc_now
from app.payments.router import router as payments_router
from app.payments.stripe_checkout import StripeCheckoutClient
from app.payments.stripe_webhook import StripeWebhookVerifier
from app.payments.webhook_router import router as webhook_router
from app.reports.router import router as reports_router

API_SECURITY_HEADERS = (
    (
        "Content-Security-Policy",
        "default-src 'none'; base-uri 'none'; form-action 'none'; "
        "frame-ancestors 'none'; object-src 'none'",
    ),
    ("Cache-Control", "no-store"),
    (
        "Permissions-Policy",
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    ),
    ("Referrer-Policy", "no-referrer"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("X-Permitted-Cross-Domain-Policies", "none"),
    ("X-XSS-Protection", "0"),
)
HSTS_HEADER_VALUE = "max-age=31536000; includeSubDomains"


class ApiSecurityHeadersMiddleware:
    """Apply the API response security contract without changing payloads."""

    def __init__(self, app: ASGIApp, *, include_hsts: bool) -> None:
        """Initialize the middleware for one application environment."""
        self.app = app
        self.include_hsts = include_hsts

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        """Add headers to every HTTP response, including handled failures."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_security_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in API_SECURITY_HEADERS:
                    if name not in headers:
                        headers[name] = value
                if self.include_hsts and "Strict-Transport-Security" not in headers:
                    headers["Strict-Transport-Security"] = HSTS_HEADER_VALUE
            await send(message)

        await self.app(scope, receive, send_with_security_headers)


def create_app(
    *,
    settings: Settings | None = None,
    session_factory: sessionmaker[Session] | None = None,
    order_creation_rate_limiter: FixedWindowRateLimiter | None = None,
    checkout_rate_limiter: FixedWindowRateLimiter | None = None,
    user_register_rate_limiter: FixedWindowRateLimiter | None = None,
    user_login_rate_limiter: FixedWindowRateLimiter | None = None,
    user_token_service: UserTokenService | None = None,
    stripe_checkout_client: StripeCheckoutClient | None = None,
    stripe_webhook_verifier: StripeWebhookVerifier | None = None,
    checkout_now_provider: Callable[[], datetime] | None = None,
) -> FastAPI:
    """Create and configure the FastAPI application.

    Args:
        settings: Optional application settings override.
        session_factory: Optional database session factory for dependency injection.
        order_creation_rate_limiter: Optional app-scoped limiter override.
        checkout_rate_limiter: Optional app-scoped checkout limiter override.
        user_register_rate_limiter: Optional canonical registration limiter.
        user_login_rate_limiter: Optional canonical user-login limiter.
        user_token_service: Optional app-scoped canonical user token service.
        stripe_checkout_client: Optional app-scoped Stripe adapter override.
        stripe_webhook_verifier: Optional app-scoped webhook verifier override.
        checkout_now_provider: Optional deterministic checkout clock override.

    Returns:
        Configured FastAPI application.
    """
    resolved_settings = settings or Settings()
    is_production = resolved_settings.app_environment == "production"

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        database_engine = None
        resolved_session_factory = session_factory
        if (
            resolved_session_factory is None
            and resolved_settings.database_url is not None
        ):
            database_engine = create_database_engine(resolved_settings.database_url)
            resolved_session_factory = create_session_factory(database_engine)

        if resolved_session_factory is not None:
            application.state.session_factory = resolved_session_factory

        try:
            yield
        finally:
            if hasattr(application.state, "session_factory"):
                del application.state.session_factory
            if database_engine is not None:
                database_engine.dispose()

    application = FastAPI(
        title=resolved_settings.app_name,
        version=resolved_settings.app_version,
        debug=resolved_settings.app_debug,
        docs_url=None if is_production else "/docs",
        lifespan=lifespan,
        openapi_url=None if is_production else "/openapi.json",
        redoc_url=None if is_production else "/redoc",
    )
    if is_production:

        async def production_server_error_handler(
            request: Request,
            _exception: Exception,
        ) -> PlainTextResponse:
            """Return a generic 500 with the production security headers."""
            headers = dict(API_SECURITY_HEADERS)
            headers["Strict-Transport-Security"] = HSTS_HEADER_VALUE
            if request.headers.get("origin") == resolved_settings.public_app_origin:
                headers["Access-Control-Allow-Origin"] = (
                    resolved_settings.public_app_origin
                )
                headers["Vary"] = "Origin"
            return PlainTextResponse(
                "Internal Server Error",
                status_code=500,
                headers=headers,
            )

        application.add_exception_handler(
            Exception,
            production_server_error_handler,
        )
        if resolved_settings.public_app_origin is None:
            raise RuntimeError("Production public application origin is unavailable")
        application.add_middleware(
            CORSMiddleware,
            allow_credentials=False,
            allow_headers=[
                "Accept",
                "Authorization",
                "Content-Type",
                "Idempotency-Key",
                "X-Order-Access-Token",
            ],
            allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
            allow_origins=[resolved_settings.public_app_origin],
            expose_headers=["Content-Disposition", "Retry-After"],
            max_age=600,
        )
        application.add_middleware(
            TrustedHostMiddleware,
            allowed_hosts=list(resolved_settings.trusted_hosts),
            www_redirect=False,
        )
        application.add_middleware(
            ApiSecurityHeadersMiddleware,
            include_hsts=True,
        )
    application.state.order_creation_rate_limiter = (
        order_creation_rate_limiter
        if order_creation_rate_limiter is not None
        else FixedWindowRateLimiter(limit=10, window_seconds=60)
    )
    application.state.checkout_rate_limiter = (
        checkout_rate_limiter
        if checkout_rate_limiter is not None
        else FixedWindowRateLimiter(limit=10, window_seconds=60)
    )
    application.state.user_register_rate_limiter = (
        user_register_rate_limiter
        if user_register_rate_limiter is not None
        else FixedWindowRateLimiter(limit=5, window_seconds=60)
    )
    application.state.user_login_rate_limiter = (
        user_login_rate_limiter
        if user_login_rate_limiter is not None
        else FixedWindowRateLimiter(limit=5, window_seconds=60)
    )
    configured_user_token_service = create_user_token_service(
        resolved_settings.auth_jwt_secret,
        resolved_settings.auth_access_token_expire_minutes,
    )
    application.state.user_token_service = (
        user_token_service
        if user_token_service is not None
        else configured_user_token_service
    )
    application.state.stripe_checkout_client = (
        stripe_checkout_client
        if stripe_checkout_client is not None
        else (
            StripeCheckoutClient(
                resolved_settings.stripe_secret_key,
                expected_livemode=resolved_settings.stripe_expected_livemode,
            )
            if resolved_settings.payment_provider == "stripe_test"
            and resolved_settings.stripe_secret_key is not None
            else None
        )
    )
    application.state.stripe_webhook_verifier = (
        stripe_webhook_verifier
        if stripe_webhook_verifier is not None
        else (
            StripeWebhookVerifier(
                resolved_settings.stripe_webhook_secret,
                expected_livemode=resolved_settings.stripe_expected_livemode,
            )
            if resolved_settings.payment_provider == "stripe_test"
            and resolved_settings.stripe_webhook_secret is not None
            else None
        )
    )
    application.state.payment_provider = resolved_settings.payment_provider
    application.state.portfolio_demo_mode = resolved_settings.portfolio_demo_mode
    application.state.stripe_success_url = resolved_settings.stripe_success_url
    application.state.stripe_cancel_url = resolved_settings.stripe_cancel_url
    application.state.checkout_now_provider = checkout_now_provider or utc_now
    application.include_router(users_router)
    application.include_router(health_router)
    application.include_router(menu_router)
    application.include_router(orders_router)
    application.include_router(account_orders_router)
    application.include_router(admin_orders_router)
    application.include_router(admin_menu_router)
    application.include_router(admin_users_router)
    application.include_router(analytics_router)
    application.include_router(reports_router)
    application.include_router(payments_router)
    application.include_router(webhook_router)

    if not is_production:
        default_openapi = application.openapi

        def openapi_schema() -> dict[str, Any]:
            document = default_openapi()
            document["components"]["schemas"]["PublicMenuResponse"][
                "example"
            ] = PublicMenuResponse.model_json_schema()["example"]
            return document

        application.openapi = openapi_schema
    return application


app = create_app()
