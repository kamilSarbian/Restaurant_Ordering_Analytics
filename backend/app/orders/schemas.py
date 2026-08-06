"""Request and response schemas for public order quotes."""

from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

CurrencyCode = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]

REQUEST_EXAMPLE = {
    "items": [
        {
            "menu_item_id": "9933957b-7f5d-47d8-84c3-ba8ad21b2d8c",
            "quantity": 2,
        },
        {
            "menu_item_id": "c496b9cc-268c-4549-9e36-e8225e57561f",
            "quantity": 1,
        },
    ]
}

RESPONSE_EXAMPLE = {
    "currency": "NOK",
    "items": [
        {
            "menu_item_id": "9933957b-7f5d-47d8-84c3-ba8ad21b2d8c",
            "name": "Classic Beef Burger",
            "quantity": 2,
            "unit_price_amount": 22900,
            "line_total_amount": 45800,
        },
        {
            "menu_item_id": "c496b9cc-268c-4549-9e36-e8225e57561f",
            "name": "Cloudberry Spritz",
            "quantity": 1,
            "unit_price_amount": 7900,
            "line_total_amount": 7900,
        },
    ],
    "subtotal_amount": 53700,
    "total_amount": 53700,
}


class OrderQuoteItemRequest(BaseModel):
    """Identify one menu item and the requested quantity."""

    model_config = ConfigDict(extra="forbid")

    menu_item_id: UUID
    quantity: int = Field(strict=True, ge=1, le=99)


class OrderQuoteRequest(BaseModel):
    """Request a transient quote for unique menu items."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"example": REQUEST_EXAMPLE},
    )

    items: list[OrderQuoteItemRequest] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def reject_duplicate_menu_items(self) -> "OrderQuoteRequest":
        """Reject duplicate identifiers instead of aggregating quantities."""
        menu_item_ids = [item.menu_item_id for item in self.items]
        if len(menu_item_ids) != len(set(menu_item_ids)):
            raise ValueError("Duplicate menu_item_id values are not allowed")
        return self


class OrderQuoteLineResponse(BaseModel):
    """Represent one server-priced line in an order quote."""

    model_config = ConfigDict(extra="forbid", strict=True)

    menu_item_id: UUID
    name: str = Field(min_length=1)
    quantity: int = Field(ge=1, le=99)
    unit_price_amount: int = Field(gt=0)
    line_total_amount: int = Field(gt=0)


class OrderQuoteResponse(BaseModel):
    """Represent a complete point-in-time order quote."""

    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        json_schema_extra={"example": RESPONSE_EXAMPLE},
    )

    currency: CurrencyCode
    items: list[OrderQuoteLineResponse] = Field(min_length=1)
    subtotal_amount: int = Field(gt=0)
    total_amount: int = Field(gt=0)
