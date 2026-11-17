from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PortfolioExchangeRatesResponse(BaseModel):
    """Validated ECB rates exposed to the portfolio calculator."""

    model_config = ConfigDict(extra="forbid")

    source: Literal["European Central Bank"] = "European Central Bank"
    base: Literal["EUR"] = "EUR"
    reference_date: date
    nok_per_eur: Decimal = Field(gt=0)
    pln_per_eur: Decimal = Field(gt=0)
