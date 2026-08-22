import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

router = APIRouter()
logger = logging.getLogger(__name__)


class HealthResponse(BaseModel):
    """Represent the process health response."""

    status: Literal["ok"]


@router.get(
    "/health",
    response_model=HealthResponse,
    status_code=status.HTTP_200_OK,
    tags=["health"],
)
def get_health() -> HealthResponse:
    """Return the application process health status."""
    return HealthResponse(status="ok")


@router.get(
    "/ready",
    response_model=HealthResponse,
    status_code=status.HTTP_200_OK,
    tags=["health"],
    responses={503: {"description": "Service is not ready"}},
)
def get_readiness(request: Request) -> HealthResponse:
    """Return readiness only after a successful database probe."""
    session_factory: sessionmaker[Session] | None = getattr(
        request.app.state,
        "session_factory",
        None,
    )
    if session_factory is None:
        logger.warning("Readiness check has no configured database session factory")
        raise _service_unavailable_error()

    try:
        with session_factory() as session:
            probe_result = session.execute(text("SELECT 1")).scalar_one()
    except SQLAlchemyError:
        logger.warning("Readiness database probe failed")
        raise _service_unavailable_error() from None

    if probe_result != 1:
        logger.warning("Readiness database probe returned an unexpected result")
        raise _service_unavailable_error()
    return HealthResponse(status="ok")


def _service_unavailable_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Service is not ready",
    )
