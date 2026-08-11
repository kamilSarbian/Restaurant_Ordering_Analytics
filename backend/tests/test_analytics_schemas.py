"""Unit tests for strict administrator analytics schemas."""

from datetime import UTC, datetime, timedelta, timezone
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.analytics.schemas import (
    AnalyticsBreakdownQuery,
    AnalyticsCategoryItem,
    AnalyticsCategoryResponse,
    AnalyticsOrderTypeItem,
    AnalyticsOrderTypeResponse,
    AnalyticsOverviewCurrency,
    AnalyticsOverviewQuery,
    AnalyticsOverviewResponse,
    AnalyticsProductItem,
    AnalyticsProductResponse,
    AnalyticsRangeResponse,
)

START = datetime(2026, 1, 1, tzinfo=UTC)
END = datetime(2026, 2, 1, tzinfo=UTC)


def test_overview_query_accepts_aware_range_and_optional_currency() -> None:
    query = AnalyticsOverviewQuery(start=START, end=END, currency="NOK")

    assert query.model_dump() == {
        "start": START,
        "end": END,
        "currency": "NOK",
    }


def test_overview_query_preserves_non_utc_aware_boundaries() -> None:
    offset = timezone(timedelta(hours=2))
    start = datetime(2026, 6, 1, 12, tzinfo=offset)
    end = datetime(2026, 6, 1, 13, tzinfo=offset)

    query = AnalyticsOverviewQuery(start=start, end=end)

    assert query.start == start
    assert query.end == end
    assert query.currency is None


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"start": START},
        {"end": END},
        {"start": datetime(2026, 1, 1), "end": END},
        {"start": START, "end": datetime(2026, 2, 1)},
        {"start": END, "end": START},
        {"start": START, "end": START},
        {"start": START, "end": END, "currency": "nok"},
        {"start": START, "end": END, "currency": "NOKK"},
        {"start": START, "end": END, "currency": "NO1"},
        {"start": START, "end": END, "currency": 123},
        {"start": START, "end": END, "unexpected": True},
    ],
)
def test_overview_query_rejects_invalid_contract(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        AnalyticsOverviewQuery.model_validate(payload)


def test_range_response_requires_exact_timezone_and_aware_datetimes() -> None:
    response = AnalyticsRangeResponse(
        start=START,
        end=END,
        timezone="Europe/Oslo",
    )

    assert response.timezone == "Europe/Oslo"

    for update in (
        {"timezone": "UTC"},
        {"start": datetime(2026, 1, 1)},
        {"end": datetime(2026, 2, 1)},
        {"unexpected": True},
    ):
        payload = {
            "start": START,
            "end": END,
            "timezone": "Europe/Oslo",
            **update,
        }
        with pytest.raises(ValidationError):
            AnalyticsRangeResponse.model_validate(payload)


def test_currency_response_accepts_exact_nonnegative_integer_contract() -> None:
    response = AnalyticsOverviewCurrency(
        currency="NOK",
        collected_revenue_amount=10,
        succeeded_orders_count=2,
        average_order_value_amount=5,
    )

    assert response.model_dump() == {
        "currency": "NOK",
        "collected_revenue_amount": 10,
        "succeeded_orders_count": 2,
        "average_order_value_amount": 5,
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("currency", "nok"),
        ("currency", "NOKK"),
        ("currency", 123),
        ("collected_revenue_amount", -1),
        ("collected_revenue_amount", True),
        ("collected_revenue_amount", 1.0),
        ("succeeded_orders_count", -1),
        ("succeeded_orders_count", False),
        ("average_order_value_amount", -1),
        ("average_order_value_amount", "1"),
    ],
)
def test_currency_response_rejects_invalid_values(field: str, value: object) -> None:
    payload: dict[str, object] = {
        "currency": "NOK",
        "collected_revenue_amount": 10,
        "succeeded_orders_count": 2,
        "average_order_value_amount": 5,
    }
    payload[field] = value

    with pytest.raises(ValidationError):
        AnalyticsOverviewCurrency.model_validate(payload)


def test_overview_response_forbids_extra_fields_at_every_level() -> None:
    valid_range = {
        "start": START,
        "end": END,
        "timezone": "Europe/Oslo",
    }
    valid_currency = {
        "currency": "NOK",
        "collected_revenue_amount": 0,
        "succeeded_orders_count": 0,
        "average_order_value_amount": 0,
    }

    response = AnalyticsOverviewResponse(
        range=AnalyticsRangeResponse(**valid_range),
        currencies=[AnalyticsOverviewCurrency(**valid_currency)],
    )
    assert len(response.currencies) == 1

    invalid_payloads = [
        {"range": valid_range, "currencies": [], "unexpected": True},
        {
            "range": {**valid_range, "unexpected": True},
            "currencies": [],
        },
        {
            "range": valid_range,
            "currencies": [{**valid_currency, "unexpected": True}],
        },
    ]
    for payload in invalid_payloads:
        with pytest.raises(ValidationError):
            AnalyticsOverviewResponse.model_validate(payload)


def _range_response() -> AnalyticsRangeResponse:
    return AnalyticsRangeResponse(
        start=START,
        end=END,
        timezone="Europe/Oslo",
    )


def test_breakdown_query_reuses_range_currency_and_validates_limit() -> None:
    query = AnalyticsBreakdownQuery(start=START, end=END, currency="EUR")
    assert query.limit == 50

    assert (
        AnalyticsBreakdownQuery(
            start=START,
            end=END,
            limit=100,
        ).limit
        == 100
    )
    for limit in (0, 101):
        with pytest.raises(ValidationError):
            AnalyticsBreakdownQuery(start=START, end=END, limit=limit)


