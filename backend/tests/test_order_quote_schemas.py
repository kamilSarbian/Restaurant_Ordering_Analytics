"""Unit tests for order quote request and response schemas."""

import json
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from app.orders.schemas import (
    OrderQuoteItemRequest,
    OrderQuoteLineResponse,
    OrderQuoteRequest,
    OrderQuoteResponse,
)

FIRST_ID = UUID("9933957b-7f5d-47d8-84c3-ba8ad21b2d8c")
SECOND_ID = UUID("c496b9cc-268c-4549-9e36-e8225e57561f")


def _request_item(
    menu_item_id: UUID = FIRST_ID,
    quantity: object = 1,
    **extra: object,
) -> dict[str, object]:
    return {
        "menu_item_id": str(menu_item_id),
        "quantity": quantity,
        **extra,
    }


def _response() -> OrderQuoteResponse:
    return OrderQuoteResponse(
        currency="NOK",
        items=[
            OrderQuoteLineResponse(
                menu_item_id=FIRST_ID,
                name="Classic Beef Burger",
                quantity=2,
                unit_price_amount=22900,
                line_total_amount=45800,
            )
        ],
        subtotal_amount=45800,
        total_amount=45800,
    )


def test_valid_single_item_request() -> None:
    """Accept one UUID and native integer quantity."""
    request = OrderQuoteRequest.model_validate({"items": [_request_item()]})

    assert request.items == [OrderQuoteItemRequest(menu_item_id=FIRST_ID, quantity=1)]


def test_valid_multiple_item_request_preserves_order() -> None:
    """Keep request order unchanged during schema validation."""
    request = OrderQuoteRequest.model_validate(
        {
            "items": [
                _request_item(SECOND_ID, 2),
                _request_item(FIRST_ID, 3),
            ]
        }
    )

    assert [item.menu_item_id for item in request.items] == [SECOND_ID, FIRST_ID]


def test_valid_uuid_json_string_is_parsed() -> None:
    """Allow the standard JSON string representation of a UUID."""
    request = OrderQuoteRequest.model_validate_json(
        json.dumps({"items": [_request_item()]})
    )

    assert request.items[0].menu_item_id == FIRST_ID


@pytest.mark.parametrize("quantity", [1, 99])
def test_quantity_boundaries_are_accepted(quantity: int) -> None:
    """Accept the approved inclusive quantity boundaries."""
    request = OrderQuoteRequest.model_validate(
        {"items": [_request_item(quantity=quantity)]}
    )

    assert request.items[0].quantity == quantity


@pytest.mark.parametrize(
    "quantity",
    [0, -1, 100, "2", 2.0, True, False],
)
def test_invalid_quantities_are_rejected(quantity: object) -> None:
    """Reject out-of-range and non-native integer quantities."""
    with pytest.raises(ValidationError):
        OrderQuoteRequest.model_validate({"items": [_request_item(quantity=quantity)]})


def test_empty_item_list_is_rejected() -> None:
    """Require at least one quote item."""
    with pytest.raises(ValidationError):
        OrderQuoteRequest.model_validate({"items": []})


def test_more_than_fifty_items_are_rejected() -> None:
    """Reject payloads beyond the approved item limit."""
    items = [_request_item(uuid4()) for _ in range(51)]

    with pytest.raises(ValidationError):
        OrderQuoteRequest.model_validate({"items": items})


def test_malformed_uuid_is_rejected() -> None:
    """Reject a menu item identifier that is not a UUID."""
    with pytest.raises(ValidationError):
        OrderQuoteRequest.model_validate(
            {"items": [{"menu_item_id": "not-a-uuid", "quantity": 1}]}
        )


@pytest.mark.parametrize(
    "ids",
    [
        [FIRST_ID, SECOND_ID, FIRST_ID],
        [SECOND_ID, FIRST_ID, SECOND_ID],
    ],
)
def test_duplicate_ids_are_rejected_independently_of_order(
    ids: list[UUID],
) -> None:
    """Reject every repeated identifier without aggregating quantities."""
    with pytest.raises(
        ValidationError,
        match="Duplicate menu_item_id values are not allowed",
    ):
        OrderQuoteRequest.model_validate(
            {"items": [_request_item(item_id) for item_id in ids]}
        )


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("price_amount", 1),
        ("unit_price_amount", 1),
        ("currency", "NOK"),
        ("name", "Client name"),
        ("cost_amount", 0),
    ],
)
def test_client_owned_item_fields_are_rejected(
    field_name: str,
    value: object,
) -> None:
    """Reject monetary and descriptive fields supplied by a client."""
    with pytest.raises(ValidationError):
        OrderQuoteRequest.model_validate(
            {"items": [_request_item(**{field_name: value})]}
        )


def test_extra_request_field_is_rejected() -> None:
    """Reject fields outside the top-level request contract."""
    with pytest.raises(ValidationError):
        OrderQuoteRequest.model_validate(
            {"items": [_request_item()], "customer": {"name": "Guest"}}
        )


def test_valid_response_uses_native_strict_values() -> None:
    """Accept native UUID and integer values in strict response schemas."""
    response = _response()

    assert response.items[0].menu_item_id is FIRST_ID
    assert response.total_amount == 45800


def test_response_serializes_uuid_to_json_string() -> None:
    """Serialize UUID values through the public JSON contract."""
    payload = _response().model_dump(mode="json")

    assert payload["items"][0]["menu_item_id"] == str(FIRST_ID)


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("quantity", "2"),
        ("unit_price_amount", "22900"),
        ("line_total_amount", "45800"),
    ],
)
def test_response_line_rejects_string_numbers(
    field_name: str,
    value: str,
) -> None:
    """Enforce strict native integer values in quote responses."""
    values = {
        "menu_item_id": FIRST_ID,
        "name": "Item",
        "quantity": 2,
        "unit_price_amount": 22900,
        "line_total_amount": 45800,
    }
    values[field_name] = value

    with pytest.raises(ValidationError):
        OrderQuoteLineResponse.model_validate(values)


def test_response_rejects_uuid_string_in_python_mode() -> None:
    """Keep response construction strict while JSON serialization stays standard."""
    with pytest.raises(ValidationError):
        OrderQuoteLineResponse.model_validate(
            {
                "menu_item_id": str(FIRST_ID),
                "name": "Item",
                "quantity": 1,
                "unit_price_amount": 1,
                "line_total_amount": 1,
            }
        )


def test_response_rejects_extra_fields() -> None:
    """Prevent internal or future fields from leaking into responses."""
    payload = _response().model_dump()
    payload["quote_id"] = uuid4()

    with pytest.raises(ValidationError):
        OrderQuoteResponse.model_validate(payload)


def test_request_json_schema_contains_only_client_owned_fields() -> None:
    """Keep prices and currency outside the request JSON Schema."""
    schema_text = json.dumps(OrderQuoteRequest.model_json_schema())

    assert "price" not in schema_text
    assert "currency" not in schema_text
    assert set(OrderQuoteItemRequest.model_json_schema()["properties"]) == {
        "menu_item_id",
        "quantity",
    }


def test_response_json_schema_excludes_persistent_and_internal_fields() -> None:
    """Keep order, payment, customer, cost, and timestamp data out of responses."""
    schema_text = json.dumps(OrderQuoteResponse.model_json_schema())
    forbidden_fields = {
        "quote_id",
        "order_id",
        "payment_id",
        "created_at",
        "quoted_at",
        "expires_at",
        "cost_amount",
        "customer",
        "is_active",
        "is_available",
    }

    assert all(field not in schema_text for field in forbidden_fields)
