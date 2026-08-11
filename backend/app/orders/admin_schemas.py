"""Strict response schemas for administrator order reads."""

from __future__ import annotations

from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.orders.schemas import CurrencyCode, OrderType, PublicOrderNumber
from app.orders.statuses import OrderStatus
from app.payments.statuses import PaymentStatus


class AdminOrderListItem(BaseModel):
    """Represent one order in the administrator list."""

    model_config = ConfigDict(extra="forbid", strict=True)

    public_order_number: PublicOrderNumber
    status: OrderStatus
    order_type: OrderType
    table_number: int | None = Field(default=None, strict=True, gt=0)
    total_amount: int = Field(strict=True, gt=0)
    currency: CurrencyCode
    created_at: AwareDatetime
    updated_at: AwareDatetime


class AdminOrderListResponse(BaseModel):
    """Represent one deterministic page of administrator orders."""

    model_config = ConfigDict(extra="forbid", strict=True)

    items: list[AdminOrderListItem]
    total: int = Field(strict=True, ge=0)
    limit: int = Field(strict=True, ge=1, le=100)
    offset: int = Field(strict=True, ge=0)


class AdminOrderItem(BaseModel):
    """Expose one immutable historical order-item snapshot."""

    model_config = ConfigDict(extra="forbid", strict=True)

    id: UUID
    menu_item_id: UUID
    position: int = Field(strict=True, ge=0)
    category_name: str = Field(min_length=1)
    name: str = Field(min_length=1)
    quantity: int = Field(strict=True, ge=1, le=99)
    unit_price_amount: int = Field(strict=True, gt=0)
    unit_cost_amount: int | None = Field(default=None, strict=True, ge=0)
    tax_rate_bps: int | None = Field(default=None, strict=True, ge=0, le=10000)
    discount_amount: int = Field(strict=True, ge=0)
    line_total_amount: int = Field(strict=True, gt=0)


class AdminOrderStatusHistoryEntry(BaseModel):
    """Expose one ordered order-status history entry."""

    model_config = ConfigDict(extra="forbid", strict=True)

    sequence: int = Field(strict=True, ge=0)
    previous_status: OrderStatus | None
    new_status: OrderStatus
    changed_at: AwareDatetime


class AdminOrderStatusUpdateRequest(BaseModel):
    """Validate one requested administrator order-status transition."""

    model_config = ConfigDict(extra="forbid")

    status: OrderStatus


class AdminOrderStatusUpdateResponse(BaseModel):
    """Expose the result and new history entry of one status transition."""

    model_config = ConfigDict(extra="forbid", strict=True)

    public_order_number: PublicOrderNumber
    status: OrderStatus
    updated_at: AwareDatetime
    history: AdminOrderStatusHistoryEntry


class AdminPaymentSummary(BaseModel):
    """Expose a limited administrator view of one payment attempt."""

    model_config = ConfigDict(extra="forbid", strict=True)

    id: UUID
    status: PaymentStatus
    amount: int = Field(strict=True, gt=0)
    currency: CurrencyCode
    created_at: AwareDatetime
    updated_at: AwareDatetime
    checkout_expires_at: AwareDatetime | None


class AdminOrderDetail(BaseModel):
    """Represent the complete read-only administrator order detail."""

    model_config = ConfigDict(extra="forbid", strict=True)

    order_id: UUID
    public_order_number: PublicOrderNumber
    status: OrderStatus
    order_type: OrderType
    table_number: int | None = Field(default=None, strict=True, gt=0)
    currency: CurrencyCode
    subtotal_amount: int = Field(strict=True, gt=0)
    total_amount: int = Field(strict=True, gt=0)
    created_at: AwareDatetime
    updated_at: AwareDatetime
    items: list[AdminOrderItem]
    status_history: list[AdminOrderStatusHistoryEntry]
    payments: list[AdminPaymentSummary]