def test_product_item_and_response_have_exact_strict_contract() -> None:
    item = AnalyticsProductItem(
        menu_item_id=uuid4(),
        item_name="Historical Burger",
        currency="NOK",
        quantity_sold=2,
        sales_amount=400,
    )
    response = AnalyticsProductResponse(
        range=_range_response(),
        limit_per_currency=50,
        items=[item],
    )

    assert response.items == [item]
    assert response.limit_per_currency == 50


@pytest.mark.parametrize(
    "update",
    [
        {"item_name": ""},
        {"currency": "nok"},
        {"quantity_sold": -1},
        {"quantity_sold": True},
        {"sales_amount": -1},
        {"sales_amount": 1.0},
        {"unexpected": True},
    ],
)
def test_product_item_rejects_invalid_values(update: dict[str, object]) -> None:
    payload: dict[str, object] = {
        "menu_item_id": uuid4(),
        "item_name": "Historical Burger",
        "currency": "NOK",
        "quantity_sold": 2,
        "sales_amount": 400,
        **update,
    }
    with pytest.raises(ValidationError):
        AnalyticsProductItem.model_validate(payload)


@pytest.mark.parametrize("limit", [0, 101, True])
def test_product_response_rejects_invalid_limit(limit: object) -> None:
    with pytest.raises(ValidationError):
        AnalyticsProductResponse(
            range=_range_response(),
            limit_per_currency=limit,
            items=[],
        )


def test_category_item_and_response_have_exact_strict_contract() -> None:
    item = AnalyticsCategoryItem(
        category_name="Historical Drinks",
        currency="EUR",
        quantity_sold=3,
        sales_amount=600,
    )
    response = AnalyticsCategoryResponse(
        range=_range_response(),
        limit_per_currency=1,
        items=[item],
    )

    assert response.items == [item]


@pytest.mark.parametrize(
    "update",
    [
        {"category_name": ""},
        {"currency": "EU"},
        {"quantity_sold": -1},
        {"sales_amount": -1},
        {"unexpected": True},
    ],
)
def test_category_item_rejects_invalid_values(update: dict[str, object]) -> None:
    payload: dict[str, object] = {
        "category_name": "Historical Drinks",
        "currency": "EUR",
        "quantity_sold": 3,
        "sales_amount": 600,
        **update,
    }
    with pytest.raises(ValidationError):
        AnalyticsCategoryItem.model_validate(payload)


@pytest.mark.parametrize("limit", [0, 101])
def test_category_response_rejects_invalid_limit(limit: int) -> None:
    with pytest.raises(ValidationError):
        AnalyticsCategoryResponse(
            range=_range_response(),
            limit_per_currency=limit,
            items=[],
        )


@pytest.mark.parametrize("order_type", ["dine_in", "takeaway"])
def test_order_type_item_accepts_exact_types(order_type: str) -> None:
    item = AnalyticsOrderTypeItem(
        order_type=order_type,
        currency="NOK",
        succeeded_orders_count=0,
        collected_revenue_amount=0,
    )
    response = AnalyticsOrderTypeResponse(range=_range_response(), items=[item])

    assert response.items == [item]


@pytest.mark.parametrize(
    "update",
    [
        {"order_type": "delivery"},
        {"currency": "nok"},
        {"succeeded_orders_count": -1},
        {"succeeded_orders_count": False},
        {"collected_revenue_amount": -1},
        {"collected_revenue_amount": "1"},
        {"unexpected": True},
    ],
)
def test_order_type_item_rejects_invalid_values(update: dict[str, object]) -> None:
    payload: dict[str, object] = {
        "order_type": "takeaway",
        "currency": "NOK",
        "succeeded_orders_count": 1,
        "collected_revenue_amount": 100,
        **update,
    }
    with pytest.raises(ValidationError):
        AnalyticsOrderTypeItem.model_validate(payload)


def test_breakdown_responses_allow_empty_items_and_forbid_extra_fields() -> None:
    assert (
        AnalyticsProductResponse(
            range=_range_response(), limit_per_currency=50, items=[]
        ).items
        == []
    )
    assert (
        AnalyticsCategoryResponse(
            range=_range_response(), limit_per_currency=50, items=[]
        ).items
        == []
    )
    assert AnalyticsOrderTypeResponse(range=_range_response(), items=[]).items == []

    with pytest.raises(ValidationError):
        AnalyticsOrderTypeResponse.model_validate(
            {"range": _range_response(), "items": [], "unexpected": True}
        )


def test_product_item_requires_uuid_and_all_approved_fields() -> None:
    valid = {
        "menu_item_id": uuid4(),
        "item_name": "Snapshot",
        "currency": "NOK",
        "quantity_sold": 1,
        "sales_amount": 100,
    }
    for field in valid:
        with pytest.raises(ValidationError):
            AnalyticsProductItem.model_validate(
                {key: value for key, value in valid.items() if key != field}
            )
    with pytest.raises(ValidationError):
        AnalyticsProductItem.model_validate({**valid, "menu_item_id": "not-a-uuid"})


def test_breakdown_responses_have_no_unintended_optional_fields() -> None:
    for schema, payload in (
        (
            AnalyticsProductResponse,
            {"range": _range_response(), "limit_per_currency": 50, "items": []},
        ),
        (
            AnalyticsCategoryResponse,
            {"range": _range_response(), "limit_per_currency": 50, "items": []},
        ),
        (
            AnalyticsOrderTypeResponse,
            {"range": _range_response(), "items": []},
        ),
    ):
        for field in payload:
            with pytest.raises(ValidationError):
                schema.model_validate(
                    {key: value for key, value in payload.items() if key != field}
                )
