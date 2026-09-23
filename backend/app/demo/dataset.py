"""Immutable records and canonical serialization for portfolio seed data."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, fields, is_dataclass
from datetime import UTC, date, datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

ORDER_STATUSES = frozenset(
    {"created", "accepted", "preparing", "ready", "completed", "cancelled"}
)
PAYMENT_STATUSES = frozenset({"pending", "succeeded", "failed", "expired"})
ORDER_TYPES = frozenset({"dine_in", "takeaway"})
_PUBLIC_ORDER_NUMBER_RE = re.compile(r"^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

type CountItems = tuple[tuple[str, int], ...]


class PortfolioDatasetError(ValueError):
    """Report an invalid in-memory portfolio dataset record or seed plan."""


def _require_non_blank(name: str, value: str) -> None:
    if not value.strip():
        raise PortfolioDatasetError(f"{name} must not be blank")


def _require_utc(name: str, value: datetime) -> None:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise PortfolioDatasetError(f"{name} must be timezone-aware UTC")


def _canonical_timestamp(value: datetime) -> str:
    _require_utc("canonical datetime", value)
    return (
        value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    )


def _canonical_value(value: object) -> object:
    if isinstance(value, datetime):
        return _canonical_timestamp(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: _canonical_value(getattr(value, field.name))
            for field in fields(value)
        }
    if isinstance(value, tuple):
        return [_canonical_value(item) for item in value]
    if value is None or isinstance(value, (bool, int, str)):
        return value
    raise PortfolioDatasetError(
        f"Unsupported canonical value type: {type(value).__qualname__}"
    )


def _validate_count_items(name: str, counts: CountItems) -> None:
    keys: list[str] = []
    for key, count in counts:
        _require_non_blank(f"{name} key", key)
        if count < 0:
            raise PortfolioDatasetError(f"{name} counts must be nonnegative")
        keys.append(key)
    if len(keys) != len(set(keys)):
        raise PortfolioDatasetError(f"{name} keys must be unique")
    if tuple(sorted(counts)) != counts:
        raise PortfolioDatasetError(f"{name} must be sorted by key")


@dataclass(frozen=True, slots=True)
class PortfolioSeedMetadata:
    """Describe the identity and bounded local-calendar window of a seed plan."""

    seed_version: str
    rng_seed: int
    timezone: str
    reference_end_utc: datetime
    window_start_utc: datetime
    reference_end_local_date: date
    window_start_local_date: date
    completed_local_days: int
    expected_order_count: int
    category_count: int
    menu_item_count: int

    def __post_init__(self) -> None:
        _require_non_blank("seed_version", self.seed_version)
        if self.timezone != "Europe/Oslo":
            raise PortfolioDatasetError("timezone must be Europe/Oslo")
        _require_utc("reference_end_utc", self.reference_end_utc)
        _require_utc("window_start_utc", self.window_start_utc)
        if self.window_start_utc >= self.reference_end_utc:
            raise PortfolioDatasetError(
                "window_start_utc must precede reference_end_utc"
            )
        if self.completed_local_days <= 0:
            raise PortfolioDatasetError("completed_local_days must be positive")
        local_days = (self.reference_end_local_date - self.window_start_local_date).days
        if local_days != self.completed_local_days:
            raise PortfolioDatasetError(
                "local date bounds must match completed_local_days"
            )
        if self.expected_order_count <= 0:
            raise PortfolioDatasetError("expected_order_count must be positive")
        if self.category_count <= 0 or self.menu_item_count <= 0:
            raise PortfolioDatasetError("catalog counts must be positive")


@dataclass(frozen=True, slots=True)
class RestaurantTableSeedRow:
    """Represent one persistable restaurant-table seed row."""

    id: UUID
    number: int
    is_active: bool
    created_at: datetime
    updated_at: datetime

    def __post_init__(self) -> None:
        if self.number <= 0:
            raise PortfolioDatasetError("table number must be positive")
        _require_utc("table created_at", self.created_at)
        _require_utc("table updated_at", self.updated_at)
        if self.updated_at < self.created_at:
            raise PortfolioDatasetError("table updated_at must not precede created_at")


@dataclass(frozen=True, slots=True)
class OrderSeedRow:
    """Represent one persistable portfolio Order row without guest capability."""

    id: UUID
    public_order_number: str
    order_access_token_hash: str
    customer_user_id: UUID | None
    data_origin: str
    order_type: str
    table_id: UUID | None
    table_number_snapshot: int | None
    status: str
    currency: str
    subtotal_amount: int
    total_amount: int
    created_at: datetime
    updated_at: datetime

    def __post_init__(self) -> None:
        if _PUBLIC_ORDER_NUMBER_RE.fullmatch(self.public_order_number) is None:
            raise PortfolioDatasetError("public_order_number has an invalid format")
        if _SHA256_RE.fullmatch(self.order_access_token_hash) is None:
            raise PortfolioDatasetError(
                "order_access_token_hash must be lowercase SHA-256"
            )
        if self.customer_user_id is not None:
            raise PortfolioDatasetError("portfolio orders must not identify a customer")
        if self.data_origin != "portfolio_seed":
            raise PortfolioDatasetError("data_origin must be portfolio_seed")
        if self.order_type not in ORDER_TYPES:
            raise PortfolioDatasetError("order_type is not supported")
        if self.order_type == "dine_in":
            if self.table_id is None or self.table_number_snapshot is None:
                raise PortfolioDatasetError("dine-in orders require a table snapshot")
            if self.table_number_snapshot <= 0:
                raise PortfolioDatasetError("table_number_snapshot must be positive")
        elif self.table_id is not None or self.table_number_snapshot is not None:
            raise PortfolioDatasetError("takeaway orders must not reference a table")
        if self.status not in ORDER_STATUSES:
            raise PortfolioDatasetError("order status is not supported")
        if self.currency != "NOK":
            raise PortfolioDatasetError("portfolio order currency must be NOK")
        if self.subtotal_amount <= 0 or self.total_amount <= 0:
            raise PortfolioDatasetError("order money totals must be positive")
        if self.total_amount != self.subtotal_amount:
            raise PortfolioDatasetError("total_amount must equal subtotal_amount")
        _require_utc("order created_at", self.created_at)
        _require_utc("order updated_at", self.updated_at)
        if self.updated_at < self.created_at:
            raise PortfolioDatasetError("order updated_at must not precede created_at")


@dataclass(frozen=True, slots=True)
class OrderItemSeedRow:
    """Represent one immutable product and money snapshot for an Order."""

    id: UUID
    order_id: UUID
    menu_item_id: UUID
    position: int
    category_name_snapshot: str
    name_snapshot: str
    quantity: int
    unit_price_amount: int
    unit_cost_amount: int | None
    tax_rate_bps_snapshot: int | None
    discount_amount_snapshot: int
    line_total_amount: int
    currency: str

    def __post_init__(self) -> None:
        if self.position < 0:
            raise PortfolioDatasetError("item position must be nonnegative")
        _require_non_blank("category_name_snapshot", self.category_name_snapshot)
        _require_non_blank("name_snapshot", self.name_snapshot)
        if not 1 <= self.quantity <= 3:
            raise PortfolioDatasetError("item quantity must be between 1 and 3")
        if self.unit_price_amount <= 0:
            raise PortfolioDatasetError("unit_price_amount must be positive")
        if self.unit_cost_amount is not None and self.unit_cost_amount < 0:
            raise PortfolioDatasetError("unit_cost_amount must be nonnegative")
        if self.tax_rate_bps_snapshot is not None and not (
            0 <= self.tax_rate_bps_snapshot <= 10_000
        ):
            raise PortfolioDatasetError("tax_rate_bps_snapshot is outside its range")
        if self.discount_amount_snapshot != 0:
            raise PortfolioDatasetError("portfolio item discounts must be zero")
        if self.line_total_amount != self.unit_price_amount * self.quantity:
            raise PortfolioDatasetError(
                "line_total_amount must equal price times quantity"
            )
        if self.currency != "NOK":
            raise PortfolioDatasetError("portfolio item currency must be NOK")


@dataclass(frozen=True, slots=True)
class OrderStatusHistorySeedRow:
    """Represent one ordered fulfilment-status transition."""

    id: UUID
    order_id: UUID
    sequence: int
    previous_status: str | None
    new_status: str
    changed_at: datetime

    def __post_init__(self) -> None:
        if self.sequence < 0:
            raise PortfolioDatasetError("history sequence must be nonnegative")
        if self.new_status not in ORDER_STATUSES:
            raise PortfolioDatasetError("new_status is not supported")
        if self.sequence == 0:
            if self.previous_status is not None or self.new_status != "created":
                raise PortfolioDatasetError(
                    "the initial history row must create the order"
                )
        elif self.previous_status not in ORDER_STATUSES:
            raise PortfolioDatasetError(
                "non-initial history rows require a supported previous_status"
            )
        _require_utc("history changed_at", self.changed_at)


@dataclass(frozen=True, slots=True)
class PaymentSeedRow:
    """Represent one provider-neutral demo Payment row."""

    id: UUID
    order_id: UUID
    status: str
    amount: int
    currency: str
    request_idempotency_key: UUID
    provider: str
    provider_idempotency_key: str
    provider_session_id: str | None
    provider_checkout_url: str | None
    provider_checkout_expires_at: datetime | None
    succeeded_at: datetime | None
    created_at: datetime
    updated_at: datetime

    def __post_init__(self) -> None:
        if self.status not in PAYMENT_STATUSES:
            raise PortfolioDatasetError("payment status is not supported")
        if self.amount <= 0:
            raise PortfolioDatasetError("payment amount must be positive")
        if self.currency != "NOK":
            raise PortfolioDatasetError("portfolio payment currency must be NOK")
        if self.provider != "demo":
            raise PortfolioDatasetError("portfolio payment provider must be demo")
        _require_non_blank("provider_idempotency_key", self.provider_idempotency_key)
        if len(self.provider_idempotency_key) > 64:
            raise PortfolioDatasetError(
                "provider_idempotency_key must be at most 64 characters"
            )
        checkout_fields = (
            self.provider_session_id,
            self.provider_checkout_url,
            self.provider_checkout_expires_at,
        )
        if any(field is not None for field in checkout_fields):
            raise PortfolioDatasetError("demo payments must not expose checkout fields")
        if (self.status == "succeeded") != (self.succeeded_at is not None):
            raise PortfolioDatasetError(
                "succeeded_at must be present only for succeeded payments"
            )
        _require_utc("payment created_at", self.created_at)
        _require_utc("payment updated_at", self.updated_at)
        if self.succeeded_at is not None:
            _require_utc("payment succeeded_at", self.succeeded_at)
            if self.succeeded_at < self.created_at:
                raise PortfolioDatasetError(
                    "payment succeeded_at must not precede created_at"
                )
        if self.updated_at < self.created_at:
            raise PortfolioDatasetError(
                "payment updated_at must not precede created_at"
            )


@dataclass(frozen=True, slots=True)
class PortfolioSeedSummary:
    """Expose deterministic aggregate counts for a complete seed plan."""

    table_count: int
    order_count: int
    order_item_count: int
    status_history_count: int
    payment_count: int
    local_date_count: int
    category_count: int
    menu_item_count: int
    order_type_counts: CountItems
    order_status_counts: CountItems
    payment_status_counts: CountItems

    def __post_init__(self) -> None:
        scalar_counts = (
            self.table_count,
            self.order_count,
            self.order_item_count,
            self.status_history_count,
            self.payment_count,
            self.local_date_count,
            self.category_count,
            self.menu_item_count,
        )
        if any(count < 0 for count in scalar_counts):
            raise PortfolioDatasetError("summary counts must be nonnegative")
        _validate_count_items("order_type_counts", self.order_type_counts)
        _validate_count_items("order_status_counts", self.order_status_counts)
        _validate_count_items("payment_status_counts", self.payment_status_counts)


@dataclass(frozen=True, slots=True)
class PortfolioSeedPlan:
    """Own a complete immutable portfolio dataset and its canonical digest."""

    metadata: PortfolioSeedMetadata
    tables: tuple[RestaurantTableSeedRow, ...]
    orders: tuple[OrderSeedRow, ...]
    order_items: tuple[OrderItemSeedRow, ...]
    order_status_history: tuple[OrderStatusHistorySeedRow, ...]
    payments: tuple[PaymentSeedRow, ...]

    def __post_init__(self) -> None:
        collections = (
            ("tables", self.tables),
            ("orders", self.orders),
            ("order_items", self.order_items),
            ("order_status_history", self.order_status_history),
            ("payments", self.payments),
        )
        for name, rows in collections:
            if not isinstance(rows, tuple):
                raise PortfolioDatasetError(f"{name} must be an immutable tuple")
            row_ids = tuple(row.id for row in rows)
            if len(row_ids) != len(set(row_ids)):
                raise PortfolioDatasetError(f"{name} contains duplicate row IDs")
        if len(self.orders) != self.metadata.expected_order_count:
            raise PortfolioDatasetError("order count does not match metadata")

        table_ids = {table.id for table in self.tables}
        table_numbers = {table.number for table in self.tables}
        order_ids = {order.id for order in self.orders}
        for order in self.orders:
            if order.table_id is not None and order.table_id not in table_ids:
                raise PortfolioDatasetError("an order references an unknown table")
            if (
                order.table_number_snapshot is not None
                and order.table_number_snapshot not in table_numbers
            ):
                raise PortfolioDatasetError(
                    "an order snapshots an unknown table number"
                )
        for item in self.order_items:
            if item.order_id not in order_ids:
                raise PortfolioDatasetError("an item references an unknown order")
        for history in self.order_status_history:
            if history.order_id not in order_ids:
                raise PortfolioDatasetError("history references an unknown order")
        for payment in self.payments:
            if payment.order_id not in order_ids:
                raise PortfolioDatasetError("a payment references an unknown order")

    @property
    def summary(self) -> PortfolioSeedSummary:
        """Return stable aggregate counts for the plan."""
        return PortfolioSeedSummary(
            table_count=len(self.tables),
            order_count=len(self.orders),
            order_item_count=len(self.order_items),
            status_history_count=len(self.order_status_history),
            payment_count=len(self.payments),
            local_date_count=len(
                {
                    order.created_at.astimezone(ZoneInfo(self.metadata.timezone)).date()
                    for order in self.orders
                }
            ),
            category_count=self.metadata.category_count,
            menu_item_count=self.metadata.menu_item_count,
            order_type_counts=_count_values(order.order_type for order in self.orders),
            order_status_counts=_count_values(order.status for order in self.orders),
            payment_status_counts=_count_values(
                payment.status for payment in self.payments
            ),
        )

    def canonical_json(self) -> str:
        """Return the complete plan as deterministic compact JSON."""
        return json.dumps(
            _canonical_value(self),
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )

    def canonical_bytes(self) -> bytes:
        """Return the canonical JSON representation encoded as UTF-8."""
        return self.canonical_json().encode("utf-8")

    @property
    def canonical_sha256(self) -> str:
        """Return the lowercase SHA-256 digest of the canonical plan bytes."""
        return hashlib.sha256(self.canonical_bytes()).hexdigest()

    @property
    def canonical_size_bytes(self) -> int:
        """Return the byte size of the canonical plan representation."""
        return len(self.canonical_bytes())


def _count_values(values: Iterable[str]) -> CountItems:
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return tuple(sorted(counts.items()))


__all__ = [
    "OrderItemSeedRow",
    "OrderSeedRow",
    "OrderStatusHistorySeedRow",
    "PaymentSeedRow",
    "PortfolioDatasetError",
    "PortfolioSeedMetadata",
    "PortfolioSeedPlan",
    "PortfolioSeedSummary",
    "RestaurantTableSeedRow",
]
