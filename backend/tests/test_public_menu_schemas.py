"""Unit tests for the strict public menu response schemas."""

import json
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.menu.schemas import (
    PublicCategoryResponse,
    PublicMenuItemCategoryResponse,
    PublicMenuItemDetailResponse,
    PublicMenuItemResponse,
    PublicMenuResponse,
)

ITEM_ID = UUID("95abd9ff-dea5-48fa-aa81-0632fb5caef7")
CATEGORY_ID = UUID("4990e5ad-67d1-45cf-a20a-0d15e7042255")


def _item_data() -> dict[str, object]:
    return {
        "id": ITEM_ID,
        "name": "Warm Apple Cake",
        "description": None,
        "image_url": None,
        "price_amount": 11900,
        "currency": "NOK",
        "allergens": ["gluten", "milk"],
        "display_order": 20,
        "is_available": False,
    }


def test_public_menu_item_preserves_public_values() -> None:
    """Public item serialization preserves UUIDs, nulls, arrays, and availability."""
    item = PublicMenuItemResponse(**_item_data())

    assert item.model_dump() == _item_data()
    assert item.model_dump(mode="json")["id"] == str(ITEM_ID)
    assert item.image_url is None
    assert item.allergens == ["gluten", "milk"]
    assert item.is_available is False


def test_public_menu_envelope_supports_categories_and_an_empty_menu() -> None:
    """The stable envelope represents both populated and empty public menus."""
    category = PublicCategoryResponse(
        id=CATEGORY_ID,
        name="Desserts",
        description=None,
        display_order=30,
        items=[PublicMenuItemResponse(**_item_data())],
    )

    menu = PublicMenuResponse(categories=[category])
    empty_menu = PublicMenuResponse(categories=[])

    assert menu.categories[0].items[0].id == ITEM_ID
    assert empty_menu.model_dump() == {"categories": []}


def test_public_menu_item_detail_embeds_only_public_category_fields() -> None:
    """The detail response adds a minimal nested category object."""
    detail = PublicMenuItemDetailResponse(
        **_item_data(),
        category=PublicMenuItemCategoryResponse(id=CATEGORY_ID, name="Desserts"),
    )

    assert detail.category.model_dump() == {
        "id": CATEGORY_ID,
        "name": "Desserts",
    }


@pytest.mark.parametrize(
    "internal_field",
    ["cost_amount", "created_at", "updated_at", "is_active", "category_id"],
)
def test_public_item_rejects_internal_fields(internal_field: str) -> None:
    """Internal model fields cannot enter the public response contract."""
    values = _item_data()
    values[internal_field] = 1

    with pytest.raises(ValidationError):
        PublicMenuItemResponse(**values)


@pytest.mark.parametrize(
    ("field", "invalid_value"),
    [
        ("id", str(ITEM_ID)),
        ("name", ""),
        ("name", "x" * 121),
        ("image_url", "x" * 2049),
        ("price_amount", 0),
        ("price_amount", -1),
        ("price_amount", True),
        ("currency", "nok"),
        ("currency", "NOKK"),
        ("display_order", -1),
        ("is_available", 1),
    ],
)
def test_public_item_enforces_strict_field_constraints(
    field: str, invalid_value: object
) -> None:
    """Public fields reject coercion and values outside the documented constraints."""
    values = _item_data()
    values[field] = invalid_value

    with pytest.raises(ValidationError):
        PublicMenuItemResponse(**values)


def test_public_category_rejects_an_empty_item_list() -> None:
    """A category without visible items cannot enter a populated response."""
    with pytest.raises(ValidationError):
        PublicCategoryResponse(
            id=CATEGORY_ID,
            name="Desserts",
            description=None,
            display_order=30,
            items=[],
        )


@pytest.mark.parametrize(
    "schema",
    [
        PublicMenuItemResponse,
        PublicCategoryResponse,
        PublicMenuResponse,
        PublicMenuItemCategoryResponse,
        PublicMenuItemDetailResponse,
    ],
)
def test_every_public_schema_forbids_extra_fields(schema: type) -> None:
    """Every public schema independently declares the strict extra-field policy."""
    assert schema.model_config["extra"] == "forbid"
    assert schema.model_config["strict"] is True


def test_openapi_schema_contains_no_internal_field_names() -> None:
    """Generated public schema definitions never advertise internal model fields."""
    schema_text = json.dumps(PublicMenuResponse.model_json_schema())

    for field_name in (
        "cost_amount",
        "created_at",
        "updated_at",
        "is_active",
        "category_id",
    ):
        assert field_name not in schema_text
