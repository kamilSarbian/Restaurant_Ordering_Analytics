"""Unit tests for strict administrator order response schemas."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.orders.admin_schemas import (
    AdminOrderDetail,
    AdminOrderItem,
    AdminOrderListItem,
    AdminOrderListResponse,
    AdminOrderStatusHistoryEntry,
    AdminPaymentSummary,
)
from app.orders.schemas import OrderType
from app.orders.statuses import OrderStatus
from app.payments.statuses import PaymentStatus

ORDER_ID = UUID("00000000-0000-0000-0000-000000000001")
ITEM_ID = UUID("00000000-0000-0000-0000-000000000002")
MENU_ITEM_ID = UUID("00000000-0000-0000-0000-000000000003")
PAYMENT_ID = UUID("00000000-0000-0000-0000-000000000004")
AWARE_NOW = datetime(2026, 8, 11, 12, tzinfo=UTC)


def _list_item_values() -> dict[str, object]:
    return {
        "public_order_number": "ROA-23456789ABCD",
        "status": OrderStatus.CREATED,
        "order_type": OrderType.TAKEAWAY,
        "table_number": None,
        "total_amount": 2500,
        "currency": "NOK",
        "created_at": AWARE_NOW,
        "updated_at": AWARE_NOW,
    }


def _item() -> AdminOrderItem:
    return AdminOrderItem(
        id=ITEM_ID,
        menu_item_id=MENU_ITEM_ID,
        position=0,
        category_name="Historical Category",
        name="Historical Item",
        quantity=2,
        unit_price_amount=1250,
        unit_cost_amount=700,
        tax_rate_bps=None,
        discount_amount=0,
        line_total_amount=2500,
    )


def _history() -> AdminOrderStatusHistoryEntry:
    return AdminOrderStatusHistoryEntry(
        sequence=0,
        previous_status=None,
        new_status=OrderStatus.CREATED,
        changed_at=AWARE_NOW,
    )


def _payment() -> AdminPaymentSummary:
    return AdminPaymentSummary(
        id=PAYMENT_ID,
        status=PaymentStatus.PENDING,
        amount=2500,
        currency="NOK",
        created_at=AWARE_NOW,
        updated_at=AWARE_NOW,
        checkout_expires_at=None,
    )


def test_valid_list_item_and_response_have_exact_contract() -> None:
    """Accept the exact list item and pagination envelope."""
    item = AdminOrderListItem(**_list_item_values())
    response = AdminOrderListResponse(items=[item], total=1, limit=50, offset=0)

    assert response.items == [item]
    assert set(item.model_dump()) == {
        "public_order_number",
        "status",
        "order_type",
        "table_number",
        "total_amount",
        "currency",
        "created_at",
        "updated_at",
    }
    assert "order_id" not in AdminOrderListItem.model_fields


@pytest.mark.parametrize("schema", [AdminOrderListItem, AdminPaymentSummary])
def test_schemas_forbid_extra_fields(schema: type) -> None:
    """Reject data outside each declared administrator response boundary."""
    values = (
        _list_item_values() if schema is AdminOrderListItem else _payment().model_dump()
    )
    with pytest.raises(ValidationError):
        schema.model_validate({**values, "unexpected": "value"})


def test_response_schemas_require_aware_datetimes() -> None:
    """Reject naive timestamps at the administrator response boundary."""
    with pytest.raises(ValidationError):
        AdminOrderListItem(
            **{
                **_list_item_values(),
                "created_at": datetime(2026, 8, 11, 12),
            }
        )


def test_valid_detail_includes_internal_order_and_payment_identifiers() -> None:
    """Allow internal identifiers only in the trusted detail contract."""
    detail = AdminOrderDetail(
        order_id=ORDER_ID,
        public_order_number="ROA-23456789ABCD",
        status=OrderStatus.CREATED,
        order_type=OrderType.TAKEAWAY,
        table_number=None,
        currency="NOK",
        subtotal_amount=2500,
        total_amount=2500,
        created_at=AWARE_NOW,
        updated_at=AWARE_NOW,
        items=[_item()],
        status_history=[_history()],
        payments=[_payment()],
    )

    assert detail.order_id == ORDER_ID
    assert detail.payments[0].id == PAYMENT_ID
    assert detail.items[0].category_name == "Historical Category"
    assert detail.status_history[0].previous_status is None
    assert detail.payments[0].checkout_expires_at is None


def test_sensitive_and_stripe_event_fields_are_absent() -> None:
    """Keep credentials and provider internals outside every admin read schema."""
    all_fields = set().union(
        AdminOrderListItem.model_fields,
        AdminOrderDetail.model_fields,
        AdminOrderItem.model_fields,
        AdminOrderStatusHistoryEntry.model_fields,
        AdminPaymentSummary.model_fields,
    )
    assert {
        "order_access_token",
        "order_access_token_hash",
        "stripe_checkout_session_id",
        "stripe_checkout_url",
        "stripe_idempotency_key",
        "request_idempotency_key",
        "stripe_event_id",
        "stripe_events",
    }.isdisjoint(all_fields)


@pytest.mark.parametrize(
    "values",
    [
        {"total": -1, "limit": 50, "offset": 0},
        {"total": 0, "limit": 0, "offset": 0},
        {"total": 0, "limit": 101, "offset": 0},
        {"total": 0, "limit": 50, "offset": -1},
    ],
)
def test_pagination_constraints(values: dict[str, int]) -> None:
    """Reject pagination values outside the frozen contract."""
    with pytest.raises(ValidationError):
        AdminOrderListResponse(items=[], **values)
