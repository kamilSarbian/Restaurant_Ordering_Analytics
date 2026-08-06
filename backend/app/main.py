from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from sqlalchemy.orm import Session, sessionmaker

from app.api.health import router as health_router
from app.core.config import Settings
from app.database.session import create_database_engine, create_session_factory
from app.menu.router import router as menu_router
from app.menu.schemas import PublicMenuResponse


def create_app(
    *,
    settings: Settings | None = None,
    session_factory: sessionmaker[Session] | None = None,
) -> FastAPI:
    """Create and configure the FastAPI application.

    Args:
        settings: Optional application settings override.
        session_factory: Optional database session factory for dependency injection.

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
    application.include_router(health_router)
    application.include_router(menu_router)

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
