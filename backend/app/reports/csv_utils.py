"""Shared deterministic CSV encoding and safety helpers."""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

OSLO_TIME_ZONE = ZoneInfo("Europe/Oslo")
FORMULA_PREFIXES = ("=", "+", "-", "@")
LEADING_CONTROL_PREFIXES = ("\t", "\r", "\n")


def sanitize_csv_text(value: object | None) -> object:
    """Neutralize spreadsheet formulas while preserving non-text values.

    Args:
        value: Cell value to sanitize.

    Returns:
        An empty string for ``None``, text with NUL characters removed and a
        safety prefix when dangerous, or the unchanged non-text value.
    """
    if value is None:
        return ""
    if not isinstance(value, str):
        return value

    safe_value = value.replace("\x00", "")
    meaningful = safe_value.lstrip()
    if safe_value.startswith(LEADING_CONTROL_PREFIXES) or (
        meaningful and meaningful.startswith(FORMULA_PREFIXES)
    ):
        return f"'{safe_value}"
    return safe_value


def build_csv_bytes(
    headers: Sequence[str],
    rows: Iterable[Sequence[object | None]],
) -> bytes:
    """Encode rows as UTF-8-SIG CSV using the fixed export dialect.

    Args:
        headers: Ordered column names.
        rows: Ordered cell values for each exported row.

    Returns:
        Complete buffered CSV content with exactly one UTF-8 BOM.
    """
    buffer = io.StringIO(newline="")
    writer = csv.writer(
        buffer,
        delimiter=",",
        quotechar='"',
        quoting=csv.QUOTE_MINIMAL,
        lineterminator="\r\n",
        doublequote=True,
    )
    writer.writerow([sanitize_csv_text(header) for header in headers])
    for row in rows:
        writer.writerow([sanitize_csv_text(value) for value in row])
    return buffer.getvalue().encode("utf-8-sig")


def format_oslo_datetime(value: datetime) -> str:
    """Format an aware instant as an ISO 8601 Europe/Oslo timestamp.

    Args:
        value: A timezone-aware timestamp.

    Returns:
        ISO 8601 timestamp carrying the applicable Oslo UTC offset.

    Raises:
        ValueError: If ``value`` is timezone-naive.
    """
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("CSV timestamps must be timezone-aware")
    return value.astimezone(OSLO_TIME_ZONE).isoformat()


def build_orders_export_filename(
    *,
    start: datetime,
    end: datetime,
    currency: str | None,
    order_status: str | None,
    order_type: str | None,
) -> str:
    """Build the deterministic orders export filename.

    Args:
        start: Inclusive range start.
        end: Exclusive range end.
        currency: Optional exact currency filter.
        order_status: Optional exact order status filter.
        order_type: Optional exact order type filter.

    Returns:
        A separator-safe filename ending in ``.csv``.

    Raises:
        ValueError: If either range boundary is timezone-naive.
    """
    if start.tzinfo is None or start.utcoffset() is None:
        raise ValueError("Export start must be timezone-aware")
    if end.tzinfo is None or end.utcoffset() is None:
        raise ValueError("Export end must be timezone-aware")

    start_token = start.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    end_token = end.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    return (
        f"orders_{start_token}_{end_token}_{currency or 'all'}_"
        f"{order_status or 'all'}_{order_type or 'all'}.csv"
    )
