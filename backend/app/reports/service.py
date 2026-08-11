"""Database-backed administrator CSV export services."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analytics.service import (
    build_product_sales_statement,
    build_qualified_succeeded_payments,
)
from app.orders.models import Order
from app.reports.csv_utils import (
    build_csv_bytes,
    build_orders_export_filename,
    format_oslo_datetime,
)
from app.reports.schemas import AnalyticsCsvExportQuery, OrdersCsvExportQuery

ORDERS_CSV_HEADERS = (
    "range_start",
    "range_end",
    "timezone",
    "public_order_number",
    "created_at",
    "updated_at",
    "order_status",
    "order_type",
    "table_number",
    "currency",
    "subtotal_amount",
    "total_amount",
)
PRODUCT_SALES_CSV_HEADERS = (
    "range_start",
    "range_end",
    "timezone",
    "menu_item_id",
    "item_name",
    "currency",
    "quantity_sold",
    "sales_amount",
)
PAYMENTS_CSV_HEADERS = (
    "range_start",
    "range_end",
    "timezone",
    "public_order_number",
    "payment_status",
    "success_at",
    "currency",
    "amount",
)


@dataclass(frozen=True)
class CsvExportResult:
    """Carry buffered CSV content and its deterministic download filename."""

    content: bytes
    filename: str


def export_orders_csv(
    session: Session,
    query: OrdersCsvExportQuery,
) -> CsvExportResult:
    """Export orders created within the requested half-open UTC range.

    Args:
        session: Open database session used for one read-only report query.
        query: Validated export range and optional exact filters.

    Returns:
        Buffered CSV bytes and deterministic filename.
    """
    range_start_utc = query.start.astimezone(UTC)
    range_end_utc = query.end.astimezone(UTC)
    statement = select(
        Order.public_order_number,
        Order.created_at,
        Order.updated_at,
        Order.status,
        Order.order_type,
        Order.table_number_snapshot,
        Order.currency,
        Order.subtotal_amount,
        Order.total_amount,
    ).where(
        Order.created_at >= range_start_utc,
        Order.created_at < range_end_utc,
    )
    if query.currency is not None:
        statement = statement.where(Order.currency == query.currency)
    if query.status is not None:
        statement = statement.where(Order.status == query.status.value)
    if query.order_type is not None:
        statement = statement.where(Order.order_type == query.order_type.value)
    statement = statement.order_by(Order.created_at.asc(), Order.id.asc())

    result_rows = session.execute(statement).all()
    range_start = format_oslo_datetime(query.start)
    range_end = format_oslo_datetime(query.end)
    rows = (
        (
            range_start,
            range_end,
            "Europe/Oslo",
            row.public_order_number,
            format_oslo_datetime(row.created_at),
            format_oslo_datetime(row.updated_at),
            row.status,
            row.order_type,
            row.table_number_snapshot,
            row.currency,
            row.subtotal_amount,
            row.total_amount,
        )
        for row in result_rows
    )
    filename = build_orders_export_filename(
        start=query.start,
        end=query.end,
        currency=query.currency,
        order_status=query.status.value if query.status is not None else None,
        order_type=query.order_type.value if query.order_type is not None else None,
    )
    return CsvExportResult(
        content=build_csv_bytes(ORDERS_CSV_HEADERS, rows),
        filename=filename,
    )


def export_product_sales_csv(
    session: Session,
    query: AnalyticsCsvExportQuery,
) -> CsvExportResult:
    """Export every qualified historical product-sales group.

    Args:
        session: Open database session used for one read-only report query.
        query: Validated payment-success range and optional currency filter.

    Returns:
        Buffered CSV bytes and deterministic filename.
    """
    result_rows = session.execute(
        build_product_sales_statement(
            start_utc=query.start.astimezone(UTC),
            end_utc=query.end.astimezone(UTC),
            currency=query.currency,
            limit_per_currency=None,
        )
    ).all()
    range_start = format_oslo_datetime(query.start)
    range_end = format_oslo_datetime(query.end)
    rows = (
        (
            range_start,
            range_end,
            "Europe/Oslo",
            str(row.menu_item_id),
            row.item_name,
            row.currency,
            int(row.quantity_sold),
            int(row.sales_amount),
        )
        for row in result_rows
    )
    return CsvExportResult(
        content=build_csv_bytes(PRODUCT_SALES_CSV_HEADERS, rows),
        filename=_build_analytics_export_filename(
            prefix="product-sales",
            start=query.start,
            end=query.end,
            currency=query.currency,
        ),
    )


def export_payments_csv(
    session: Session,
    query: AnalyticsCsvExportQuery,
) -> CsvExportResult:
    """Export one row per qualified succeeded Payment.

    Args:
        session: Open database session used for one read-only report query.
        query: Validated payment-success range and optional currency filter.

    Returns:
        Buffered CSV bytes and deterministic filename.
    """
    qualified = build_qualified_succeeded_payments(
        start_utc=query.start.astimezone(UTC),
        end_utc=query.end.astimezone(UTC),
        currency=query.currency,
    )
    statement = (
        select(
            Order.public_order_number,
            qualified.c.payment_status,
            qualified.c.success_at,
            qualified.c.currency,
            qualified.c.amount,
        )
        .join(qualified, qualified.c.order_id == Order.id)
        .order_by(
            qualified.c.success_at.asc(),
            Order.public_order_number.asc(),
            qualified.c.payment_id.asc(),
        )
    )
    result_rows = session.execute(statement).all()
    range_start = format_oslo_datetime(query.start)
    range_end = format_oslo_datetime(query.end)
    rows = (
        (
            range_start,
            range_end,
            "Europe/Oslo",
            row.public_order_number,
            row.payment_status,
            format_oslo_datetime(row.success_at),
            row.currency,
            row.amount,
        )
        for row in result_rows
    )
    return CsvExportResult(
        content=build_csv_bytes(PAYMENTS_CSV_HEADERS, rows),
        filename=_build_analytics_export_filename(
            prefix="payments",
            start=query.start,
            end=query.end,
            currency=query.currency,
        ),
    )


def _build_analytics_export_filename(
    *,
    prefix: str,
    start: datetime,
    end: datetime,
    currency: str | None,
) -> str:
    start_token = start.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    end_token = end.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}_{start_token}_{end_token}_{currency or 'all'}.csv"
