"""Read-only aggregation service for administrator analytics."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.selectable import CTE

from app.analytics.schemas import (
    AnalyticsCategoryItem,
    AnalyticsCategoryResponse,
    AnalyticsOrderTypeItem,
    AnalyticsOrderTypeResponse,
    AnalyticsOverviewCurrency,
    AnalyticsOverviewResponse,
    AnalyticsProductItem,
    AnalyticsProductResponse,
    AnalyticsRangeResponse,
)
from app.orders.models import Order, OrderItem
from app.payments.models import Payment, StripeEvent
from app.payments.statuses import PaymentStatus
from app.payments.stripe_webhook import StripeWebhookEventType
from app.payments.webhook import WebhookProcessingOutcome

ANALYTICS_TIMEZONE_NAME = "Europe/Oslo"
ANALYTICS_TIMEZONE = ZoneInfo(ANALYTICS_TIMEZONE_NAME)
SUCCESS_EVENT_TYPES = (
    StripeWebhookEventType.COMPLETED.value,
    StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED.value,
)


def get_analytics_overview(
    session: Session,
    *,
    start: datetime,
    end: datetime,
    currency: str | None,
) -> AnalyticsOverviewResponse:
    """Calculate read-only payment overview KPIs for a half-open time range.

    Args:
        session: Request-scoped database session.
        start: Inclusive aware reporting boundary.
        end: Exclusive aware reporting boundary.
        currency: Optional exact ISO-style currency code.

    Returns:
        Per-currency revenue, succeeded-order count, and rounded average value.
    """
    start_utc = start.astimezone(UTC)
    end_utc = end.astimezone(UTC)
    qualified_payments = _qualified_succeeded_payments(
        start_utc=start_utc,
        end_utc=end_utc,
        currency=currency,
    )

    overview_statement = (
        select(
            qualified_payments.c.currency,
            func.sum(qualified_payments.c.amount).label("collected_revenue_amount"),
            func.count(func.distinct(qualified_payments.c.order_id)).label(
                "succeeded_orders_count"
            ),
        )
        .group_by(qualified_payments.c.currency)
        .order_by(qualified_payments.c.currency.asc())
    )
    rows = session.execute(overview_statement).all()

    currencies = [
        _currency_response(
            currency_code=row.currency,
            collected_revenue_amount=int(row.collected_revenue_amount),
            succeeded_orders_count=int(row.succeeded_orders_count),
        )
        for row in rows
    ]
    if currency is not None and not currencies:
        currencies.append(
            _currency_response(
                currency_code=currency,
                collected_revenue_amount=0,
                succeeded_orders_count=0,
            )
        )

    return AnalyticsOverviewResponse(
        range=_range_response(start=start, end=end),
        currencies=currencies,
    )


def get_product_analytics(
    session: Session,
    *,
    start: datetime,
    end: datetime,
    currency: str | None,
    limit: int,
) -> AnalyticsProductResponse:
    """Aggregate historical product snapshots with a per-currency limit."""
    qualified = _qualified_succeeded_payments(
        start_utc=start.astimezone(UTC),
        end_utc=end.astimezone(UTC),
        currency=currency,
    )
    product_groups_statement = (
        select(
            OrderItem.menu_item_id.label("menu_item_id"),
            OrderItem.name_snapshot.label("item_name"),
            Order.currency.label("currency"),
            func.sum(OrderItem.quantity).label("quantity_sold"),
            func.sum(OrderItem.line_total_amount).label("sales_amount"),
        )
        .join(Order, Order.id == OrderItem.order_id)
        .join(qualified, qualified.c.order_id == Order.id)
        .group_by(OrderItem.menu_item_id, OrderItem.name_snapshot, Order.currency)
    )
    if currency is not None:
        product_groups_statement = product_groups_statement.where(
            Order.currency == currency
        )
    aggregated = product_groups_statement.cte("product_sales_groups")
    ranked = select(
        *aggregated.c,
        func.row_number()
        .over(
            partition_by=aggregated.c.currency,
            order_by=(
                aggregated.c.sales_amount.desc(),
                aggregated.c.quantity_sold.desc(),
                aggregated.c.menu_item_id.asc(),
                aggregated.c.item_name.asc(),
            ),
        )
        .label("currency_rank"),
    ).cte("ranked_product_sales")
    rows = session.execute(
        select(ranked)
        .where(ranked.c.currency_rank <= limit)
        .order_by(
            ranked.c.currency.asc(),
            ranked.c.sales_amount.desc(),
            ranked.c.quantity_sold.desc(),
            ranked.c.menu_item_id.asc(),
            ranked.c.item_name.asc(),
        )
    ).all()
    return AnalyticsProductResponse(
        range=_range_response(start=start, end=end),
        limit_per_currency=limit,
        items=[
            AnalyticsProductItem(
                menu_item_id=row.menu_item_id,
                item_name=row.item_name,
                currency=row.currency,
                quantity_sold=int(row.quantity_sold),
                sales_amount=int(row.sales_amount),
            )
            for row in rows
        ],
    )


def get_category_analytics(
    session: Session,
    *,
    start: datetime,
    end: datetime,
    currency: str | None,
    limit: int,
) -> AnalyticsCategoryResponse:
    """Aggregate historical category snapshots with a per-currency limit."""
    qualified = _qualified_succeeded_payments(
        start_utc=start.astimezone(UTC),
        end_utc=end.astimezone(UTC),
        currency=currency,
    )
    category_groups_statement = (
        select(
            OrderItem.category_name_snapshot.label("category_name"),
            Order.currency.label("currency"),
            func.sum(OrderItem.quantity).label("quantity_sold"),
            func.sum(OrderItem.line_total_amount).label("sales_amount"),
        )
        .join(Order, Order.id == OrderItem.order_id)
        .join(qualified, qualified.c.order_id == Order.id)
        .group_by(OrderItem.category_name_snapshot, Order.currency)
    )
    if currency is not None:
        category_groups_statement = category_groups_statement.where(
            Order.currency == currency
        )
    aggregated = category_groups_statement.cte("category_sales_groups")
    ranked = select(
        *aggregated.c,
        func.row_number()
        .over(
            partition_by=aggregated.c.currency,
            order_by=(
                aggregated.c.sales_amount.desc(),
                aggregated.c.quantity_sold.desc(),
                aggregated.c.category_name.asc(),
            ),
        )
        .label("currency_rank"),
    ).cte("ranked_category_sales")
    rows = session.execute(
        select(ranked)
        .where(ranked.c.currency_rank <= limit)
        .order_by(
            ranked.c.currency.asc(),
            ranked.c.sales_amount.desc(),
            ranked.c.quantity_sold.desc(),
            ranked.c.category_name.asc(),
        )
    ).all()
    return AnalyticsCategoryResponse(
        range=_range_response(start=start, end=end),
        limit_per_currency=limit,
        items=[
            AnalyticsCategoryItem(
                category_name=row.category_name,
                currency=row.currency,
                quantity_sold=int(row.quantity_sold),
                sales_amount=int(row.sales_amount),
            )
            for row in rows
        ],
    )


def get_order_type_analytics(
    session: Session,
    *,
    start: datetime,
    end: datetime,
    currency: str | None,
) -> AnalyticsOrderTypeResponse:
    """Aggregate collected payment KPIs by order type and currency."""
    qualified = _qualified_succeeded_payments(
        start_utc=start.astimezone(UTC),
        end_utc=end.astimezone(UTC),
        currency=currency,
    )
    rows = session.execute(
        select(
            Order.order_type,
            qualified.c.currency,
            func.count(func.distinct(qualified.c.order_id)).label(
                "succeeded_orders_count"
            ),
            func.sum(qualified.c.amount).label("collected_revenue_amount"),
        )
        .join(qualified, qualified.c.order_id == Order.id)
        .group_by(Order.order_type, qualified.c.currency)
        .order_by(qualified.c.currency.asc(), Order.order_type.asc())
    ).all()
    return AnalyticsOrderTypeResponse(
        range=_range_response(start=start, end=end),
        items=[
            AnalyticsOrderTypeItem(
                order_type=row.order_type,
                currency=row.currency,
                succeeded_orders_count=int(row.succeeded_orders_count),
                collected_revenue_amount=int(row.collected_revenue_amount),
            )
            for row in rows
        ],
    )


def _qualified_succeeded_payments(
    *,
    start_utc: datetime,
    end_utc: datetime,
    currency: str | None,
) -> CTE:
    """Build the reusable one-row-per-payment financial source."""

    authoritative_receipts = (
        select(
            StripeEvent.payment_id.label("payment_id"),
            func.min(StripeEvent.stripe_created_at).label("success_at"),
        )
        .where(
            StripeEvent.payment_id.is_not(None),
            StripeEvent.processing_result
            == WebhookProcessingOutcome.TRANSITIONED.value,
            StripeEvent.event_type.in_(SUCCESS_EVENT_TYPES),
        )
        .group_by(StripeEvent.payment_id)
        .cte("authoritative_success_receipts")
    )

    qualified_payments_statement = (
        select(
            Payment.order_id.label("order_id"),
            Payment.amount.label("amount"),
            Payment.currency.label("currency"),
        )
        .join(
            authoritative_receipts,
            authoritative_receipts.c.payment_id == Payment.id,
        )
        .where(
            Payment.status == PaymentStatus.SUCCEEDED.value,
            authoritative_receipts.c.success_at >= start_utc,
            authoritative_receipts.c.success_at < end_utc,
        )
    )
    if currency is not None:
        qualified_payments_statement = qualified_payments_statement.where(
            Payment.currency == currency
        )
    qualified_payments = qualified_payments_statement.cte(
        "qualified_succeeded_payments"
    )
    return qualified_payments


def _currency_response(
    *,
    currency_code: str,
    collected_revenue_amount: int,
    succeeded_orders_count: int,
) -> AnalyticsOverviewCurrency:
    average_order_value_amount = 0
    if succeeded_orders_count:
        average_order_value_amount = int(
            (
                Decimal(collected_revenue_amount) / Decimal(succeeded_orders_count)
            ).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        )
    return AnalyticsOverviewCurrency(
        currency=currency_code,
        collected_revenue_amount=collected_revenue_amount,
        succeeded_orders_count=succeeded_orders_count,
        average_order_value_amount=average_order_value_amount,
    )


def _range_response(*, start: datetime, end: datetime) -> AnalyticsRangeResponse:
    return AnalyticsRangeResponse(
        start=start.astimezone(ANALYTICS_TIMEZONE),
        end=end.astimezone(ANALYTICS_TIMEZONE),
        timezone=ANALYTICS_TIMEZONE_NAME,
    )
