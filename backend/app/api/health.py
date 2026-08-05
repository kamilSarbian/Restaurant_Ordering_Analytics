from typing import Literal

from fastapi import APIRouter, status
from pydantic import BaseModel

router = APIRouter()


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
