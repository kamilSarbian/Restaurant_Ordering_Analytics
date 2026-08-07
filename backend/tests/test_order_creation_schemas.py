"""Unit tests for order creation and public status contracts."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError

from app.orders.schemas import (
    OrderCreateItemRequest,
    OrderCreateItemResponse,
    OrderCreateRequest,
    OrderCreateResponse,
    OrderStatusResponse,
    OrderType,
)
from app.orders.statuses import OrderStatus

ITEM_ID = UUID("9933957b-7f5d-47d8-84c3-ba8ad21b2d8c")
SECOND_ITEM_ID = UUID("c496b9cc-268c-4549-9e36-e8225e57561f")
PUBLIC_NUMBER = "ROA-23456789ABCD"


def _request_payload(**values: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "order_type": "takeaway",
        "items": [{"menu_item_id": str(ITEM_ID), "quantity": 1}],
    }
    payload.update(values)
    return payload


def _item_response(**values: object) -> OrderCreateItemResponse:
    fields: dict[str, object] = {
        "menu_item_id": ITEM_ID,
        "name": "Historical Burger",
        "quantity": 2,
        "unit_price_amount": 100,
        "line_total_amount": 200,
    }
    fields.update(values)
    return OrderCreateItemResponse(**fields)


def _create_response(**values: object) -> OrderCreateResponse:
    fields: dict[str, object] = {
        "public_order_number": PUBLIC_NUMBER,
        "order_access_token": "one-time-token",
        "status": OrderStatus.CREATED,
        "order_type": OrderType.TAKEAWAY,
        "table_number": None,
        "currency": "NOK",
        "items": [_item_response()],
        "subtotal_amount": 200,
        "total_amount": 200,
    }
    fields.update(values)
    return OrderCreateResponse(**fields)


def _status_response(**values: object) -> OrderStatusResponse:
    fields: dict[str, object] = {
        "public_order_number": PUBLIC_NUMBER,
        "status": OrderStatus.CREATED,
        "order_type": OrderType.TAKEAWAY,
        "table_number": None,
        "currency": "NOK",
        "items": [_item_response()],
        "subtotal_amount": 200,
        "total_amount": 200,
        "created_at": datetime(2026, 8, 7, 12, 0, tzinfo=UTC),
        "updated_at": datetime(2026, 8, 7, 12, 1, tzinfo=UTC),
    }
    fields.update(values)
    return OrderStatusResponse(**fields)


def test_order_type_contains_exactly_two_values() -> None:
    """Keep the public order type contract intentionally small."""
    assert [value.value for value in OrderType] == ["dine_in", "takeaway"]


def test_order_create_item_request_has_exact_fields() -> None:
    """Accept only a parsed menu item UUID and strict quantity."""
    item = OrderCreateItemRequest.model_validate(
        {"menu_item_id": str(ITEM_ID), "quantity": 1}
    )
    assert item.menu_item_id == ITEM_ID
    assert item.quantity == 1
    assert set(item.model_dump()) == {"menu_item_id", "quantity"}


@pytest.mark.parametrize(
    "payload",
    [
        _request_payload(),
        _request_payload(order_type="takeaway", table_number=None),
        _request_payload(order_type="dine_in", table_number=1),
        _request_payload(
            items=[
                {"menu_item_id": str(ITEM_ID), "quantity": 1},
                {"menu_item_id": str(SECOND_ITEM_ID), "quantity": 99},
            ]
        ),
    ],
)
def test_order_create_request_accepts_valid_json(payload: dict[str, object]) -> None:
    """Parse UUID strings while keeping integers strict."""
    request = OrderCreateRequest.model_validate(payload)
    assert all(isinstance(item.menu_item_id, UUID) for item in request.items)


@pytest.mark.parametrize("quantity", [0, -1, 100, True, "1", 1.0])
def test_order_create_request_rejects_invalid_quantity(quantity: object) -> None:
    """Reject out-of-range and coerced quantity values."""
    with pytest.raises(ValidationError):
        OrderCreateRequest.model_validate(
            _request_payload(
                items=[{"menu_item_id": str(ITEM_ID), "quantity": quantity}]
            )
        )


def test_order_create_request_rejects_empty_items() -> None:
    """Require at least one item."""
    with pytest.raises(ValidationError):
        OrderCreateRequest.model_validate(_request_payload(items=[]))


def test_order_create_request_rejects_more_than_fifty_items() -> None:
    """Bound one request to fifty unique menu items."""
    items = [{"menu_item_id": str(uuid4()), "quantity": 1} for _ in range(51)]
    with pytest.raises(ValidationError):
        OrderCreateRequest.model_validate(_request_payload(items=items))


def test_order_create_request_rejects_duplicate_items_with_exact_message() -> None:
    """Reject duplicate identifiers without aggregating quantities."""
    with pytest.raises(
        ValidationError,
        match="Duplicate menu_item_id values are not allowed",
    ):
        OrderCreateRequest.model_validate(
            _request_payload(
                items=[
                    {"menu_item_id": str(ITEM_ID), "quantity": 1},
                    {"menu_item_id": str(ITEM_ID), "quantity": 2},
                ]
            )
        )


def test_order_create_request_rejects_malformed_uuid() -> None:
    """Reject malformed menu item identifiers."""
    with pytest.raises(ValidationError):
        OrderCreateRequest.model_validate(
            _request_payload(items=[{"menu_item_id": "invalid", "quantity": 1}])
        )


@pytest.mark.parametrize(
    "payload",
    [
        _request_payload(order_type="dine_in"),
        _request_payload(order_type="dine_in", table_number=None),
        _request_payload(order_type="dine_in", table_number=0),
        _request_payload(order_type="dine_in", table_number=-1),
        _request_payload(order_type="dine_in", table_number=True),
        _request_payload(order_type="dine_in", table_number="4"),
        _request_payload(order_type="dine_in", table_number=4.0),
        _request_payload(order_type="takeaway", table_number=4),
    ],
)
def test_order_create_request_rejects_invalid_table_structure(
    payload: dict[str, object],
) -> None:
    """Enforce structural dine-in and takeaway table rules."""
    with pytest.raises(ValidationError):
        OrderCreateRequest.model_validate(payload)


@pytest.mark.parametrize(
    ("location", "field_name", "value"),
    [
        ("request", "id", str(uuid4())),
        ("request", "public_order_number", PUBLIC_NUMBER),
        ("request", "order_access_token", "token"),
        ("request", "status", "created"),
        ("request", "table_id", str(uuid4())),
        ("request", "currency", "NOK"),
        ("request", "subtotal_amount", 100),
        ("request", "total_amount", 100),
        ("request", "payment", {}),
        ("item", "price_amount", 100),
        ("item", "name", "Client Name"),
        ("item", "cost_amount", 50),
        ("item", "tax_rate", 2500),
        ("item", "discount", 10),
        ("item", "line_total_amount", 100),
    ],
)
def test_order_create_request_rejects_untrusted_extra_fields(
    location: str,
    field_name: str,
    value: object,
) -> None:
    """Prevent clients from supplying identifiers, snapshots, or money."""
    payload = _request_payload()
    if location == "request":
        payload[field_name] = value
    else:
        items = list(payload["items"])
        items[0] = {**items[0], field_name: value}
        payload["items"] = items
    with pytest.raises(ValidationError):
        OrderCreateRequest.model_validate(payload)


def test_order_create_item_response_has_exact_public_fields() -> None:
    """Expose only the approved item snapshot fields."""
    response = _item_response()
    assert set(response.model_dump()) == {
        "menu_item_id",
        "name",
        "quantity",
        "unit_price_amount",
        "line_total_amount",
    }


@pytest.mark.parametrize(
    "values",
    [
        {"name": "   "},
        {"quantity": "2"},
        {"unit_price_amount": 0},
        {"line_total_amount": 0},
        {"position": 0},
        {"cost_amount": 50},
    ],
)
def test_order_create_item_response_is_strict_and_forbids_extras(
    values: dict[str, object],
) -> None:
    """Reject invalid or internal item response values."""
    with pytest.raises(ValidationError):
        _item_response(**values)


def test_order_create_response_has_exact_public_fields() -> None:
    """Return the raw token once without internal persistence fields."""
    response = _create_response()
    assert set(response.model_dump()) == {
        "public_order_number",
        "order_access_token",
        "status",
        "order_type",
        "table_number",
        "currency",
        "items",
        "subtotal_amount",
        "total_amount",
    }


@pytest.mark.parametrize(
    "values",
    [
        {"public_order_number": "invalid"},
        {"order_access_token": ""},
        {"currency": "nok"},
        {"subtotal_amount": "200"},
        {"total_amount": 0},
        {"id": uuid4()},
        {"order_access_token_hash": "a" * 64},
        {"payment_summary": None},
    ],
)
def test_order_create_response_rejects_invalid_or_internal_fields(
    values: dict[str, object],
) -> None:
    """Enforce the strict creation response boundary."""
    with pytest.raises(ValidationError):
        _create_response(**values)


def test_order_status_response_has_exact_public_fields_without_token() -> None:
    """Exclude credentials, internal identifiers, and payment information."""
    response = _status_response()
    fields = set(response.model_dump())
    assert fields == {
        "public_order_number",
        "status",
        "order_type",
        "table_number",
        "currency",
        "items",
        "subtotal_amount",
        "total_amount",
        "created_at",
        "updated_at",
    }
    assert {
        "id",
        "order_access_token",
        "order_access_token_hash",
        "payment_summary",
    }.isdisjoint(fields)


@pytest.mark.parametrize(
    "values",
    [
        {"created_at": datetime(2026, 8, 7, 12, 0)},
        {"updated_at": "2026-08-07T12:00:00Z"},
        {"order_access_token": "token"},
        {"id": uuid4()},
        {"payment_summary": None},
    ],
)
def test_order_status_response_requires_aware_objects_and_forbids_extras(
    values: dict[str, object],
) -> None:
    """Require detached typed data and reject non-public fields."""
    with pytest.raises(ValidationError):
        _status_response(**values)
