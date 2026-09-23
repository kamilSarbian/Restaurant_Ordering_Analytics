"""Contract tests for the pure deterministic portfolio dataset generator."""

from __future__ import annotations

import ast
import json
import os
import random
import re
import subprocess
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import FrozenInstanceError, fields, is_dataclass
from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from pathlib import Path
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest

from app import catalog
from app.catalog import CATEGORY_SEEDS, MENU_ITEM_SEEDS
from app.demo import (
    DEFAULT_RNG_SEED,
    DEFAULT_SEED_VERSION,
    PortfolioDatasetError,
    generate_portfolio_dataset,
)
from app.demo.dataset import PortfolioSeedPlan
from app.orders.access import verify_order_access_token
from app.orders.statuses import ALLOWED_ORDER_STATUS_TRANSITIONS, OrderStatus

OSLO = ZoneInfo("Europe/Oslo")
FIXED_REFERENCE_END = datetime(2026, 9, 23, tzinfo=OSLO)
PUBLIC_ORDER_NUMBER_PATTERN = re.compile(
    r"^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$"
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

EXPECTED_ORDER_TYPE_COUNTS = {"dine_in": 320, "takeaway": 180}
EXPECTED_ORDER_STATUS_COUNTS = {
    "accepted": 3,
    "cancelled": 48,
    "completed": 440,
    "created": 3,
    "preparing": 3,
    "ready": 3,
}
EXPECTED_PAYMENT_STATUS_COUNTS = {
    "expired": 17,
    "failed": 17,
    "pending": 1,
    "succeeded": 449,
}
EXPECTED_STATUS_HISTORY_COUNT = 2_326
EXPECTED_PAYMENT_COUNT = 484
EXPECTED_ORDER_ITEM_COUNT = 1_211
EXPECTED_DINNER_COUNT = 350
EXPECTED_LUNCH_COUNT = 150

EXPECTED_CANONICAL_SHA256 = (
    "716200cc31feebe72a1dc237175e5c5780075bffa055a7086430dedb823bb9f3"
)
EXPECTED_CANONICAL_SIZE_BYTES = 1_456_799


@pytest.fixture(scope="module")
def fixed_plan() -> PortfolioSeedPlan:
    """Generate the fixed-reference plan once for read-only contract tests."""
    return generate_portfolio_dataset(FIXED_REFERENCE_END)


def _counts(value: Iterable[tuple[str, int]]) -> dict[str, int]:
    """Normalize an immutable count collection for concise assertions."""
    return dict(value)


def _rows_by_order(rows: tuple[Any, ...]) -> dict[UUID, list[Any]]:
    """Group plan rows by their owning Order while preserving plan order."""
    grouped: dict[UUID, list[Any]] = defaultdict(list)
    for row in rows:
        grouped[row.order_id].append(row)
    return grouped


def _walk_json(value: object) -> list[object]:
    """Flatten one JSON-compatible value for canonical-format checks."""
    values: list[object] = [value]
    if isinstance(value, dict):
        for key, child in value.items():
            values.extend((key, *_walk_json(child)))
    elif isinstance(value, list):
        for child in value:
            values.extend(_walk_json(child))
    return values


def _qualified_name(node: ast.AST) -> str:
    """Return a dotted name for simple Name and Attribute AST nodes."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = _qualified_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def test_seed_data_preserves_the_neutral_catalog_import_api() -> None:
    """Keep existing seed consumers on the exact neutral catalog objects."""
    from app.seed import data as seed_data

    compatibility_names = (
        *catalog.__all__,
        "CATEGORY_STARTERS_ID",
        "CATEGORY_MAIN_COURSES_ID",
        "CATEGORY_BURGERS_ID",
        "CATEGORY_DESSERTS_ID",
        "CATEGORY_DRINKS_ID",
    )

    assert seed_data.__all__ == catalog.__all__
    assert all(
        getattr(seed_data, name) is getattr(catalog, name)
        for name in compatibility_names
    )


def test_fixed_metadata_summary_and_frozen_records(
    fixed_plan: PortfolioSeedPlan,
) -> None:
    """Freeze seed identity, cardinalities, summaries, and immutable records."""
    metadata = fixed_plan.metadata
    summary = fixed_plan.summary

    assert DEFAULT_SEED_VERSION == "portfolio-60d-v1"
    assert DEFAULT_RNG_SEED == 220_060_500
    assert metadata.seed_version == DEFAULT_SEED_VERSION
    assert metadata.rng_seed == DEFAULT_RNG_SEED
    assert metadata.timezone == "Europe/Oslo"
    assert metadata.reference_end_utc == datetime(2026, 9, 22, 22, tzinfo=UTC)
    assert metadata.window_start_utc == datetime(2026, 7, 24, 22, tzinfo=UTC)
    assert metadata.reference_end_local_date == date(2026, 9, 23)
    assert metadata.window_start_local_date == date(2026, 7, 25)
    assert metadata.completed_local_days == 60
    assert metadata.expected_order_count == 500
    assert metadata.category_count == 5
    assert metadata.menu_item_count == 15

    assert summary.table_count == len(fixed_plan.tables) == 12
    assert summary.order_count == len(fixed_plan.orders) == 500
    assert (
        summary.order_item_count
        == len(fixed_plan.order_items)
        == EXPECTED_ORDER_ITEM_COUNT
    )
    assert summary.status_history_count == len(fixed_plan.order_status_history)
    assert summary.status_history_count == EXPECTED_STATUS_HISTORY_COUNT
    assert summary.payment_count == len(fixed_plan.payments) == EXPECTED_PAYMENT_COUNT
    assert summary.local_date_count == 60
    assert summary.category_count == 5
    assert summary.menu_item_count == 15
    assert _counts(summary.order_type_counts) == EXPECTED_ORDER_TYPE_COUNTS
    assert _counts(summary.order_status_counts) == EXPECTED_ORDER_STATUS_COUNTS
    assert _counts(summary.payment_status_counts) == EXPECTED_PAYMENT_STATUS_COUNTS

    representative_records = (
        fixed_plan,
        metadata,
        summary,
        fixed_plan.tables[0],
        fixed_plan.orders[0],
        fixed_plan.order_items[0],
        fixed_plan.order_status_history[0],
        fixed_plan.payments[0],
    )
    assert all(is_dataclass(record) for record in representative_records)
    assert all(hasattr(type(record), "__slots__") for record in representative_records)
    assert all(
        isinstance(collection, tuple)
        for collection in (
            fixed_plan.tables,
            fixed_plan.orders,
            fixed_plan.order_items,
            fixed_plan.order_status_history,
            fixed_plan.payments,
        )
    )
    for record in representative_records:
        first_field = fields(record)[0]
        with pytest.raises(FrozenInstanceError):
            setattr(record, first_field.name, getattr(record, first_field.name))


@pytest.mark.parametrize(
    "reference_end",
    [
        datetime(2026, 9, 23),
        datetime(2026, 9, 23, 12, tzinfo=OSLO),
        datetime(2026, 9, 23, 0, 0, 1, tzinfo=OSLO),
        datetime(2026, 9, 23, 0, 0, 0, 1, tzinfo=OSLO),
        datetime(2026, 9, 23, tzinfo=UTC),
    ],
    ids=["naive", "midday", "seconds", "microseconds", "not-oslo-midnight"],
)
def test_reference_end_rejects_noncanonical_boundaries(
    reference_end: datetime,
) -> None:
    """Reject naive values and instants that are not exact Oslo midnight."""
    with pytest.raises(PortfolioDatasetError):
        generate_portfolio_dataset(reference_end)


@pytest.mark.parametrize(
    "seed_version",
    ["", " ", " leading", "trailing ", None],
    ids=["empty", "whitespace", "leading-space", "trailing-space", "non-string"],
)
def test_seed_version_rejects_invalid_values(seed_version: Any) -> None:
    """Reject blank, unnormalized, and non-string seed identities."""
    with pytest.raises(PortfolioDatasetError):
        generate_portfolio_dataset(FIXED_REFERENCE_END, seed_version=seed_version)


@pytest.mark.parametrize(
    "rng_seed",
    [True, False, 1.5, "220060500", None],
    ids=["true", "false", "float", "string", "none"],
)
def test_rng_seed_rejects_non_integer_values(rng_seed: Any) -> None:
    """Reject booleans and every non-integer RNG seed."""
    with pytest.raises(PortfolioDatasetError):
        generate_portfolio_dataset(FIXED_REFERENCE_END, rng_seed=rng_seed)


def test_reference_end_rejects_a_window_before_datetime_min() -> None:
    """Translate date underflow into the public dataset-domain error."""
    with pytest.raises(PortfolioDatasetError):
        generate_portfolio_dataset(datetime(1, 1, 1, tzinfo=OSLO))


def test_reference_end_normalizes_equivalent_aware_instants() -> None:
    """Canonicalize equivalent Oslo and UTC representations identically."""
    local_plan = generate_portfolio_dataset(FIXED_REFERENCE_END)
    utc_plan = generate_portfolio_dataset(FIXED_REFERENCE_END.astimezone(UTC))

    assert utc_plan == local_plan
    assert utc_plan.canonical_bytes() == local_plan.canonical_bytes()
    assert utc_plan.canonical_sha256 == local_plan.canonical_sha256


@pytest.mark.parametrize(
    ("reference_end", "expected_utc_hours"),
    [
        (datetime(2026, 4, 15, tzinfo=OSLO), 1_439),
        (datetime(2026, 11, 15, tzinfo=OSLO), 1_441),
    ],
    ids=["spring-forward", "autumn-back"],
)
def test_window_uses_sixty_local_calendar_days_across_dst(
    reference_end: datetime,
    expected_utc_hours: int,
) -> None:
    """Keep 60 Oslo dates while UTC duration reflects each DST transition."""
    plan = generate_portfolio_dataset(reference_end)
    metadata = plan.metadata
    created_dates = {order.created_at.astimezone(OSLO).date() for order in plan.orders}

    assert metadata.reference_end_local_date - metadata.window_start_local_date == (
        timedelta(days=60)
    )
    assert (metadata.reference_end_utc - metadata.window_start_utc) == timedelta(
        hours=expected_utc_hours
    )
    assert len(created_dates) == 60


def test_tables_orders_and_demand_shape(fixed_plan: PortfolioSeedPlan) -> None:
    """Validate table semantics, provenance, local coverage, and demand shape."""
    table_by_id = {table.id: table for table in fixed_plan.tables}
    assert len(table_by_id) == 12
    assert {table.number for table in fixed_plan.tables} == set(range(1, 13))
    assert all(table.is_active for table in fixed_plan.tables)

    local_dates: Counter[date] = Counter()
    dinner_count = 0
    for order in fixed_plan.orders:
        local_created_at = order.created_at.astimezone(OSLO)
        local_dates[local_created_at.date()] += 1
        dinner_count += local_created_at.hour >= 16

        assert 11 <= local_created_at.hour < 22
        assert order.customer_user_id is None
        assert order.data_origin == "portfolio_seed"
        assert order.currency == "NOK"
        assert order.subtotal_amount == order.total_amount > 0
        if order.order_type == "dine_in":
            assert order.table_id in table_by_id
            assert order.table_number_snapshot == table_by_id[order.table_id].number
        else:
            assert order.order_type == "takeaway"
            assert order.table_id is None
            assert order.table_number_snapshot is None

    expected_dates = {
        fixed_plan.metadata.window_start_local_date + timedelta(days=offset)
        for offset in range(60)
    }
    assert set(local_dates) == expected_dates
    assert all(count >= 1 for count in local_dates.values())
    assert fixed_plan.summary.local_date_count == len(local_dates) == 60
    assert dinner_count == EXPECTED_DINNER_COUNT
    assert len(fixed_plan.orders) - dinner_count == EXPECTED_LUNCH_COUNT

    friday_saturday = [
        count
        for local_date, count in local_dates.items()
        if local_date.weekday() in {4, 5}
    ]
    monday_tuesday = [
        count
        for local_date, count in local_dates.items()
        if local_date.weekday() in {0, 1}
    ]
    assert sum(friday_saturday) * len(monday_tuesday) > (
        sum(monday_tuesday) * len(friday_saturday)
    )
    assert Counter(order.order_type for order in fixed_plan.orders) == (
        EXPECTED_ORDER_TYPE_COUNTS
    )
    assert EXPECTED_ORDER_TYPE_COUNTS["dine_in"] / 500 == pytest.approx(0.64)


def test_deterministic_identifiers_and_private_access_hashes(
    fixed_plan: PortfolioSeedPlan,
) -> None:
    """Require unique stable UUIDs, public numbers, and hash-only capabilities."""
    primary_ids = [
        *(row.id for row in fixed_plan.tables),
        *(row.id for row in fixed_plan.orders),
        *(row.id for row in fixed_plan.order_items),
        *(row.id for row in fixed_plan.order_status_history),
        *(row.id for row in fixed_plan.payments),
    ]
    request_ids = [payment.request_idempotency_key for payment in fixed_plan.payments]
    public_numbers = [order.public_order_number for order in fixed_plan.orders]
    access_hashes = [order.order_access_token_hash for order in fixed_plan.orders]

    assert all(isinstance(value, UUID) for value in (*primary_ids, *request_ids))
    assert len(primary_ids) == len(set(primary_ids))
    assert len(request_ids) == len(set(request_ids)) == EXPECTED_PAYMENT_COUNT
    assert len(public_numbers) == len(set(public_numbers)) == 500
    assert all(PUBLIC_ORDER_NUMBER_PATTERN.fullmatch(value) for value in public_numbers)
    assert len(access_hashes) == len(set(access_hashes)) == 500
    assert all(SHA256_PATTERN.fullmatch(value) for value in access_hashes)

    enumerable_material = "|".join(
        (
            "restaurant-ordering-analytics",
            fixed_plan.metadata.seed_version,
            str(fixed_plan.metadata.rng_seed),
            fixed_plan.metadata.reference_end_utc.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "order-access-capability",
            "0",
        )
    )
    assert not verify_order_access_token(enumerable_material, access_hashes[0])
    serialized = json.loads(fixed_plan.canonical_json())
    serialized_keys = {
        value for value in _walk_json(serialized) if isinstance(value, str)
    }
    assert "order_access_token_hash" in serialized_keys
    assert "order_access_token" not in serialized_keys
    assert "raw_access_token" not in serialized_keys
    assert "access_token" not in serialized_keys


def test_order_items_reuse_the_canonical_available_menu(
    fixed_plan: PortfolioSeedPlan,
) -> None:
    """Preserve canonical menu snapshots, unique lines, quantities, and totals."""
    categories = {category.id: category for category in CATEGORY_SEEDS}
    available_items = {
        item.id: item
        for item in MENU_ITEM_SEEDS
        if item.is_active and item.is_available
    }
    items_by_order = _rows_by_order(fixed_plan.order_items)
    represented_item_ids: set[UUID] = set()
    represented_categories: set[str] = set()

    assert len(available_items) == 14
    assert set(items_by_order) == {order.id for order in fixed_plan.orders}
    for order in fixed_plan.orders:
        rows = items_by_order[order.id]
        assert 1 <= len(rows) <= 4
        assert [row.position for row in rows] == list(range(len(rows)))
        assert len({row.menu_item_id for row in rows}) == len(rows)
        assert all(1 <= row.quantity <= 3 for row in rows)

        for row in rows:
            canonical_item = available_items[row.menu_item_id]
            canonical_category = categories[canonical_item.category_id]
            represented_item_ids.add(row.menu_item_id)
            represented_categories.add(row.category_name_snapshot)
            assert row.category_name_snapshot == canonical_category.name
            assert row.name_snapshot == canonical_item.name
            assert row.unit_price_amount == canonical_item.price_amount
            assert row.unit_cost_amount == canonical_item.cost_amount
            assert row.tax_rate_bps_snapshot is None
            assert row.discount_amount_snapshot == 0
            assert row.currency == canonical_item.currency == order.currency == "NOK"
            assert row.line_total_amount == row.unit_price_amount * row.quantity

        expected_total = sum(row.line_total_amount for row in rows)
        assert order.subtotal_amount == order.total_amount == expected_total

    assert represented_item_ids == set(available_items)
    assert represented_categories == {category.name for category in CATEGORY_SEEDS}
    assert all(row.name_snapshot != "Warm Apple Cake" for row in fixed_plan.order_items)


def test_status_histories_are_legal_complete_and_causal(
    fixed_plan: PortfolioSeedPlan,
) -> None:
    """Enforce exact legal paths, aligned snapshots, and recent nonterminals."""
    expected_paths = {
        "created": ["created"],
        "accepted": ["created", "accepted"],
        "preparing": ["created", "accepted", "preparing"],
        "ready": ["created", "accepted", "preparing", "ready"],
        "completed": ["created", "accepted", "preparing", "ready", "completed"],
        "cancelled": ["created", "cancelled"],
    }
    histories_by_order = _rows_by_order(fixed_plan.order_status_history)
    recent_dates = {
        fixed_plan.metadata.reference_end_local_date - timedelta(days=1),
        fixed_plan.metadata.reference_end_local_date - timedelta(days=2),
    }

    assert Counter(order.status for order in fixed_plan.orders) == (
        EXPECTED_ORDER_STATUS_COUNTS
    )
    assert set(histories_by_order) == {order.id for order in fixed_plan.orders}
    for order in fixed_plan.orders:
        rows = histories_by_order[order.id]
        assert [row.sequence for row in rows] == list(range(len(rows)))
        assert [row.new_status for row in rows] == expected_paths[order.status]
        assert rows[0].previous_status is None
        assert rows[0].changed_at == order.created_at
        assert all(
            current.previous_status == previous.new_status
            for previous, current in pairwise(rows)
        )
        assert all(
            (
                OrderStatus(previous.new_status),
                OrderStatus(current.new_status),
            )
            in ALLOWED_ORDER_STATUS_TRANSITIONS
            for previous, current in pairwise(rows)
        )
        assert all(
            previous.changed_at < current.changed_at
            for previous, current in pairwise(rows)
        )
        assert order.updated_at == rows[-1].changed_at
        assert order.status == rows[-1].new_status
        if order.status in {"created", "accepted", "preparing", "ready"}:
            assert order.created_at.astimezone(OSLO).date() in recent_dates


def test_payments_are_provider_neutral_and_financially_coherent(
    fixed_plan: PortfolioSeedPlan,
) -> None:
    """Validate exact demo outcomes, nullable provider fields, and causal times."""
    order_by_id = {order.id: order for order in fixed_plan.orders}
    histories_by_order = _rows_by_order(fixed_plan.order_status_history)
    payments_by_order = _rows_by_order(fixed_plan.payments)
    latest_local_date = fixed_plan.metadata.reference_end_local_date - timedelta(days=1)

    assert Counter(payment.status for payment in fixed_plan.payments) == (
        EXPECTED_PAYMENT_STATUS_COUNTS
    )
    assert all(len(rows) == 1 for rows in payments_by_order.values())
    assert len(
        {payment.provider_idempotency_key for payment in fixed_plan.payments}
    ) == (EXPECTED_PAYMENT_COUNT)

    for payment in fixed_plan.payments:
        order = order_by_id[payment.order_id]
        assert payment.provider == "demo"
        assert payment.amount == order.total_amount
        assert payment.currency == order.currency == "NOK"
        assert payment.provider_idempotency_key.strip()
        assert len(payment.provider_idempotency_key) <= 64
        assert payment.provider_session_id is None
        assert payment.provider_checkout_url is None
        assert payment.provider_checkout_expires_at is None
        assert order.created_at <= payment.created_at <= payment.updated_at

        if payment.status == "succeeded":
            accepted_at = histories_by_order[order.id][1].changed_at
            assert order.status in {"accepted", "preparing", "ready", "completed"}
            assert payment.succeeded_at is not None
            assert order.created_at < payment.succeeded_at < accepted_at
            assert payment.created_at <= payment.succeeded_at
        else:
            assert payment.succeeded_at is None
        if payment.status in {"failed", "expired"}:
            assert order.created_at < payment.created_at < payment.updated_at
        if payment.status == "pending":
            assert order.created_at.astimezone(OSLO).date() == latest_local_date

    for order in fixed_plan.orders:
        payments = payments_by_order.get(order.id, [])
        if order.status in {"accepted", "preparing", "ready", "completed"}:
            assert [payment.status for payment in payments] == ["succeeded"]
        elif order.status == "cancelled":
            assert not ({"pending", "succeeded"} & {p.status for p in payments})
            if payments:
                cancellation_at = histories_by_order[order.id][-1].changed_at
                assert payments[0].updated_at < cancellation_at
        else:
            assert order.status == "created"
            assert all(
                payment.status in {"pending", "failed", "expired"}
                for payment in payments
            )


def test_every_persistable_timestamp_is_aware_utc_and_inside_window(
    fixed_plan: PortfolioSeedPlan,
) -> None:
    """Keep every generated persistence timestamp as a bounded UTC instant."""
    start = fixed_plan.metadata.window_start_utc
    end = fixed_plan.metadata.reference_end_utc
    timestamps = [
        *(
            value
            for row in fixed_plan.tables
            for value in (row.created_at, row.updated_at)
        ),
        *(
            value
            for row in fixed_plan.orders
            for value in (row.created_at, row.updated_at)
        ),
        *(row.changed_at for row in fixed_plan.order_status_history),
        *(
            value
            for row in fixed_plan.payments
            for value in (row.created_at, row.updated_at, row.succeeded_at)
            if value is not None
        ),
    ]

    assert timestamps
    assert all(value.tzinfo is not None for value in timestamps)
    assert all(value.utcoffset() == timedelta(0) for value in timestamps)
    assert all(start <= value < end for value in timestamps)


def test_canonical_serialization_is_compact_sorted_and_secret_free(
    fixed_plan: PortfolioSeedPlan,
) -> None:
    """Freeze canonical JSON encoding, digest, size, UUIDs, and UTC timestamps."""
    canonical_json = fixed_plan.canonical_json()
    canonical_bytes = fixed_plan.canonical_bytes()
    payload = json.loads(canonical_json)

    assert canonical_bytes == canonical_json.encode("utf-8")
    assert canonical_json == json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    assert fixed_plan.canonical_size_bytes == len(canonical_bytes)
    assert fixed_plan.canonical_size_bytes < 10 * 1024 * 1024
    assert fixed_plan.canonical_sha256 == EXPECTED_CANONICAL_SHA256
    assert fixed_plan.canonical_size_bytes == EXPECTED_CANONICAL_SIZE_BYTES
    assert SHA256_PATTERN.fullmatch(fixed_plan.canonical_sha256)

    lowered = canonical_json.lower()
    assert "stripe" not in lowered
    assert "stripe_events" not in payload
    assert "http://" not in lowered
    assert "https://" not in lowered
    for forbidden_key in ("email", "phone", "customer_name", "address"):
        assert f'"{forbidden_key}"' not in lowered

    def assert_canonical_scalars(value: object, *, key: str | None = None) -> None:
        if isinstance(value, dict):
            for child_key, child in value.items():
                assert_canonical_scalars(child, key=child_key)
        elif isinstance(value, list):
            for child in value:
                assert_canonical_scalars(child, key=key)
        elif isinstance(value, str) and key is not None:
            if key == "id" or key.endswith("_id") or key == "request_idempotency_key":
                assert UUID_PATTERN.fullmatch(value)
            if key.endswith("_at") or key in {"reference_end_utc", "window_start_utc"}:
                assert value.endswith("Z")
                assert "+00:00" not in value

    assert_canonical_scalars(payload)


def test_generation_is_repeatable_and_isolates_global_random_state(
    fixed_plan: PortfolioSeedPlan,
) -> None:
    """Ignore ambient RNG seeding and leave the module-global state untouched."""
    original_state = random.getstate()
    try:
        random.seed(1)
        first = generate_portfolio_dataset(FIXED_REFERENCE_END)
        state_after_first = random.getstate()
        random.seed(999_999)
        second = generate_portfolio_dataset(FIXED_REFERENCE_END)
        state_after_second = random.getstate()
    finally:
        random.setstate(original_state)

    assert state_after_first != state_after_second
    assert first == second == fixed_plan
    assert first.canonical_bytes() == second.canonical_bytes()

    state_before_generation = random.getstate()
    generate_portfolio_dataset(FIXED_REFERENCE_END)
    assert random.getstate() == state_before_generation


def test_controlled_inputs_change_the_canonical_dataset(
    fixed_plan: PortfolioSeedPlan,
) -> None:
    """Bind identities and random business shape to every controlled input."""
    next_day = generate_portfolio_dataset(FIXED_REFERENCE_END + timedelta(days=1))
    next_version = generate_portfolio_dataset(
        FIXED_REFERENCE_END,
        seed_version="portfolio-60d-v2",
    )
    next_rng = generate_portfolio_dataset(
        FIXED_REFERENCE_END,
        rng_seed=DEFAULT_RNG_SEED + 1,
    )

    assert next_version == generate_portfolio_dataset(
        FIXED_REFERENCE_END,
        seed_version="portfolio-60d-v2",
    )
    assert next_rng == generate_portfolio_dataset(
        FIXED_REFERENCE_END,
        rng_seed=DEFAULT_RNG_SEED + 1,
    )
    assert (
        len(
            {
                fixed_plan.canonical_sha256,
                next_day.canonical_sha256,
                next_version.canonical_sha256,
                next_rng.canonical_sha256,
            }
        )
        == 4
    )
    assert fixed_plan.orders[0].id != next_version.orders[0].id
    fixed_business_shape = [
        (
            order.created_at,
            order.order_type,
            order.table_number_snapshot,
            order.status,
            order.total_amount,
        )
        for order in fixed_plan.orders
    ]
    next_rng_business_shape = [
        (
            order.created_at,
            order.order_type,
            order.table_number_snapshot,
            order.status,
            order.total_amount,
        )
        for order in next_rng.orders
    ]
    assert next_rng_business_shape != fixed_business_shape


def test_generation_is_pure_and_stable_in_fresh_processes(
    fixed_plan: PortfolioSeedPlan,
) -> None:
    """Generate without integration imports, output, DB access, or RNG mutation."""
    backend_root = Path(__file__).resolve().parents[1]
    script = """
import random
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from app.demo import generate_portfolio_dataset

random_state = random.getstate()
plan = generate_portfolio_dataset(
    datetime(2026, 9, 23, tzinfo=ZoneInfo("Europe/Oslo"))
)
assert random.getstate() == random_state
assert plan.canonical_sha256 == (
    "716200cc31feebe72a1dc237175e5c5780075bffa055a7086430dedb823bb9f3"
)
assert plan.canonical_size_bytes == 1_456_799

forbidden = (
    "app.seed",
    "sqlalchemy",
    "app.database",
    "app.main",
    "app.categories.models",
    "app.menu.models",
    "app.orders.models",
    "app.payments.models",
)
assert not any(
    module == prefix or module.startswith(prefix + ".")
    for module in sys.modules
    for prefix in forbidden
)
"""
    assert fixed_plan.canonical_sha256 == EXPECTED_CANONICAL_SHA256
    assert fixed_plan.canonical_size_bytes == EXPECTED_CANONICAL_SIZE_BYTES

    for hash_seed in ("1", "987654321"):
        child_environment = {
            key: value
            for key, value in os.environ.items()
            if key.upper()
            not in {"DATABASE_URL", "TEST_DATABASE_URL", "POSTGRES_PASSWORD"}
        }
        child_environment.update(
            {
                "DATABASE_URL": "poison-value-that-must-not-be-read",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONHASHSEED": hash_seed,
                "PYTHONIOENCODING": "utf-8",
            }
        )
        completed = subprocess.run(
            [sys.executable, "-c", script],
            cwd=backend_root,
            env=child_environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        assert completed.returncode == 0, completed.stderr
        assert completed.stdout == ""
        assert completed.stderr == ""


def test_generation_does_not_register_orm_metadata() -> None:
    """Leave pre-imported SQLAlchemy metadata unchanged during generation."""
    backend_root = Path(__file__).resolve().parents[1]
    child_environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper() not in {"DATABASE_URL", "TEST_DATABASE_URL", "POSTGRES_PASSWORD"}
    }
    child_environment["DATABASE_URL"] = "poison-value-that-must-not-be-read"
    child_environment["PYTHONDONTWRITEBYTECODE"] = "1"
    child_environment["PYTHONIOENCODING"] = "utf-8"
    metadata_code = """
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from app.database.base import Base

tables_before = tuple(Base.metadata.tables)
modules_before = set(sys.modules)

from app.demo import generate_portfolio_dataset

generate_portfolio_dataset(
    datetime(2026, 9, 23, tzinfo=ZoneInfo("Europe/Oslo"))
)

assert tuple(Base.metadata.tables) == tables_before
new_modules = set(sys.modules) - modules_before
forbidden_models = (
    "app.categories.models",
    "app.menu.models",
    "app.orders.models",
    "app.payments.models",
)
assert not any(
    module == prefix or module.startswith(prefix + ".")
    for module in new_modules
    for prefix in forbidden_models
)
"""
    completed = subprocess.run(
        [sys.executable, "-c", metadata_code],
        cwd=backend_root,
        env=child_environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == ""
    assert completed.stderr == ""


def test_demo_imports_have_no_integration_or_generation_side_effects() -> None:
    """Import every demo module without ORM, app startup, output, or generation."""
    backend_root = Path(__file__).resolve().parents[1]
    child_environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper() not in {"DATABASE_URL", "TEST_DATABASE_URL", "POSTGRES_PASSWORD"}
    }
    child_environment["DATABASE_URL"] = "poison-value-that-must-not-be-read"
    child_environment["PYTHONDONTWRITEBYTECODE"] = "1"
    child_environment["PYTHONIOENCODING"] = "utf-8"
    import_code = """
import sys

import app.demo
import app.demo.dataset as dataset
import app.demo.generator as generator

forbidden = (
    "sqlalchemy",
    "app.database",
    "app.main",
    "app.seed",
    "app.categories.models",
    "app.menu.models",
    "app.orders.models",
    "app.payments.models",
)
assert not any(
    module == prefix or module.startswith(prefix + ".")
    for module in sys.modules
    for prefix in forbidden
)
assert not any(
    isinstance(value, dataset.PortfolioSeedPlan)
    for module in (app.demo, dataset, generator)
    for value in vars(module).values()
)
"""
    completed = subprocess.run(
        [sys.executable, "-c", import_code],
        cwd=backend_root,
        env=child_environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == ""
    assert completed.stderr == ""


def test_demo_sources_exclude_ambient_and_integration_dependencies() -> None:
    """Statically reject clocks, ambient RNG, DB, environment, I/O, and network."""
    demo_root = Path(__file__).resolve().parents[1] / "app" / "demo"
    source_paths = sorted(demo_root.glob("*.py"))
    assert [path.name for path in source_paths] == [
        "__init__.py",
        "dataset.py",
        "generator.py",
    ]

    forbidden_imports = {
        "fastapi",
        "httpx",
        "os",
        "requests",
        "secrets",
        "socket",
        "sqlalchemy",
        "app.database",
        "app.main",
        "app.seed",
    }
    forbidden_calls = {
        "datetime.now",
        "datetime.today",
        "datetime.utcnow",
        "date.today",
        "time.monotonic",
        "time.perf_counter",
        "time.time",
        "open",
        "os.getenv",
        "random.choice",
        "random.randint",
        "random.random",
        "random.seed",
        "random.shuffle",
        "random.uniform",
        "secrets.choice",
        "secrets.token_hex",
        "secrets.token_urlsafe",
        "uuid.uuid4",
        "uuid4",
    }

    for path in source_paths:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        imported_modules: set[str] = set()
        called_names: set[str] = set()
        accessed_names: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported_modules.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module is not None:
                imported_modules.add(node.module)
            elif isinstance(node, ast.Call):
                called_names.add(_qualified_name(node.func))
            elif isinstance(node, ast.Attribute):
                accessed_names.add(_qualified_name(node))

        assert not any(
            module == prefix or module.startswith(prefix + ".")
            for module in imported_modules
            for prefix in forbidden_imports
        )
        assert not any(module.endswith(".models") for module in imported_modules)
        assert not (called_names & forbidden_calls)
        assert "os.environ" not in accessed_names
        assert not any(
            name.endswith((".write_text", ".write_bytes", ".write"))
            for name in called_names
        )
