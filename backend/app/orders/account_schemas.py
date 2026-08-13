"""Strict customer account order-list response schemas."""

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.orders.schemas import CurrencyCode, OrderType, PublicOrderNumber
from app.orders.statuses import OrderStatus


class AccountOrderListItem(BaseModel):
    """Expose one customer-safe personally owned Order summary."""

    model_config = ConfigDict(extra="forbid", strict=True)

    public_order_number: PublicOrderNumber
    status: OrderStatus
    order_type: OrderType
    total_amount: int = Field(strict=True, gt=0)
    currency: CurrencyCode
    created_at: AwareDatetime
    updated_at: AwareDatetime


class AccountOrderListResponse(BaseModel):
    """Expose one deterministic page of personally owned Orders."""

    model_config = ConfigDict(extra="forbid", strict=True)

    items: list[AccountOrderListItem]
    total: int = Field(strict=True, ge=0)
    limit: int = Field(strict=True, ge=1, le=100)
    offset: int = Field(strict=True, ge=0)
