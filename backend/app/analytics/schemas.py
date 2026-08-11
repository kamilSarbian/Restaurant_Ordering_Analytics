"""Strict schemas for administrator analytics boundaries."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from app.orders.schemas import OrderType

AnalyticsCurrency = Annotated[
    str,
    StringConstraints(strict=True, pattern=r"^[A-Z]{3}$"),
]


class AnalyticsOverviewQuery(BaseModel):
    """Validate the exact analytics overview query contract."""

    start: AwareDatetime
    end: AwareDatetime
    currency: AnalyticsCurrency | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_range(self) -> AnalyticsOverviewQuery:
        """Require a non-empty chronological reporting range."""
        if self.start >= self.end:
            raise ValueError("Analytics range start must be before end")
        return self


class AnalyticsBreakdownQuery(AnalyticsOverviewQuery):
    """Validate a ranged analytics query with a per-currency result limit."""

    limit: int = Field(default=50, ge=1, le=100)


class AnalyticsRangeResponse(BaseModel):
    """Represent the requested range in the reporting time zone."""

    start: AwareDatetime
    end: AwareDatetime
    timezone: Literal["Europe/Oslo"]

    model_config = ConfigDict(extra="forbid")


class AnalyticsOverviewCurrency(BaseModel):
    """Represent overview KPIs for one currency."""

    currency: AnalyticsCurrency
    collected_revenue_amount: int = Field(strict=True, ge=0)
    succeeded_orders_count: int = Field(strict=True, ge=0)
    average_order_value_amount: int = Field(strict=True, ge=0)

    model_config = ConfigDict(extra="forbid")


class AnalyticsOverviewResponse(BaseModel):
    """Represent the complete Stage 13B-1 overview response."""

    range: AnalyticsRangeResponse
    currencies: list[AnalyticsOverviewCurrency]

    model_config = ConfigDict(extra="forbid")


class AnalyticsProductItem(BaseModel):
    """Represent one historical product sales group."""

    menu_item_id: UUID
    item_name: str = Field(min_length=1, strict=True)
    currency: AnalyticsCurrency
    quantity_sold: int = Field(strict=True, ge=0)
    sales_amount: int = Field(strict=True, ge=0)

    model_config = ConfigDict(extra="forbid")


class AnalyticsProductResponse(BaseModel):
    """Represent per-currency top product sales groups."""

    range: AnalyticsRangeResponse
    limit_per_currency: int = Field(strict=True, ge=1, le=100)
    items: list[AnalyticsProductItem]

    model_config = ConfigDict(extra="forbid")


class AnalyticsCategoryItem(BaseModel):
    """Represent one historical category sales group."""

    category_name: str = Field(min_length=1, strict=True)
    currency: AnalyticsCurrency
    quantity_sold: int = Field(strict=True, ge=0)
    sales_amount: int = Field(strict=True, ge=0)

    model_config = ConfigDict(extra="forbid")


class AnalyticsCategoryResponse(BaseModel):
    """Represent per-currency top historical category sales groups."""

    range: AnalyticsRangeResponse
    limit_per_currency: int = Field(strict=True, ge=1, le=100)
    items: list[AnalyticsCategoryItem]

    model_config = ConfigDict(extra="forbid")


class AnalyticsOrderTypeItem(BaseModel):
    """Represent collected payment KPIs for one order type and currency."""

    order_type: OrderType
    currency: AnalyticsCurrency
    succeeded_orders_count: int = Field(strict=True, ge=0)
    collected_revenue_amount: int = Field(strict=True, ge=0)

    model_config = ConfigDict(extra="forbid")


class AnalyticsOrderTypeResponse(BaseModel):
    """Represent all paid order-type groups in a reporting range."""

    range: AnalyticsRangeResponse
    items: list[AnalyticsOrderTypeItem]

    model_config = ConfigDict(extra="forbid")
