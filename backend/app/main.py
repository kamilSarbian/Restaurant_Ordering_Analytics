from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from fastapi import FastAPI
from sqlalchemy.orm import Session, sessionmaker

from app.analytics.router import router as analytics_router
from app.api.health import router as health_router
from app.auth.router import router as auth_router
from app.auth.tokens import AdminTokenService
from app.core.config import Settings
from app.core.rate_limit import FixedWindowRateLimiter
from app.database.session import create_database_engine, create_session_factory
from app.menu.admin_router import router as admin_menu_router
from app.menu.router import router as menu_router
from app.menu.schemas import PublicMenuResponse
from app.orders.admin_router import router as admin_orders_router
from app.orders.router import router as orders_router
from app.payments.checkout import utc_now
from app.payments.router import router as payments_router
from app.payments.stripe_checkout import StripeCheckoutClient
from app.payments.stripe_webhook import StripeWebhookVerifier
from app.payments.webhook_router import router as webhook_router
from app.reports.router import router as reports_router


def create_app(
    *,
    settings: Settings | None = None,
    session_factory: sessionmaker[Session] | None = None,
    order_creation_rate_limiter: FixedWindowRateLimiter | None = None,
    checkout_rate_limiter: FixedWindowRateLimiter | None = None,
    admin_login_rate_limiter: FixedWindowRateLimiter | None = None,
    admin_token_service: AdminTokenService | None = None,
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
        admin_login_rate_limiter: Optional administrator login limiter override.
        admin_token_service: Optional app-scoped administrator token service.
        stripe_checkout_client: Optional app-scoped Stripe adapter override.
        stripe_webhook_verifier: Optional app-scoped webhook verifier override.
        checkout_now_provider: Optional deterministic checkout clock override.

    Returns:
        Configured FastAPI application.
    """
    resolved_settings = settings or Settings()

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
        lifespan=lifespan,
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
    application.state.admin_login_rate_limiter = (
        admin_login_rate_limiter
        if admin_login_rate_limiter is not None
        else FixedWindowRateLimiter(limit=5, window_seconds=60)
    )
    application.state.admin_token_service = (
        admin_token_service
        if admin_token_service is not None
        else (
            AdminTokenService(
                resolved_settings.admin_jwt_secret,
                resolved_settings.admin_access_token_expire_minutes,
            )
            if resolved_settings.admin_jwt_secret is not None
            else None
        )
    )
    application.state.stripe_checkout_client = (
        stripe_checkout_client
        if stripe_checkout_client is not None
        else (
            StripeCheckoutClient(resolved_settings.stripe_secret_key)
            if resolved_settings.stripe_secret_key is not None
            else None
        )
    )
    application.state.stripe_webhook_verifier = (
        stripe_webhook_verifier
        if stripe_webhook_verifier is not None
        else (
            StripeWebhookVerifier(resolved_settings.stripe_webhook_secret)
            if resolved_settings.stripe_webhook_secret is not None
            else None
        )
    )
    application.state.stripe_success_url = resolved_settings.stripe_success_url
    application.state.stripe_cancel_url = resolved_settings.stripe_cancel_url
    application.state.checkout_now_provider = checkout_now_provider or utc_now
    application.include_router(auth_router)
    application.include_router(health_router)
    application.include_router(menu_router)
    application.include_router(orders_router)
    application.include_router(admin_orders_router)
    application.include_router(admin_menu_router)
    application.include_router(analytics_router)
    application.include_router(reports_router)
    application.include_router(payments_router)
    application.include_router(webhook_router)

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
