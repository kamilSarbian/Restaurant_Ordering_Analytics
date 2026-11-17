from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.auth.demo_admin import is_demo_admin_identity
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.exchange_rates.provider import (
    ExchangeRateReader,
    ExchangeRateUnavailableError,
)
from app.exchange_rates.schemas import PortfolioExchangeRatesResponse

router = APIRouter(prefix="/api/v1/admin/exchange-rates", tags=["admin-exchange-rates"])


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


def _require_portfolio_demo_runtime(request: Request) -> None:
    if not (
        getattr(request.app.state, "portfolio_demo_mode", None) is True
        and getattr(request.app.state, "payment_provider", None) == "demo"
    ):
        raise _not_found()


@router.get(
    "/ecb",
    response_model=PortfolioExchangeRatesResponse,
    dependencies=[Depends(_require_portfolio_demo_runtime)],
)
def get_portfolio_exchange_rates(
    request: Request,
    current_user: Annotated[User, Depends(get_current_user)],
) -> PortfolioExchangeRatesResponse:
    """Return cached ECB rates only to the exact portfolio demo administrator."""
    if not is_demo_admin_identity(current_user):
        raise _not_found()
    provider: ExchangeRateReader | None = getattr(
        request.app.state, "exchange_rate_provider", None
    )
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ECB reference rates are unavailable",
        )
    try:
        rates = provider.get_rates()
    except ExchangeRateUnavailableError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ECB reference rates are unavailable",
        ) from None
    return PortfolioExchangeRatesResponse(
        reference_date=rates.rate_date,
        nok_per_eur=rates.nok_per_eur,
        pln_per_eur=rates.pln_per_eur,
    )
