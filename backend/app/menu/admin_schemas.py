"""Strict schemas for administrator menu management."""

from __future__ import annotations

from typing import Annotated, Self
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

CurrencyCode = Annotated[
    str,
    StringConstraints(strict=True, pattern=r"^[A-Z]{3}$"),
]
CategoryName = Annotated[str, StringConstraints(strict=True, max_length=120)]
MenuItemName = Annotated[str, StringConstraints(strict=True, max_length=120)]


def _trim_nonblank(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError("Name must not be blank")
    return normalized


def _trim_optional_nonblank(value: str | None) -> str | None:
    return _trim_nonblank(value) if value is not None else None


def _normalize_allergens(values: list[str]) -> list[str]:
    normalized = [value.strip() for value in values]
    if any(not value for value in normalized):
        raise ValueError("Allergens must not contain blank values")
    return normalized


def _normalize_optional_allergens(values: list[str] | None) -> list[str] | None:
    return _normalize_allergens(values) if values is not None else None


class AdminCategoryResponse(BaseModel):
    """Expose one category to an authenticated administrator."""

    model_config = ConfigDict(extra="forbid", strict=True)

    id: UUID
    name: str = Field(min_length=1, max_length=120)
    description: str | None
    display_order: int = Field(strict=True, ge=0)
    is_active: bool
    created_at: AwareDatetime
    updated_at: AwareDatetime


class AdminCategoryListResponse(BaseModel):
    """Represent one deterministic category page."""

    model_config = ConfigDict(extra="forbid", strict=True)

    items: list[AdminCategoryResponse]
    total: int = Field(strict=True, ge=0)
    limit: int = Field(strict=True, ge=1, le=100)
    offset: int = Field(strict=True, ge=0)


class AdminCategoryCreateRequest(BaseModel):
    """Validate creation of one administrator-managed category."""

    model_config = ConfigDict(extra="forbid", strict=True)

    name: CategoryName
    description: str | None = None
    display_order: int = Field(default=0, strict=True, ge=0)
    is_active: bool = True

    _normalize_name = field_validator("name")(_trim_nonblank)


class AdminCategoryUpdateRequest(BaseModel):
    """Validate a non-empty partial category update."""

    model_config = ConfigDict(extra="forbid", strict=True)

    name: CategoryName | None = None
    description: str | None = None
    display_order: int | None = Field(default=None, strict=True, ge=0)
    is_active: bool | None = None

    _normalize_name = field_validator("name")(_trim_optional_nonblank)

    @model_validator(mode="after")
    def reject_empty_update(self) -> Self:
        """Reject requests that do not explicitly supply a writable field."""
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        if any(
            field in self.model_fields_set and getattr(self, field) is None
            for field in ("name", "display_order", "is_active")
        ):
            raise ValueError("Non-null category fields must not be null")
        return self


class AdminMenuItemResponse(BaseModel):
    """Expose one menu item to an authenticated administrator."""

    model_config = ConfigDict(extra="forbid", strict=True)

    id: UUID
    category_id: UUID
    name: str = Field(min_length=1, max_length=120)
    description: str | None
    image_url: str | None = Field(max_length=2048)
    price_amount: int = Field(strict=True, gt=0)
    cost_amount: int | None = Field(strict=True, ge=0)
    currency: CurrencyCode
    allergens: list[str]
    display_order: int = Field(strict=True, ge=0)
    is_active: bool
    is_available: bool
    created_at: AwareDatetime
    updated_at: AwareDatetime


class AdminMenuItemListResponse(BaseModel):
    """Represent one deterministic menu-item page."""

    model_config = ConfigDict(extra="forbid", strict=True)

    items: list[AdminMenuItemResponse]
    total: int = Field(strict=True, ge=0)
    limit: int = Field(strict=True, ge=1, le=100)
    offset: int = Field(strict=True, ge=0)


class AdminMenuItemCreateRequest(BaseModel):
    """Validate creation of one administrator-managed menu item."""

    model_config = ConfigDict(extra="forbid")

    category_id: UUID
    name: MenuItemName
    description: str | None = None
    image_url: str | None = Field(default=None, max_length=2048)
    price_amount: int = Field(strict=True, gt=0)
    cost_amount: int | None = Field(default=None, strict=True, ge=0)
    currency: CurrencyCode = "NOK"
    allergens: list[str] = Field(default_factory=list)
    display_order: int = Field(default=0, strict=True, ge=0)
    is_active: bool = Field(default=True, strict=True)
    is_available: bool = Field(default=True, strict=True)

    _normalize_name = field_validator("name")(_trim_nonblank)
    _normalize_allergen_values = field_validator("allergens")(_normalize_allergens)


class AdminMenuItemUpdateRequest(BaseModel):
    """Validate a non-empty partial menu-item update."""

    model_config = ConfigDict(extra="forbid")

    category_id: UUID | None = None
    name: MenuItemName | None = None
    description: str | None = None
    image_url: str | None = Field(default=None, max_length=2048)
    price_amount: int | None = Field(default=None, strict=True, gt=0)
    cost_amount: int | None = Field(default=None, strict=True, ge=0)
    currency: CurrencyCode | None = None
    allergens: list[str] | None = None
    display_order: int | None = Field(default=None, strict=True, ge=0)
    is_active: bool | None = Field(default=None, strict=True)
    is_available: bool | None = Field(default=None, strict=True)

    _normalize_name = field_validator("name")(_trim_optional_nonblank)
    _normalize_allergen_values = field_validator("allergens")(
        _normalize_optional_allergens
    )

    @model_validator(mode="after")
    def reject_empty_update(self) -> Self:
        """Reject requests that do not explicitly supply a writable field."""
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        if any(
            field in self.model_fields_set and getattr(self, field) is None
            for field in (
                "category_id",
                "name",
                "price_amount",
                "currency",
                "allergens",
                "display_order",
                "is_active",
                "is_available",
            )
        ):
            raise ValueError("Non-null menu-item fields must not be null")
        return self
