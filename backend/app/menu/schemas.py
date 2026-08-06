"""Public response schemas for the menu API."""

from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

CurrencyCode = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]


class PublicMenuItemResponse(BaseModel):
    """Represent a menu item safe for public clients."""

    model_config = ConfigDict(extra="forbid", strict=True)

    id: UUID
    name: str = Field(min_length=1, max_length=120)
    description: str | None
    image_url: str | None = Field(max_length=2048)
    price_amount: int = Field(gt=0)
    currency: CurrencyCode
    allergens: list[str]
    display_order: int = Field(ge=0)
    is_available: bool


class PublicCategoryResponse(BaseModel):
    """Represent an active category and its visible menu items."""

    model_config = ConfigDict(extra="forbid", strict=True)

    id: UUID
    name: str = Field(min_length=1, max_length=120)
    description: str | None
    display_order: int = Field(ge=0)
    items: list[PublicMenuItemResponse] = Field(min_length=1)


class PublicMenuResponse(BaseModel):
    """Represent the complete public menu envelope."""

    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        json_schema_extra={
            "example": {
                "categories": [
                    {
                        "id": "4990e5ad-67d1-45cf-a20a-0d15e7042255",
                        "name": "Desserts",
                        "description": None,
                        "display_order": 30,
                        "items": [
                            {
                                "id": "717dfb42-9ccb-45e7-b80b-93601087b0a7",
                                "name": "Chocolate Cake",
                                "description": "Chocolate cake with berry sauce.",
                                "image_url": None,
                                "price_amount": 12900,
                                "currency": "NOK",
                                "allergens": ["gluten", "egg", "milk"],
                                "display_order": 10,
                                "is_available": True,
                            },
                            {
                                "id": "95abd9ff-dea5-48fa-aa81-0632fb5caef7",
                                "name": "Warm Apple Cake",
                                "description": "Apple cake served warm.",
                                "image_url": None,
                                "price_amount": 11900,
                                "currency": "NOK",
                                "allergens": ["gluten", "milk"],
                                "display_order": 20,
                                "is_available": False,
                            },
                        ],
                    }
                ]
            }
        },
    )

    categories: list[PublicCategoryResponse]


class PublicMenuItemCategoryResponse(BaseModel):
    """Represent the category embedded in an item detail response."""

    model_config = ConfigDict(extra="forbid", strict=True)

    id: UUID
    name: str = Field(min_length=1, max_length=120)


class PublicMenuItemDetailResponse(PublicMenuItemResponse):
    """Represent one public menu item together with its category."""

    model_config = ConfigDict(extra="forbid", strict=True)

    category: PublicMenuItemCategoryResponse
