from fastapi import FastAPI

from app.api.health import router as health_router
from app.core.config import Settings


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = Settings()
    application = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        debug=settings.app_debug,
    )
    application.include_router(health_router)
    return application


app = create_app()
