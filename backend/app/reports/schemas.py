"""Strict query schemas for administrator CSV exports."""

from __future__ import annotations

from typing import Annotated

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    StringConstraints,
    model_validator,
)

from app.orders.schemas import OrderType
from app.orders.statuses import OrderStatus

ExportCurrency = Annotated[
    str,
    StringConstraints(strict=True, pattern=r"^[A-Z]{3}$"),
]


class OrdersCsvExportQuery(BaseModel):
    """Validate the exact administrator orders CSV query contract."""

    start: AwareDatetime
    end: AwareDatetime
    currency: ExportCurrency | None = None
    status: OrderStatus | None = None
    order_type: OrderType | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_range(self) -> OrdersCsvExportQuery:
        """Require a non-empty chronological export range."""
        if self.start >= self.end:
            raise ValueError("Export range start must be before end")
        return self


class AnalyticsCsvExportQuery(BaseModel):
    """Validate the exact product-sales and payments CSV query contract."""

    start: AwareDatetime
    end: AwareDatetime
    currency: ExportCurrency | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_range(self) -> AnalyticsCsvExportQuery:
        """Require a non-empty chronological export range."""
        if self.start >= self.end:
            raise ValueError("Export range start must be before end")
        return self
