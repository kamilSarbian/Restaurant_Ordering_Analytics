"""Atomic persistence for an explicitly generated portfolio seed plan."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import asdict, dataclass
from typing import Literal

from sqlalchemy import and_, insert, or_, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.catalog import CATEGORY_SEEDS, MENU_ITEM_SEEDS
from app.demo.dataset import PortfolioDatasetError, PortfolioSeedPlan
from app.demo.generator import (
    DEFAULT_RNG_SEED,
    DEFAULT_SEED_VERSION,
    OSLO_TIMEZONE,
    generate_portfolio_dataset,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.payments.models import Payment
from app.restaurant_tables.models import RestaurantTable
from app.seed.runner import (
    SeedConflictError,
    SeedResult,
    require_exact_menu_data,
    seed_menu_data_in_session,
)

EXPECTED_SCHEMA_REVISION = "0009_add_portfolio_demo_origin_and_payment_provider"
EXPECTED_TABLE_COUNT = 12
EXPECTED_ORDER_COUNT = 500
EXPECTED_ORDER_ITEM_COUNT = 1_211
EXPECTED_HISTORY_COUNT = 2_326
EXPECTED_PAYMENT_COUNT = 484
EXPECTED_COMPLETED_LOCAL_DAYS = 60

RowValues = dict[str, object]
PortfolioState = Literal["empty", "exact"]


class PortfolioSeedError(Exception):
    """Base class for sanitized portfolio persistence failures."""


class PortfolioSeedPlanError(PortfolioSeedError):
    """Report a plan that is unsafe or outside the approved B2 contract."""


class PortfolioSeedSchemaError(PortfolioSeedError):
    """Report a database that is not at the exact approved schema revision."""


class PortfolioSeedConflictError(PortfolioSeedError):
    """Report partial, drifted, or identity-conflicting portfolio data."""


class PortfolioSeedDatabaseError(PortfolioSeedError):
    """Report a sanitized non-integrity database operation failure."""


@dataclass(frozen=True, slots=True)
class PortfolioSeedResult:
    """Summarize one atomic portfolio persistence attempt."""

    inserted: bool
    categories_processed: int
    menu_items_processed: int
    tables_processed: int
    orders_processed: int
    order_items_processed: int
    status_history_processed: int
    payments_processed: int


@dataclass(frozen=True, slots=True)
class _PortfolioRows:
    tables: tuple[RowValues, ...]
    orders: tuple[RowValues, ...]
    order_items: tuple[RowValues, ...]
    status_history: tuple[RowValues, ...]
    payments: tuple[RowValues, ...]

    def is_empty(self) -> bool:
        return not any(
            (
                self.tables,
                self.orders,
                self.order_items,
                self.status_history,
                self.payments,
            )
        )


def seed_portfolio_data(
    session_factory: sessionmaker[Session],
    plan: PortfolioSeedPlan,
) -> PortfolioSeedResult:
    """Persist one complete plan atomically or verify an exact prior seed.

    Args:
        session_factory: Factory bound to the explicitly approved database.
        plan: Fully generated immutable B2-1 portfolio seed plan.

    Returns:
        Counts and whether this call inserted the plan or observed an exact no-op.

    Raises:
        PortfolioSeedPlanError: If the plan violates the approved contract.
        PortfolioSeedSchemaError: If the database is not at exact revision 0009.
        PortfolioSeedConflictError: If existing data is partial or differs.
        PortfolioSeedDatabaseError: If another database operation fails.
    """
    expected = _validated_expected_rows(plan)
    inserted = False
    menu_result: SeedResult
    sanitized_error: PortfolioSeedError | None = None

    try:
        with session_factory.begin() as session:
            _require_exact_schema_revision(session)
            state = _classify_portfolio_state(session, expected)
            if state == "empty":
                menu_result = seed_menu_data_in_session(session)
                _insert_expected_rows(session, expected)
                inserted = True
            else:
                menu_result = require_exact_menu_data(session)
            _require_exact_rows(session, expected)
    except PortfolioSeedError:
        raise
    except SeedConflictError:
        sanitized_error = PortfolioSeedConflictError(
            "Canonical menu data conflicts with existing database records."
        )
    except IntegrityError:
        sanitized_error = PortfolioSeedConflictError(
            "Portfolio seed conflicts with existing database records."
        )
    except SQLAlchemyError:
        sanitized_error = PortfolioSeedDatabaseError(
            "The portfolio database operation did not complete."
        )

    # Raise after leaving the raw exception handler so private database context
    # is not reachable from the public domain exception.
    if sanitized_error is not None:
        raise sanitized_error

    return PortfolioSeedResult(
        inserted=inserted,
        categories_processed=menu_result.categories_processed,
        menu_items_processed=menu_result.menu_items_processed,
        tables_processed=len(expected.tables),
        orders_processed=len(expected.orders),
        order_items_processed=len(expected.order_items),
        status_history_processed=len(expected.status_history),
        payments_processed=len(expected.payments),
    )


def _validated_expected_rows(plan: PortfolioSeedPlan) -> _PortfolioRows:
    _validate_plan(plan)
    order_items: list[RowValues] = []
    for row in plan.order_items:
        values = asdict(row)
        del values["currency"]
        order_items.append(values)
    return _PortfolioRows(
        tables=tuple(asdict(row) for row in plan.tables),
        orders=tuple(asdict(row) for row in plan.orders),
        order_items=tuple(order_items),
        status_history=tuple(asdict(row) for row in plan.order_status_history),
        payments=tuple(asdict(row) for row in plan.payments),
    )


def _validate_plan(plan: PortfolioSeedPlan) -> None:
    summary = plan.summary
    if (
        plan.metadata.seed_version != DEFAULT_SEED_VERSION
        or plan.metadata.rng_seed != DEFAULT_RNG_SEED
        or plan.metadata.timezone != OSLO_TIMEZONE
        or plan.metadata.completed_local_days != EXPECTED_COMPLETED_LOCAL_DAYS
        or plan.metadata.expected_order_count != EXPECTED_ORDER_COUNT
        or plan.metadata.category_count != len(CATEGORY_SEEDS)
        or plan.metadata.menu_item_count != len(MENU_ITEM_SEEDS)
    ):
        raise PortfolioSeedPlanError(
            "Portfolio seed metadata does not match the approved contract."
        )
    if (
        summary.table_count != EXPECTED_TABLE_COUNT
        or summary.order_count != EXPECTED_ORDER_COUNT
        or summary.order_item_count != EXPECTED_ORDER_ITEM_COUNT
        or summary.status_history_count != EXPECTED_HISTORY_COUNT
        or summary.payment_count != EXPECTED_PAYMENT_COUNT
        or summary.local_date_count != EXPECTED_COMPLETED_LOCAL_DAYS
    ):
        raise PortfolioSeedPlanError(
            "Portfolio seed row counts do not match the approved contract."
        )

    orders = {row.id: row for row in plan.orders}
    canonical_menu_ids = {row.id for row in MENU_ITEM_SEEDS}
    _require_unique("table number", (row.number for row in plan.tables))
    _require_unique(
        "public order number", (row.public_order_number for row in plan.orders)
    )
    _require_unique(
        "order access hash", (row.order_access_token_hash for row in plan.orders)
    )
    _require_unique(
        "order item position",
        ((row.order_id, row.position) for row in plan.order_items),
    )
    _require_unique(
        "order menu item",
        ((row.order_id, row.menu_item_id) for row in plan.order_items),
    )
    _require_unique(
        "status sequence",
        ((row.order_id, row.sequence) for row in plan.order_status_history),
    )
    _require_unique(
        "payment request key",
        ((row.order_id, row.request_idempotency_key) for row in plan.payments),
    )
    _require_unique(
        "payment provider key",
        ((row.provider, row.provider_idempotency_key) for row in plan.payments),
    )
    _require_unique("payment order", (row.order_id for row in plan.payments))

    item_totals = {order_id: 0 for order_id in orders}
    for item in plan.order_items:
        parent = orders.get(item.order_id)
        if (
            parent is None
            or item.menu_item_id not in canonical_menu_ids
            or item.currency != "NOK"
            or item.currency != parent.currency
        ):
            raise PortfolioSeedPlanError(
                "Portfolio order-item relationships are invalid."
            )
        item_totals[item.order_id] += item.line_total_amount
    if any(
        item_totals[row.id] != row.subtotal_amount
        or item_totals[row.id] != row.total_amount
        for row in plan.orders
    ):
        raise PortfolioSeedPlanError("Portfolio order totals are invalid.")

    for payment in plan.payments:
        parent = orders.get(payment.order_id)
        if (
            parent is None
            or payment.provider != "demo"
            or payment.amount != parent.total_amount
            or payment.currency != parent.currency
        ):
            raise PortfolioSeedPlanError("Portfolio payment relationships are invalid.")

    canonical_plan: PortfolioSeedPlan | None
    try:
        canonical_plan = generate_portfolio_dataset(plan.metadata.reference_end_utc)
    except PortfolioDatasetError:
        canonical_plan = None
    if canonical_plan is None:
        raise PortfolioSeedPlanError("Portfolio seed identity could not be validated.")
    if plan != canonical_plan:
        raise PortfolioSeedPlanError(
            "Portfolio seed plan is not the canonical generated dataset."
        )


def _require_unique(label: str, values: Iterable[object]) -> None:
    materialized = tuple(values)
    if len(materialized) != len(set(materialized)):
        raise PortfolioSeedPlanError(f"Portfolio {label} values are not unique.")


def _require_exact_schema_revision(session: Session) -> None:
    revisions: tuple[str, ...] | None
    try:
        revisions = tuple(
            str(value)
            for value in session.execute(
                text(
                    "SELECT version_num FROM public.alembic_version "
                    "ORDER BY version_num"
                )
            ).scalars()
        )
    except SQLAlchemyError:
        revisions = None
    if revisions is None:
        raise PortfolioSeedSchemaError(
            "The database schema revision could not be verified."
        )
    if revisions != (EXPECTED_SCHEMA_REVISION,):
        raise PortfolioSeedSchemaError(
            "The database must be at the exact approved schema revision."
        )


def _classify_portfolio_state(
    session: Session, expected: _PortfolioRows
) -> PortfolioState:
    actual = _load_relevant_rows(session, expected)
    if actual.is_empty():
        return "empty"
    if _rows_are_exact(actual, expected):
        return "exact"
    raise PortfolioSeedConflictError(
        "Portfolio seed conflicts with existing database records."
    )


def _require_exact_rows(session: Session, expected: _PortfolioRows) -> None:
    if not _rows_are_exact(_load_relevant_rows(session, expected), expected):
        raise PortfolioSeedConflictError(
            "Portfolio seed verification did not match the approved plan."
        )


def _load_relevant_rows(session: Session, expected: _PortfolioRows) -> _PortfolioRows:
    table_ids = _values(expected.tables, "id")
    table_numbers = _values(expected.tables, "number")
    order_ids = _values(expected.orders, "id")
    public_numbers = _values(expected.orders, "public_order_number")
    access_hashes = _values(expected.orders, "order_access_token_hash")
    item_ids = _values(expected.order_items, "id")
    history_ids = _values(expected.status_history, "id")
    payment_ids = _values(expected.payments, "id")
    provider_keys = _values(expected.payments, "provider_idempotency_key")

    return _PortfolioRows(
        tables=_query_rows(
            session,
            RestaurantTable,
            or_(
                RestaurantTable.id.in_(table_ids),
                RestaurantTable.number.in_(table_numbers),
            ),
        ),
        orders=_query_rows(
            session,
            Order,
            or_(
                Order.id.in_(order_ids),
                Order.public_order_number.in_(public_numbers),
                Order.order_access_token_hash.in_(access_hashes),
                Order.data_origin == "portfolio_seed",
            ),
        ),
        order_items=_query_rows(
            session,
            OrderItem,
            or_(OrderItem.id.in_(item_ids), OrderItem.order_id.in_(order_ids)),
        ),
        status_history=_query_rows(
            session,
            OrderStatusHistory,
            or_(
                OrderStatusHistory.id.in_(history_ids),
                OrderStatusHistory.order_id.in_(order_ids),
            ),
        ),
        payments=_query_rows(
            session,
            Payment,
            or_(
                Payment.id.in_(payment_ids),
                Payment.order_id.in_(order_ids),
                and_(
                    Payment.provider == "demo",
                    Payment.provider_idempotency_key.in_(provider_keys),
                ),
            ),
        ),
    )


def _query_rows(
    session: Session,
    model: type[object],
    predicate: object,
) -> tuple[RowValues, ...]:
    table = model.__table__  # type: ignore[attr-defined]
    statement = select(*table.c).where(predicate)
    return tuple(dict(row) for row in session.execute(statement).mappings())


def _values(rows: tuple[RowValues, ...], key: str) -> tuple[object, ...]:
    return tuple(row[key] for row in rows)


def _rows_are_exact(actual: _PortfolioRows, expected: _PortfolioRows) -> bool:
    return all(
        _collection_is_exact(actual_rows, expected_rows)
        for actual_rows, expected_rows in (
            (actual.tables, expected.tables),
            (actual.orders, expected.orders),
            (actual.order_items, expected.order_items),
            (actual.status_history, expected.status_history),
            (actual.payments, expected.payments),
        )
    )


def _collection_is_exact(
    actual: tuple[RowValues, ...], expected: tuple[RowValues, ...]
) -> bool:
    if len(actual) != len(expected):
        return False
    return {row["id"]: row for row in actual} == {row["id"]: row for row in expected}


def _insert_expected_rows(session: Session, expected: _PortfolioRows) -> None:
    for table, rows in (
        (RestaurantTable.__table__, expected.tables),
        (Order.__table__, expected.orders),
        (OrderItem.__table__, expected.order_items),
        (OrderStatusHistory.__table__, expected.status_history),
        (Payment.__table__, expected.payments),
    ):
        session.execute(insert(table), list(rows))


__all__ = [
    "EXPECTED_SCHEMA_REVISION",
    "PortfolioSeedConflictError",
    "PortfolioSeedDatabaseError",
    "PortfolioSeedError",
    "PortfolioSeedPlanError",
    "PortfolioSeedResult",
    "PortfolioSeedSchemaError",
    "seed_portfolio_data",
]
