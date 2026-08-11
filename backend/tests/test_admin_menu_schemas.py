"""Unit tests for strict administrator menu schemas."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.menu.admin_schemas import (
    AdminCategoryCreateRequest,
    AdminCategoryListResponse,
    AdminCategoryResponse,
    AdminCategoryUpdateRequest,
    AdminMenuItemCreateRequest,
    AdminMenuItemListResponse,
    AdminMenuItemResponse,
    AdminMenuItemUpdateRequest,
)

NOW = datetime(2026, 1, 1, tzinfo=UTC)


def _category_response_values() -> dict[str, object]:
    return {
        "id": uuid4(),
        "name": "Drinks",
        "description": None,
        "display_order": 1,
        "is_active": True,
        "created_at": NOW,
        "updated_at": NOW,
    }


def _item_response_values() -> dict[str, object]:
    return {
        "id": uuid4(),
        "category_id": uuid4(),
        "name": "Coffee",
        "description": None,
        "image_url": None,
        "price_amount": 4900,
        "cost_amount": 1200,
        "currency": "NOK",
        "allergens": ["milk"],
        "display_order": 1,
        "is_active": True,
        "is_available": True,
        "created_at": NOW,
        "updated_at": NOW,
    }


def test_category_create_trims_name_and_uses_model_defaults() -> None:
    request = AdminCategoryCreateRequest(name="  Drinks  ")

    assert request.model_dump() == {
        "name": "Drinks",
        "description": None,
        "display_order": 0,
        "is_active": True,
    }


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"name": "   "},
        {"name": "x" * 121},
        {"name": 123},
        {"name": "Valid", "display_order": -1},
        {"name": "Valid", "display_order": True},
        {"name": "Valid", "display_order": "1"},
        {"name": "Valid", "is_active": 1},
        {"name": "Valid", "unexpected": True},
        {"name": "Valid", "id": str(uuid4())},
        {"name": "Valid", "created_at": NOW.isoformat()},
    ],
)
def test_category_create_rejects_invalid_or_internal_fields(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        AdminCategoryCreateRequest.model_validate(payload)


def test_category_update_tracks_only_explicit_fields_and_allows_null_description() -> (
    None
):
    request = AdminCategoryUpdateRequest(description=None, is_active=False)

    assert request.model_dump(exclude_unset=True) == {
        "description": None,
        "is_active": False,
    }


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"name": None},
        {"name": "  "},
        {"display_order": None},
        {"is_active": None},
        {"unexpected": True},
    ],
)
def test_category_update_rejects_empty_null_nonnullable_and_extra_fields(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        AdminCategoryUpdateRequest.model_validate(payload)


def test_menu_item_create_trims_values_preserves_duplicates_and_uses_defaults() -> None:
    category_id = uuid4()
    request = AdminMenuItemCreateRequest(
        category_id=category_id,
        name="  Latte  ",
        price_amount=5900,
        allergens=[" milk ", "milk"],
    )

    assert request.model_dump() == {
        "category_id": category_id,
        "name": "Latte",
        "description": None,
        "image_url": None,
        "price_amount": 5900,
        "cost_amount": None,
        "currency": "NOK",
        "allergens": ["milk", "milk"],
        "display_order": 0,
        "is_active": True,
        "is_available": True,
    }


@pytest.mark.parametrize("value", [0, -1, True, 1.5, "100"])
def test_menu_item_create_rejects_invalid_or_non_strict_price(value: object) -> None:
    with pytest.raises(ValidationError):
        AdminMenuItemCreateRequest(
            category_id=uuid4(),
            name="Item",
            price_amount=value,
        )


@pytest.mark.parametrize("value", [-1, True, 1.5, "100"])
def test_menu_item_create_rejects_invalid_or_non_strict_cost(value: object) -> None:
    with pytest.raises(ValidationError):
        AdminMenuItemCreateRequest(
            category_id=uuid4(),
            name="Item",
            price_amount=100,
            cost_amount=value,
        )


@pytest.mark.parametrize("currency", ["nok", "NO", "NOKK", "12A", 123])
def test_menu_item_create_rejects_noncanonical_currency(currency: object) -> None:
    with pytest.raises(ValidationError):
        AdminMenuItemCreateRequest(
            category_id=uuid4(),
            name="Item",
            price_amount=100,
            currency=currency,
        )


@pytest.mark.parametrize(
    "allergens",
    [[""], ["  "], [1], "milk", None],
)
def test_menu_item_create_rejects_invalid_allergens(allergens: object) -> None:
    with pytest.raises(ValidationError):
        AdminMenuItemCreateRequest(
            category_id=uuid4(),
            name="Item",
            price_amount=100,
            allergens=allergens,
        )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"category_id": None},
        {"name": None},
        {"price_amount": None},
        {"currency": None},
        {"allergens": None},
        {"display_order": None},
        {"is_active": None},
        {"is_available": None},
        {"unexpected": True},
    ],
)
def test_menu_item_update_rejects_empty_null_nonnullable_and_extra_fields(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        AdminMenuItemUpdateRequest.model_validate(payload)


def test_menu_item_update_allows_nullable_fields_and_normalizes_writable_values() -> (
    None
):
    request = AdminMenuItemUpdateRequest(
        name="  Updated  ",
        description=None,
        image_url=None,
        cost_amount=None,
        allergens=[" gluten ", "gluten"],
    )

    assert request.model_dump(exclude_unset=True) == {
        "name": "Updated",
        "description": None,
        "image_url": None,
        "cost_amount": None,
        "allergens": ["gluten", "gluten"],
    }


def test_category_response_and_page_are_strict_and_require_aware_timestamps() -> None:
    category = AdminCategoryResponse(**_category_response_values())
    page = AdminCategoryListResponse(items=[category], total=1, limit=50, offset=0)

    assert page.items == [category]
    for changed in (
        {"created_at": datetime(2026, 1, 1)},
        {"unexpected": True},
    ):
        with pytest.raises(ValidationError):
            AdminCategoryResponse(**(_category_response_values() | changed))


def test_menu_item_response_and_page_are_strict_and_complete() -> None:
    item = AdminMenuItemResponse(**_item_response_values())
    page = AdminMenuItemListResponse(items=[item], total=1, limit=100, offset=0)

    assert set(item.model_dump()) == {
        "id",
        "category_id",
        "name",
        "description",
        "image_url",
        "price_amount",
        "cost_amount",
        "currency",
        "allergens",
        "display_order",
        "is_active",
        "is_available",
        "created_at",
        "updated_at",
    }
    assert page.items == [item]
    with pytest.raises(ValidationError):
        AdminMenuItemResponse(**(_item_response_values() | {"price_amount": True}))


@pytest.mark.parametrize(
    ("response_type", "values"),
    [
        (
            AdminCategoryListResponse,
            {"items": [], "total": -1, "limit": 1, "offset": 0},
        ),
        (AdminCategoryListResponse, {"items": [], "total": 0, "limit": 0, "offset": 0}),
        (
            AdminCategoryListResponse,
            {"items": [], "total": 0, "limit": 101, "offset": 0},
        ),
        (
            AdminMenuItemListResponse,
            {"items": [], "total": 0, "limit": 1, "offset": -1},
        ),
    ],
)
def test_list_responses_enforce_pagination_contract(
    response_type: type[AdminCategoryListResponse] | type[AdminMenuItemListResponse],
    values: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        response_type.model_validate(values)
