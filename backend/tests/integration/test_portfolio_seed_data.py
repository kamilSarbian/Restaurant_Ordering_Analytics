"""Integration tests for atomic deterministic portfolio persistence."""

from __future__ import annotations

import csv
import hashlib
import io
import re
import uuid
from collections import defaultdict
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import delete, event, func, insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.analytics.service import (
    get_analytics_overview,
    get_category_analytics,
    get_order_type_analytics,
    get_product_analytics,
)
from app.auth.models import User
from app.auth.roles import UserRole
from app.categories.models import Category
from app.database.session import create_session_factory
from app.demo import generate_portfolio_dataset
from app.demo.dataset import PaymentSeedRow, PortfolioSeedPlan
from app.menu.models import MenuItem
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.payments.models import Payment, StripeEvent
from app.reports.schemas import AnalyticsCsvExportQuery, OrdersCsvExportQuery
from app.reports.service import (
    CsvExportResult,
    export_orders_csv,
    export_payments_csv,
    export_product_sales_csv,
)
from app.restaurant_tables.models import RestaurantTable
from app.seed.data import CATEGORY_SEEDS, MENU_ITEM_SEEDS
from app.seed.portfolio import (
    PortfolioSeedConflictError,
    PortfolioSeedResult,
    seed_portfolio_data,
)

pytestmark = pytest.mark.integration

FIXED_REFERENCE_END = datetime(2026, 9, 23, tzinfo=ZoneInfo("Europe/Oslo"))
EXPECTED_SHA256 = "716200cc31feebe72a1dc237175e5c5780075bffa055a7086430dedb823bb9f3"
EXPECTED_SIZE = 1_456_799
EXPECTED_COUNTS = (12, 500, 1_211, 2_326, 484)
DML_PATTERN = re.compile(r"\b(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b", re.IGNORECASE)
OSLO = ZoneInfo("Europe/Oslo")
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


@pytest.fixture(scope="module")
def portfolio_plan() -> PortfolioSeedPlan:
    """Generate the fixed canonical plan once for persistence tests."""
    plan = generate_portfolio_dataset(FIXED_REFERENCE_END)
    assert plan.canonical_sha256 == EXPECTED_SHA256
    assert plan.canonical_size_bytes == EXPECTED_SIZE
    return plan


def _clear_business_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        for model in (
            StripeEvent,
            Payment,
            OrderStatusHistory,
            OrderItem,
            Order,
            User,
            RestaurantTable,
            MenuItem,
            Category,
        ):
            connection.execute(delete(model))


@pytest.fixture(autouse=True)
def isolated_empty_database(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Use only the exact isolated test database and clean its business rows."""
    assert test_database_engine.url.drivername == "postgresql+psycopg"
    assert test_database_engine.url.host in {"127.0.0.1", "localhost"}
    assert test_database_engine.url.port == 5433
    assert test_database_engine.url.database == "restaurant_ordering_analytics_test"
    _clear_business_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_business_tables(test_database_engine)


@pytest.fixture
def portfolio_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Bind the adapter only to the already validated test engine."""
    return create_session_factory(test_database_engine)


def _model_rows(session: Session, model: type[Any]) -> tuple[dict[str, Any], ...]:
    table = model.__table__
    result = session.execute(select(*table.c).order_by(table.c.id)).mappings()
    return tuple(dict(row) for row in result)


def _expected_rows(
    rows: tuple[Any, ...], *, omit: frozenset[str] = frozenset()
) -> dict[uuid.UUID, dict[str, Any]]:
    expected: dict[uuid.UUID, dict[str, Any]] = {}
    for row in rows:
        values = asdict(row)
        for key in omit:
            values.pop(key)
        expected[row.id] = values
    return expected


def _actual_rows(session: Session, model: type[Any]) -> dict[uuid.UUID, dict[str, Any]]:
    return {row["id"]: row for row in _model_rows(session, model)}


def _database_snapshot(engine: Engine) -> tuple[tuple[str, object], ...]:
    models = (
        Category,
        MenuItem,
        RestaurantTable,
        Order,
        OrderItem,
        OrderStatusHistory,
        Payment,
        StripeEvent,
        User,
    )
    with Session(engine) as session:
        return tuple(
            (model.__tablename__, _model_rows(session, model)) for model in models
        )


def _assert_no_dml(statements: list[str]) -> None:
    assert not [statement for statement in statements if DML_PATTERN.search(statement)]


def _assert_single_read_statement(
    service_name: str,
    statements: list[str],
) -> None:
    assert (
        len(statements) == 1
    ), f"{service_name} executed {len(statements)} SQL statements instead of one"
    _assert_no_dml(statements)


@contextmanager
def _capture_sql_statements(engine: Engine) -> Generator[list[str], None, None]:
    statements: list[str] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(" ".join(statement.split()))

    event.listen(engine, "before_cursor_execute", capture_statement)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", capture_statement)


def _qualified_plan_payments(
    plan: PortfolioSeedPlan,
    *,
    start: datetime,
    end: datetime,
) -> tuple[PaymentSeedRow, ...]:
    return tuple(
        payment
        for payment in plan.payments
        if payment.status == "succeeded"
        and payment.succeeded_at is not None
        and start <= payment.succeeded_at < end
    )


def _overview_oracle(
    payments: tuple[PaymentSeedRow, ...],
) -> tuple[tuple[str, int, int, int], ...]:
    revenue_by_currency: defaultdict[str, int] = defaultdict(int)
    order_ids_by_currency: defaultdict[str, set[uuid.UUID]] = defaultdict(set)
    for payment in payments:
        revenue_by_currency[payment.currency] += payment.amount
        order_ids_by_currency[payment.currency].add(payment.order_id)

    rows: list[tuple[str, int, int, int]] = []
    for currency in sorted(revenue_by_currency):
        revenue = revenue_by_currency[currency]
        order_count = len(order_ids_by_currency[currency])
        average = int(
            (Decimal(revenue) / Decimal(order_count)).quantize(
                Decimal("1"),
                rounding=ROUND_HALF_UP,
            )
        )
        rows.append((currency, revenue, order_count, average))
    return tuple(rows)


def _product_oracle(
    plan: PortfolioSeedPlan,
    payments: tuple[PaymentSeedRow, ...],
) -> tuple[tuple[uuid.UUID, str, str, int, int], ...]:
    orders = {order.id: order for order in plan.orders}
    paid_order_ids = {payment.order_id for payment in payments}
    aggregates: defaultdict[tuple[uuid.UUID, str, str], list[int]] = defaultdict(
        lambda: [0, 0]
    )
    for item in plan.order_items:
        if item.order_id not in paid_order_ids:
            continue
        order = orders[item.order_id]
        values = aggregates[(item.menu_item_id, item.name_snapshot, order.currency)]
        values[0] += item.quantity
        values[1] += item.line_total_amount

    rows = (
        (menu_item_id, item_name, currency, values[0], values[1])
        for (menu_item_id, item_name, currency), values in aggregates.items()
    )
    return tuple(
        sorted(
            rows,
            key=lambda row: (row[2], -row[4], -row[3], row[0], row[1]),
        )
    )


def _category_oracle(
    plan: PortfolioSeedPlan,
    payments: tuple[PaymentSeedRow, ...],
) -> tuple[tuple[str, str, int, int], ...]:
    orders = {order.id: order for order in plan.orders}
    paid_order_ids = {payment.order_id for payment in payments}
    aggregates: defaultdict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    for item in plan.order_items:
        if item.order_id not in paid_order_ids:
            continue
        order = orders[item.order_id]
        values = aggregates[(item.category_name_snapshot, order.currency)]
        values[0] += item.quantity
        values[1] += item.line_total_amount

    rows = (
        (category_name, currency, values[0], values[1])
        for (category_name, currency), values in aggregates.items()
    )
    return tuple(
        sorted(
            rows,
            key=lambda row: (row[1], -row[3], -row[2], row[0]),
        )
    )


def _order_type_oracle(
    plan: PortfolioSeedPlan,
    payments: tuple[PaymentSeedRow, ...],
) -> tuple[tuple[str, str, int, int], ...]:
    orders = {order.id: order for order in plan.orders}
    revenue: defaultdict[tuple[str, str], int] = defaultdict(int)
    order_ids: defaultdict[tuple[str, str], set[uuid.UUID]] = defaultdict(set)
    for payment in payments:
        order = orders[payment.order_id]
        key = (order.order_type, payment.currency)
        revenue[key] += payment.amount
        order_ids[key].add(payment.order_id)

    rows = (
        (order_type, currency, len(order_ids[key]), amount)
        for key, amount in revenue.items()
        for order_type, currency in (key,)
    )
    return tuple(sorted(rows, key=lambda row: (row[1], row[0])))


def _format_oslo_datetime(value: datetime) -> str:
    return value.astimezone(OSLO).isoformat()


def _range_token(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _read_csv(
    result: CsvExportResult,
) -> tuple[tuple[str, ...], tuple[tuple[str, ...], ...]]:
    assert result.content.startswith(b"\xef\xbb\xbf")
    rows = tuple(
        tuple(row)
        for row in csv.reader(
            io.StringIO(result.content.decode("utf-8-sig"), newline="")
        )
    )
    assert rows
    return rows[0], rows[1:]


@dataclass(frozen=True, slots=True)
class _PaymentTimeFact:
    """Describe one succeeded Payment and its independent Order timestamps."""

    payment_id: uuid.UUID
    order_id: uuid.UUID
    order_number: str
    order_created_at: datetime
    order_updated_at: datetime
    payment_created_at: datetime
    payment_succeeded_at: datetime
    payment_updated_at: datetime
    amount: int


@dataclass(frozen=True, slots=True)
class _RangeProbe:
    """Describe legal sentinel rows that discriminate half-open date filters."""

    start: datetime
    end: datetime
    lower_order_id: uuid.UUID
    lower_order_number: str
    upper_order_id: uuid.UUID
    upper_order_number: str
    lower_payment_order_id: uuid.UUID
    lower_payment_order_number: str
    upper_payment_order_id: uuid.UUID
    upper_payment_order_number: str
    menu_item_id: uuid.UUID
    item_name: str
    category_name: str
    amount: int
    upper_amount: int
    lower_payment: _PaymentTimeFact
    upper_payment: _PaymentTimeFact
    canonical_created_payment: _PaymentTimeFact


def _succeeded_payment_time_facts(
    plan: PortfolioSeedPlan,
    probe: _RangeProbe,
) -> tuple[_PaymentTimeFact, ...]:
    orders = {order.id: order for order in plan.orders}
    plan_facts = tuple(
        _PaymentTimeFact(
            payment_id=payment.id,
            order_id=payment.order_id,
            order_number=orders[payment.order_id].public_order_number,
            order_created_at=orders[payment.order_id].created_at,
            order_updated_at=orders[payment.order_id].updated_at,
            payment_created_at=payment.created_at,
            payment_succeeded_at=payment.succeeded_at,
            payment_updated_at=payment.updated_at,
            amount=payment.amount,
        )
        for payment in plan.payments
        if payment.status == "succeeded" and payment.succeeded_at is not None
    )
    return plan_facts + (
        probe.lower_payment,
        probe.upper_payment,
        probe.canonical_created_payment,
    )


def _time_source_memberships(
    facts: tuple[_PaymentTimeFact, ...],
    *,
    start: datetime,
    end: datetime,
) -> dict[str, frozenset[uuid.UUID]]:
    return {
        "payment_succeeded_at": frozenset(
            fact.payment_id
            for fact in facts
            if start <= fact.payment_succeeded_at < end
        ),
        "order_created_at": frozenset(
            fact.payment_id for fact in facts if start <= fact.order_created_at < end
        ),
        "order_updated_at": frozenset(
            fact.payment_id for fact in facts if start <= fact.order_updated_at < end
        ),
    }


def _financial_signatures(
    facts: tuple[_PaymentTimeFact, ...],
    memberships: dict[str, frozenset[uuid.UUID]],
) -> dict[str, tuple[int, int]]:
    amounts = {fact.payment_id: fact.amount for fact in facts}
    assert len(amounts) == len(facts)
    return {
        source: (len(payment_ids), sum(amounts[value] for value in payment_ids))
        for source, payment_ids in memberships.items()
    }


def _assert_time_source_discrimination(
    plan: PortfolioSeedPlan,
    probe: _RangeProbe,
) -> None:
    sentinels = (
        probe.lower_payment,
        probe.upper_payment,
        probe.canonical_created_payment,
    )
    assert all(sentinel.amount > 0 for sentinel in sentinels)
    assert len({sentinel.amount for sentinel in sentinels}) == len(sentinels)
    for sentinel in sentinels:
        assert (
            sentinel.order_created_at
            < sentinel.payment_created_at
            <= sentinel.payment_succeeded_at
            <= sentinel.payment_updated_at
            <= sentinel.order_updated_at
        )

    facts = _succeeded_payment_time_facts(plan, probe)
    plan_payment_ids = frozenset(
        payment.id
        for payment in plan.payments
        if payment.status == "succeeded" and payment.succeeded_at is not None
    )
    canonical_memberships = _time_source_memberships(
        facts,
        start=plan.metadata.window_start_utc,
        end=plan.metadata.reference_end_utc,
    )
    assert canonical_memberships == {
        "payment_succeeded_at": plan_payment_ids,
        "order_created_at": plan_payment_ids
        | {probe.canonical_created_payment.payment_id},
        "order_updated_at": plan_payment_ids | {probe.lower_payment.payment_id},
    }
    assert len(set(canonical_memberships.values())) == 3
    assert _financial_signatures(facts, canonical_memberships) == {
        "payment_succeeded_at": (449, 31_542_500),
        "order_created_at": (
            450,
            31_542_500 + probe.canonical_created_payment.amount,
        ),
        "order_updated_at": (450, 31_542_500 + probe.lower_payment.amount),
    }

    boundary_memberships = _time_source_memberships(
        facts,
        start=probe.start,
        end=probe.end,
    )
    assert boundary_memberships == {
        "payment_succeeded_at": frozenset({probe.lower_payment.payment_id}),
        "order_created_at": frozenset({probe.upper_payment.payment_id}),
        "order_updated_at": frozenset(),
    }
    assert len(set(boundary_memberships.values())) == 3
    assert _financial_signatures(facts, boundary_memberships) == {
        "payment_succeeded_at": (1, probe.amount),
        "order_created_at": (1, probe.upper_amount),
        "order_updated_at": (0, 0),
    }


def _insert_range_probe_rows(
    session: Session,
    plan: PortfolioSeedPlan,
) -> _RangeProbe:
    """Insert unrelated legal rows at both boundaries and outside the range."""
    start = plan.metadata.window_start_utc - timedelta(days=2)
    end = start + timedelta(days=1)
    item = plan.order_items[0]
    amount = item.unit_price_amount
    upper_amount = amount + 137
    canonical_amount = amount + 271

    lower_order_id = uuid.uuid5(uuid.NAMESPACE_URL, "b2-3/orders/lower")
    upper_order_id = uuid.uuid5(uuid.NAMESPACE_URL, "b2-3/orders/upper")
    lower_payment_order_id = uuid.uuid5(uuid.NAMESPACE_URL, "b2-3/payments/lower-order")
    upper_payment_order_id = uuid.uuid5(uuid.NAMESPACE_URL, "b2-3/payments/upper-order")
    canonical_created_order_id = uuid.uuid5(
        uuid.NAMESPACE_URL, "b2-3/payments/canonical-created-order"
    )
    lower_order_number = "ROA-22222222222A"
    upper_order_number = "ROA-22222222222B"
    lower_payment_order_number = "ROA-22222222222C"
    upper_payment_order_number = "ROA-22222222222D"
    canonical_created_order_number = "ROA-22222222222E"

    lower_payment = _PaymentTimeFact(
        payment_id=uuid.uuid5(uuid.NAMESPACE_URL, "b2-3/payments/lower"),
        order_id=lower_payment_order_id,
        order_number=lower_payment_order_number,
        order_created_at=start - timedelta(hours=2),
        order_updated_at=plan.metadata.window_start_utc + timedelta(hours=1),
        payment_created_at=start - timedelta(hours=1),
        payment_succeeded_at=start,
        payment_updated_at=start,
        amount=amount,
    )
    upper_payment = _PaymentTimeFact(
        payment_id=uuid.uuid5(uuid.NAMESPACE_URL, "b2-3/payments/upper"),
        order_id=upper_payment_order_id,
        order_number=upper_payment_order_number,
        order_created_at=start + timedelta(minutes=30),
        order_updated_at=end + timedelta(hours=1),
        payment_created_at=start + timedelta(hours=1),
        payment_succeeded_at=end,
        payment_updated_at=end,
        amount=upper_amount,
    )
    canonical_created_payment = _PaymentTimeFact(
        payment_id=uuid.uuid5(uuid.NAMESPACE_URL, "b2-3/payments/canonical-created"),
        order_id=canonical_created_order_id,
        order_number=canonical_created_order_number,
        order_created_at=plan.metadata.reference_end_utc - timedelta(hours=2),
        order_updated_at=plan.metadata.reference_end_utc + timedelta(hours=1),
        payment_created_at=plan.metadata.reference_end_utc - timedelta(hours=1),
        payment_succeeded_at=plan.metadata.reference_end_utc,
        payment_updated_at=plan.metadata.reference_end_utc,
        amount=canonical_amount,
    )

    def order_values(
        *,
        order_id: uuid.UUID,
        public_order_number: str,
        created_at: datetime,
        updated_at: datetime,
        status: str,
        total_amount: int,
    ) -> dict[str, object]:
        return {
            "id": order_id,
            "public_order_number": public_order_number,
            "order_access_token_hash": hashlib.sha256(
                f"b2-3:{public_order_number}".encode()
            ).hexdigest(),
            "customer_user_id": None,
            "data_origin": "live",
            "order_type": "takeaway",
            "table_id": None,
            "table_number_snapshot": None,
            "status": status,
            "currency": "NOK",
            "subtotal_amount": total_amount,
            "total_amount": total_amount,
            "created_at": created_at,
            "updated_at": updated_at,
        }

    session.execute(
        insert(Order),
        [
            order_values(
                order_id=lower_order_id,
                public_order_number=lower_order_number,
                created_at=start,
                updated_at=start,
                status="created",
                total_amount=1_000,
            ),
            order_values(
                order_id=upper_order_id,
                public_order_number=upper_order_number,
                created_at=end,
                updated_at=end,
                status="created",
                total_amount=1_000,
            ),
            order_values(
                order_id=lower_payment_order_id,
                public_order_number=lower_payment_order_number,
                created_at=lower_payment.order_created_at,
                updated_at=lower_payment.order_updated_at,
                status="completed",
                total_amount=amount,
            ),
            order_values(
                order_id=upper_payment_order_id,
                public_order_number=upper_payment_order_number,
                created_at=upper_payment.order_created_at,
                updated_at=upper_payment.order_updated_at,
                status="completed",
                total_amount=upper_amount,
            ),
            order_values(
                order_id=canonical_created_order_id,
                public_order_number=canonical_created_order_number,
                created_at=canonical_created_payment.order_created_at,
                updated_at=canonical_created_payment.order_updated_at,
                status="completed",
                total_amount=canonical_amount,
            ),
        ],
    )
    session.execute(
        insert(OrderItem),
        [
            {
                "id": uuid.uuid5(uuid.NAMESPACE_URL, "b2-3/items/lower"),
                "order_id": lower_payment_order_id,
                "menu_item_id": item.menu_item_id,
                "position": 0,
                "category_name_snapshot": item.category_name_snapshot,
                "name_snapshot": item.name_snapshot,
                "quantity": 1,
                "unit_price_amount": amount,
                "unit_cost_amount": item.unit_cost_amount,
                "tax_rate_bps_snapshot": item.tax_rate_bps_snapshot,
                "discount_amount_snapshot": 0,
                "line_total_amount": amount,
            },
            {
                "id": uuid.uuid5(uuid.NAMESPACE_URL, "b2-3/items/upper"),
                "order_id": upper_payment_order_id,
                "menu_item_id": item.menu_item_id,
                "position": 0,
                "category_name_snapshot": item.category_name_snapshot,
                "name_snapshot": item.name_snapshot,
                "quantity": 1,
                "unit_price_amount": upper_amount,
                "unit_cost_amount": item.unit_cost_amount,
                "tax_rate_bps_snapshot": item.tax_rate_bps_snapshot,
                "discount_amount_snapshot": 0,
                "line_total_amount": upper_amount,
            },
            {
                "id": uuid.uuid5(uuid.NAMESPACE_URL, "b2-3/items/canonical-created"),
                "order_id": canonical_created_order_id,
                "menu_item_id": item.menu_item_id,
                "position": 0,
                "category_name_snapshot": item.category_name_snapshot,
                "name_snapshot": item.name_snapshot,
                "quantity": 1,
                "unit_price_amount": canonical_amount,
                "unit_cost_amount": item.unit_cost_amount,
                "tax_rate_bps_snapshot": item.tax_rate_bps_snapshot,
                "discount_amount_snapshot": 0,
                "line_total_amount": canonical_amount,
            },
        ],
    )
    session.execute(
        insert(Payment),
        [
            {
                "id": lower_payment.payment_id,
                "order_id": lower_payment_order_id,
                "status": "succeeded",
                "amount": amount,
                "currency": "NOK",
                "request_idempotency_key": uuid.uuid5(
                    uuid.NAMESPACE_URL, "b2-3/requests/lower"
                ),
                "provider": "demo",
                "provider_idempotency_key": "b2-3-range-lower",
                "succeeded_at": lower_payment.payment_succeeded_at,
                "created_at": lower_payment.payment_created_at,
                "updated_at": lower_payment.payment_updated_at,
            },
            {
                "id": upper_payment.payment_id,
                "order_id": upper_payment_order_id,
                "status": "succeeded",
                "amount": upper_amount,
                "currency": "NOK",
                "request_idempotency_key": uuid.uuid5(
                    uuid.NAMESPACE_URL, "b2-3/requests/upper"
                ),
                "provider": "demo",
                "provider_idempotency_key": "b2-3-range-upper",
                "succeeded_at": upper_payment.payment_succeeded_at,
                "created_at": upper_payment.payment_created_at,
                "updated_at": upper_payment.payment_updated_at,
            },
            {
                "id": canonical_created_payment.payment_id,
                "order_id": canonical_created_order_id,
                "status": "succeeded",
                "amount": canonical_amount,
                "currency": "NOK",
                "request_idempotency_key": uuid.uuid5(
                    uuid.NAMESPACE_URL, "b2-3/requests/canonical-created"
                ),
                "provider": "demo",
                "provider_idempotency_key": "b2-3-canonical-created",
                "succeeded_at": canonical_created_payment.payment_succeeded_at,
                "created_at": canonical_created_payment.payment_created_at,
                "updated_at": canonical_created_payment.payment_updated_at,
            },
        ],
    )
    return _RangeProbe(
        start=start,
        end=end,
        lower_order_id=lower_order_id,
        lower_order_number=lower_order_number,
        upper_order_id=upper_order_id,
        upper_order_number=upper_order_number,
        lower_payment_order_id=lower_payment_order_id,
        lower_payment_order_number=lower_payment_order_number,
        upper_payment_order_id=upper_payment_order_id,
        upper_payment_order_number=upper_payment_order_number,
        menu_item_id=item.menu_item_id,
        item_name=item.name_snapshot,
        category_name=item.category_name_snapshot,
        amount=amount,
        upper_amount=upper_amount,
        lower_payment=lower_payment,
        upper_payment=upper_payment,
        canonical_created_payment=canonical_created_payment,
    )


def _assert_exact_plan(session: Session, plan: PortfolioSeedPlan) -> None:
    assert _actual_rows(session, RestaurantTable) == _expected_rows(plan.tables)
    assert _actual_rows(session, Order) == _expected_rows(plan.orders)
    assert _actual_rows(session, OrderItem) == _expected_rows(
        plan.order_items, omit=frozenset({"currency"})
    )
    assert _actual_rows(session, OrderStatusHistory) == _expected_rows(
        plan.order_status_history
    )
    assert _actual_rows(session, Payment) == _expected_rows(plan.payments)
    assert set(session.scalars(select(Category.id))) == {
        row.id for row in CATEGORY_SEEDS
    }
    assert set(session.scalars(select(MenuItem.id))) == {
        row.id for row in MENU_ITEM_SEEDS
    }
    assert session.scalar(select(func.count()).select_from(StripeEvent)) == 0


def _insert_order(
    session: Session,
    *,
    order_id: uuid.UUID,
    public_order_number: str,
    access_hash: str,
    data_origin: str,
    customer_user_id: uuid.UUID | None = None,
) -> None:
    session.execute(
        insert(Order),
        {
            "id": order_id,
            "public_order_number": public_order_number,
            "order_access_token_hash": access_hash,
            "customer_user_id": customer_user_id,
            "data_origin": data_origin,
            "order_type": "takeaway",
            "table_id": None,
            "table_number_snapshot": None,
            "status": "cancelled",
            "currency": "NOK",
            "subtotal_amount": 1_000,
            "total_amount": 1_000,
        },
    )


def test_insert_exact_plan_and_identical_rerun_is_true_no_op(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Persist every row exactly and preserve all timestamps on a second run."""
    first = seed_portfolio_data(portfolio_session_factory, portfolio_plan)

    def capture_statement(
        conn: object,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        statements.append(" ".join(statement.split()))

    statements: list[str] = []
    before = _database_snapshot(test_database_engine)
    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        second = seed_portfolio_data(portfolio_session_factory, portfolio_plan)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)
    after = _database_snapshot(test_database_engine)

    assert first == PortfolioSeedResult(
        inserted=True,
        categories_processed=5,
        menu_items_processed=15,
        tables_processed=12,
        orders_processed=500,
        order_items_processed=1_211,
        status_history_processed=2_326,
        payments_processed=484,
    )
    application_statements = [
        statement for statement in statements if statement.upper() != "SELECT 1"
    ]
    assert application_statements[0] == (
        "SELECT version_num FROM public.alembic_version ORDER BY version_num"
    )
    _assert_no_dml(application_statements)
    with portfolio_session_factory() as session:
        _assert_exact_plan(session, portfolio_plan)

    assert second.inserted is False
    assert before == after


def test_exact_portfolio_with_drifted_menu_fails_without_dml(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Reject canonical-menu drift without repairing or mutating any row."""
    seed_portfolio_data(portfolio_session_factory, portfolio_plan)
    menu_item = MENU_ITEM_SEEDS[0]
    with portfolio_session_factory.begin() as session:
        session.execute(
            update(MenuItem)
            .where(MenuItem.id == menu_item.id)
            .values(description=f"{menu_item.description} Drifted")
        )
    before = _database_snapshot(test_database_engine)
    statements: list[str] = []

    def capture_statement(
        conn: object,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        statements.append(" ".join(statement.split()))

    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with pytest.raises(PortfolioSeedConflictError):
            seed_portfolio_data(portfolio_session_factory, portfolio_plan)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    _assert_no_dml(statements)
    assert _database_snapshot(test_database_engine) == before


def test_partial_portfolio_data_conflicts_without_repair(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Reject a missing canonical child instead of silently repairing it."""
    seed_portfolio_data(portfolio_session_factory, portfolio_plan)
    with portfolio_session_factory.begin() as session:
        session.execute(
            delete(Payment).where(Payment.id == portfolio_plan.payments[0].id)
        )
    partial = _database_snapshot(test_database_engine)

    with pytest.raises(PortfolioSeedConflictError):
        seed_portfolio_data(portfolio_session_factory, portfolio_plan)

    assert _database_snapshot(test_database_engine) == partial


def test_drifted_portfolio_data_conflicts_without_overwrite(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Reject one changed authoritative value without overwriting it."""
    seed_portfolio_data(portfolio_session_factory, portfolio_plan)
    order = portfolio_plan.orders[0]
    with portfolio_session_factory.begin() as session:
        session.execute(
            update(Order)
            .where(Order.id == order.id)
            .values(total_amount=order.total_amount + 1)
        )
    drifted = _database_snapshot(test_database_engine)

    with pytest.raises(PortfolioSeedConflictError):
        seed_portfolio_data(portfolio_session_factory, portfolio_plan)

    assert _database_snapshot(test_database_engine) == drifted


def test_different_reference_end_conflicts_and_preserves_original(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Reject a second seed identity instead of mixing reference windows."""
    seed_portfolio_data(portfolio_session_factory, portfolio_plan)
    original = _database_snapshot(test_database_engine)
    different_plan = generate_portfolio_dataset(FIXED_REFERENCE_END + timedelta(days=1))

    with pytest.raises(PortfolioSeedConflictError):
        seed_portfolio_data(portfolio_session_factory, different_plan)

    assert _database_snapshot(test_database_engine) == original


def test_foreign_table_number_collision_precedes_menu_writes(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Fail closed on global table-number ownership before any menu DML."""
    with portfolio_session_factory.begin() as session:
        session.add(
            RestaurantTable(id=uuid.uuid4(), number=portfolio_plan.tables[0].number)
        )
    before = _database_snapshot(test_database_engine)

    with pytest.raises(PortfolioSeedConflictError):
        seed_portfolio_data(portfolio_session_factory, portfolio_plan)

    assert _database_snapshot(test_database_engine) == before
    with portfolio_session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Category)) == 0
        assert session.scalar(select(func.count()).select_from(MenuItem)) == 0


def test_stable_table_uuid_collision_is_not_treated_as_empty(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Detect a generated table UUID already owned by a different row."""
    with portfolio_session_factory.begin() as session:
        session.add(RestaurantTable(id=portfolio_plan.tables[0].id, number=99))
    before = _database_snapshot(test_database_engine)

    with pytest.raises(PortfolioSeedConflictError):
        seed_portfolio_data(portfolio_session_factory, portfolio_plan)

    assert _database_snapshot(test_database_engine) == before


def test_public_order_number_collision_is_not_treated_as_empty(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Detect an unrelated live order that owns a generated public identity."""
    with portfolio_session_factory.begin() as session:
        _insert_order(
            session,
            order_id=uuid.uuid4(),
            public_order_number=portfolio_plan.orders[0].public_order_number,
            access_hash=hashlib.sha256(b"unrelated-live-order").hexdigest(),
            data_origin="live",
        )
    before = _database_snapshot(test_database_engine)

    with pytest.raises(PortfolioSeedConflictError):
        seed_portfolio_data(portfolio_session_factory, portfolio_plan)

    assert _database_snapshot(test_database_engine) == before


def test_order_access_hash_collision_is_not_treated_as_empty(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Detect an unrelated live order that owns a generated access hash."""
    with portfolio_session_factory.begin() as session:
        _insert_order(
            session,
            order_id=uuid.uuid4(),
            public_order_number="ROA-23456789ABCG",
            access_hash=portfolio_plan.orders[0].order_access_token_hash,
            data_origin="live",
        )
    before = _database_snapshot(test_database_engine)

    with pytest.raises(PortfolioSeedConflictError):
        seed_portfolio_data(portfolio_session_factory, portfolio_plan)

    assert _database_snapshot(test_database_engine) == before


def test_provider_key_collision_is_not_treated_as_empty(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Detect a demo provider key already owned by an unrelated payment."""
    order_id = uuid.uuid4()
    with portfolio_session_factory.begin() as session:
        _insert_order(
            session,
            order_id=order_id,
            public_order_number="ROA-23456789ABCD",
            access_hash=hashlib.sha256(b"provider-key-owner").hexdigest(),
            data_origin="live",
        )
        session.add(
            Payment(
                id=uuid.uuid4(),
                order_id=order_id,
                status="failed",
                amount=1_000,
                currency="NOK",
                request_idempotency_key=uuid.uuid4(),
                provider="demo",
                provider_idempotency_key=(
                    portfolio_plan.payments[0].provider_idempotency_key
                ),
            )
        )
    before = _database_snapshot(test_database_engine)

    with pytest.raises(PortfolioSeedConflictError):
        seed_portfolio_data(portfolio_session_factory, portfolio_plan)

    assert _database_snapshot(test_database_engine) == before


def test_unrelated_live_runtime_user_and_stripe_rows_remain_unchanged(
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Preserve every unrelated origin, provider, event, user, and table row."""
    user_id = uuid.uuid4()
    table_id = uuid.uuid4()
    live_order_id = uuid.uuid4()
    runtime_order_id = uuid.uuid4()
    stripe_payment_id = uuid.uuid4()
    runtime_payment_id = uuid.uuid4()
    stripe_event_id = uuid.uuid4()
    fixed_time = datetime(2026, 1, 1, 12, tzinfo=UTC)
    with portfolio_session_factory.begin() as session:
        session.add(
            User(
                id=user_id,
                email="preserved@example.test",
                password_hash="preserved-password-hash",
                role=UserRole.CUSTOMER,
            )
        )
        session.add(RestaurantTable(id=table_id, number=99, is_active=False))
        _insert_order(
            session,
            order_id=live_order_id,
            public_order_number="ROA-23456789ABCE",
            access_hash=hashlib.sha256(b"preserved-live").hexdigest(),
            data_origin="live",
            customer_user_id=user_id,
        )
        _insert_order(
            session,
            order_id=runtime_order_id,
            public_order_number="ROA-23456789ABCF",
            access_hash=hashlib.sha256(b"preserved-runtime").hexdigest(),
            data_origin="portfolio_runtime",
        )
        session.add_all(
            [
                Payment(
                    id=stripe_payment_id,
                    order_id=live_order_id,
                    status="failed",
                    amount=1_000,
                    currency="NOK",
                    request_idempotency_key=uuid.uuid4(),
                    provider="stripe_test",
                    provider_idempotency_key="preserved-stripe-key",
                ),
                Payment(
                    id=runtime_payment_id,
                    order_id=runtime_order_id,
                    status="failed",
                    amount=1_000,
                    currency="NOK",
                    request_idempotency_key=uuid.uuid4(),
                    provider="demo",
                    provider_idempotency_key="preserved-runtime-demo-key",
                ),
                StripeEvent(
                    id=stripe_event_id,
                    stripe_event_id="evt_preserved",
                    event_type="checkout.session.async_payment_failed",
                    livemode=False,
                    stripe_created_at=fixed_time,
                    stripe_checkout_session_id="cs_test_preserved",
                    payment_id=stripe_payment_id,
                    processing_result="transitioned",
                ),
            ]
        )

    with portfolio_session_factory() as session:
        before = {
            "user": session.get(User, user_id),
            "table": session.get(RestaurantTable, table_id),
            "live": session.get(Order, live_order_id),
            "runtime": session.get(Order, runtime_order_id),
            "stripe_payment": session.get(Payment, stripe_payment_id),
            "runtime_payment": session.get(Payment, runtime_payment_id),
            "event": session.get(StripeEvent, stripe_event_id),
        }
        before_values = {
            name: tuple(getattr(value, column.name) for column in value.__table__.c)
            for name, value in before.items()
            if value is not None
        }

    seed_portfolio_data(portfolio_session_factory, portfolio_plan)

    with portfolio_session_factory() as session:
        for name, model, row_id in (
            ("user", User, user_id),
            ("table", RestaurantTable, table_id),
            ("live", Order, live_order_id),
            ("runtime", Order, runtime_order_id),
            ("stripe_payment", Payment, stripe_payment_id),
            ("runtime_payment", Payment, runtime_payment_id),
            ("event", StripeEvent, stripe_event_id),
        ):
            value = session.get(model, row_id)
            assert value is not None
            assert (
                tuple(getattr(value, column.name) for column in value.__table__.c)
                == before_values[name]
            )


def test_seeded_portfolio_matches_all_analytics_services(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Prove that the complete persisted plan drives every analytics service."""
    seed_portfolio_data(portfolio_session_factory, portfolio_plan)
    start = portfolio_plan.metadata.window_start_utc
    end = portfolio_plan.metadata.reference_end_utc
    qualified_payments = _qualified_plan_payments(
        portfolio_plan,
        start=start,
        end=end,
    )
    expected_overview = _overview_oracle(qualified_payments)
    expected_products = _product_oracle(portfolio_plan, qualified_payments)
    expected_categories = _category_oracle(portfolio_plan, qualified_payments)
    expected_order_types = _order_type_oracle(portfolio_plan, qualified_payments)

    assert len(qualified_payments) == 449
    assert expected_overview == (("NOK", 31_542_500, 449, 70_251),)
    assert len(expected_products) == 14
    assert len(expected_categories) == 5
    assert len(expected_order_types) == 2
    assert sum(row[4] for row in expected_products) == 31_542_500
    assert sum(row[3] for row in expected_categories) == 31_542_500
    assert sum(row[3] for row in expected_order_types) == 31_542_500

    with portfolio_session_factory() as session:
        assert session.scalar(select(func.count()).select_from(StripeEvent)) == 0
        session.connection()
        with _capture_sql_statements(test_database_engine) as overview_statements:
            overview = get_analytics_overview(
                session,
                start=start,
                end=end,
                currency=None,
            )
        _assert_single_read_statement("analytics overview", overview_statements)
        with _capture_sql_statements(test_database_engine) as product_statements:
            products = get_product_analytics(
                session,
                start=start,
                end=end,
                currency=None,
                limit=100,
            )
        _assert_single_read_statement("product analytics", product_statements)
        with _capture_sql_statements(test_database_engine) as category_statements:
            categories = get_category_analytics(
                session,
                start=start,
                end=end,
                currency=None,
                limit=100,
            )
        _assert_single_read_statement("category analytics", category_statements)
        with _capture_sql_statements(test_database_engine) as order_type_statements:
            order_types = get_order_type_analytics(
                session,
                start=start,
                end=end,
                currency=None,
            )
        _assert_single_read_statement("order-type analytics", order_type_statements)

    application_statements = [
        *overview_statements,
        *product_statements,
        *category_statements,
        *order_type_statements,
    ]
    assert len(application_statements) == 4
    _assert_no_dml(application_statements)
    for response in (overview, products, categories, order_types):
        assert response.range.start.isoformat() == _format_oslo_datetime(start)
        assert response.range.end.isoformat() == _format_oslo_datetime(end)
        assert response.range.timezone == "Europe/Oslo"
    assert products.limit_per_currency == 100
    assert categories.limit_per_currency == 100

    assert (
        tuple(
            (
                row.currency,
                row.collected_revenue_amount,
                row.succeeded_orders_count,
                row.average_order_value_amount,
            )
            for row in overview.currencies
        )
        == expected_overview
    )
    assert (
        tuple(
            (
                row.menu_item_id,
                row.item_name,
                row.currency,
                row.quantity_sold,
                row.sales_amount,
            )
            for row in products.items
        )
        == expected_products
    )
    assert (
        tuple(
            (
                row.category_name,
                row.currency,
                row.quantity_sold,
                row.sales_amount,
            )
            for row in categories.items
        )
        == expected_categories
    )
    assert (
        tuple(
            (
                row.order_type.value,
                row.currency,
                row.succeeded_orders_count,
                row.collected_revenue_amount,
            )
            for row in order_types.items
        )
        == expected_order_types
    )

    with portfolio_session_factory.begin() as session:
        probe = _insert_range_probe_rows(session, portfolio_plan)
    _assert_time_source_discrimination(portfolio_plan, probe)

    with portfolio_session_factory() as session:
        session.connection()
        with _capture_sql_statements(test_database_engine) as probe_overview_statements:
            probe_overview = get_analytics_overview(
                session,
                start=probe.start,
                end=probe.end,
                currency=None,
            )
        _assert_single_read_statement(
            "analytics overview boundary probe",
            probe_overview_statements,
        )
        with _capture_sql_statements(test_database_engine) as probe_product_statements:
            probe_products = get_product_analytics(
                session,
                start=probe.start,
                end=probe.end,
                currency=None,
                limit=100,
            )
        _assert_single_read_statement(
            "product analytics boundary probe",
            probe_product_statements,
        )
        with _capture_sql_statements(test_database_engine) as probe_category_statements:
            probe_categories = get_category_analytics(
                session,
                start=probe.start,
                end=probe.end,
                currency=None,
                limit=100,
            )
        _assert_single_read_statement(
            "category analytics boundary probe",
            probe_category_statements,
        )
        with _capture_sql_statements(
            test_database_engine
        ) as probe_order_type_statements:
            probe_order_types = get_order_type_analytics(
                session,
                start=probe.start,
                end=probe.end,
                currency=None,
            )
        _assert_single_read_statement(
            "order-type analytics boundary probe",
            probe_order_type_statements,
        )

    probe_application_statements = [
        *probe_overview_statements,
        *probe_product_statements,
        *probe_category_statements,
        *probe_order_type_statements,
    ]
    assert len(probe_application_statements) == 4
    _assert_no_dml(probe_application_statements)
    for response in (
        probe_overview,
        probe_products,
        probe_categories,
        probe_order_types,
    ):
        assert response.range.start.isoformat() == _format_oslo_datetime(probe.start)
        assert response.range.end.isoformat() == _format_oslo_datetime(probe.end)
        assert response.range.timezone == "Europe/Oslo"
    assert tuple(
        (
            row.currency,
            row.collected_revenue_amount,
            row.succeeded_orders_count,
            row.average_order_value_amount,
        )
        for row in probe_overview.currencies
    ) == (("NOK", probe.amount, 1, probe.amount),)
    assert tuple(
        (
            row.menu_item_id,
            row.item_name,
            row.currency,
            row.quantity_sold,
            row.sales_amount,
        )
        for row in probe_products.items
    ) == ((probe.menu_item_id, probe.item_name, "NOK", 1, probe.amount),)
    assert tuple(
        (
            row.category_name,
            row.currency,
            row.quantity_sold,
            row.sales_amount,
        )
        for row in probe_categories.items
    ) == ((probe.category_name, "NOK", 1, probe.amount),)
    assert tuple(
        (
            row.order_type.value,
            row.currency,
            row.succeeded_orders_count,
            row.collected_revenue_amount,
        )
        for row in probe_order_types.items
    ) == (("takeaway", "NOK", 1, probe.amount),)
    assert portfolio_plan.canonical_sha256 == EXPECTED_SHA256
    assert portfolio_plan.canonical_size_bytes == EXPECTED_SIZE


def test_seeded_portfolio_matches_all_csv_services(
    test_database_engine: Engine,
    portfolio_session_factory: sessionmaker[Session],
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Prove every complete CSV export against ordered rows from the seed plan."""
    seed_portfolio_data(portfolio_session_factory, portfolio_plan)
    start = portfolio_plan.metadata.window_start_utc
    end = portfolio_plan.metadata.reference_end_utc
    qualified_payments = _qualified_plan_payments(
        portfolio_plan,
        start=start,
        end=end,
    )
    product_rows = _product_oracle(portfolio_plan, qualified_payments)
    orders = {order.id: order for order in portfolio_plan.orders}
    range_start = _format_oslo_datetime(start)
    range_end = _format_oslo_datetime(end)

    expected_order_rows = tuple(
        (
            range_start,
            range_end,
            "Europe/Oslo",
            order.public_order_number,
            _format_oslo_datetime(order.created_at),
            _format_oslo_datetime(order.updated_at),
            order.status,
            order.order_type,
            (
                ""
                if order.table_number_snapshot is None
                else str(order.table_number_snapshot)
            ),
            order.currency,
            str(order.subtotal_amount),
            str(order.total_amount),
        )
        for order in sorted(
            (row for row in portfolio_plan.orders if start <= row.created_at < end),
            key=lambda row: (row.created_at, row.id),
        )
    )
    expected_product_rows = tuple(
        (
            range_start,
            range_end,
            "Europe/Oslo",
            str(menu_item_id),
            item_name,
            currency,
            str(quantity),
            str(sales_amount),
        )
        for menu_item_id, item_name, currency, quantity, sales_amount in product_rows
    )
    expected_payment_rows = tuple(
        (
            range_start,
            range_end,
            "Europe/Oslo",
            orders[payment.order_id].public_order_number,
            payment.status,
            _format_oslo_datetime(payment.succeeded_at),
            payment.currency,
            str(payment.amount),
        )
        for payment in sorted(
            qualified_payments,
            key=lambda row: (
                row.succeeded_at,
                orders[row.order_id].public_order_number,
                row.id,
            ),
        )
        if payment.succeeded_at is not None
    )

    assert len(expected_order_rows) == 500
    assert len(expected_product_rows) == 14
    assert len(expected_payment_rows) == 449

    orders_query = OrdersCsvExportQuery(start=start, end=end)
    analytics_query = AnalyticsCsvExportQuery(start=start, end=end)
    with portfolio_session_factory() as session:
        assert session.scalar(select(func.count()).select_from(StripeEvent)) == 0
        session.connection()
        with _capture_sql_statements(test_database_engine) as orders_statements:
            orders_export = export_orders_csv(session, orders_query)
        _assert_single_read_statement("orders CSV export", orders_statements)
        with _capture_sql_statements(test_database_engine) as products_statements:
            products_export = export_product_sales_csv(session, analytics_query)
        _assert_single_read_statement("product-sales CSV export", products_statements)
        with _capture_sql_statements(test_database_engine) as payments_statements:
            payments_export = export_payments_csv(session, analytics_query)
        _assert_single_read_statement("payments CSV export", payments_statements)

    application_statements = [
        *orders_statements,
        *products_statements,
        *payments_statements,
    ]
    assert len(application_statements) == 3
    _assert_no_dml(application_statements)
    order_headers, order_rows = _read_csv(orders_export)
    product_headers, actual_product_rows = _read_csv(products_export)
    payment_headers, payment_rows = _read_csv(payments_export)

    assert order_headers == ORDERS_CSV_HEADERS
    assert product_headers == PRODUCT_SALES_CSV_HEADERS
    assert payment_headers == PAYMENTS_CSV_HEADERS
    assert order_rows == expected_order_rows
    assert actual_product_rows == expected_product_rows
    assert payment_rows == expected_payment_rows

    start_token = _range_token(start)
    end_token = _range_token(end)
    assert start_token == "20260724T220000Z"
    assert end_token == "20260922T220000Z"
    assert orders_export.filename == (
        f"orders_{start_token}_{end_token}_all_all_all.csv"
    )
    assert products_export.filename == (
        f"product-sales_{start_token}_{end_token}_all.csv"
    )
    assert payments_export.filename == (f"payments_{start_token}_{end_token}_all.csv")

    with portfolio_session_factory.begin() as session:
        probe = _insert_range_probe_rows(session, portfolio_plan)
    _assert_time_source_discrimination(portfolio_plan, probe)

    probe_orders_query = OrdersCsvExportQuery(start=probe.start, end=probe.end)
    probe_analytics_query = AnalyticsCsvExportQuery(start=probe.start, end=probe.end)
    with portfolio_session_factory() as session:
        session.connection()
        with _capture_sql_statements(test_database_engine) as probe_orders_statements:
            probe_orders_export = export_orders_csv(session, probe_orders_query)
        _assert_single_read_statement(
            "orders CSV export boundary probe",
            probe_orders_statements,
        )
        with _capture_sql_statements(test_database_engine) as probe_products_statements:
            probe_products_export = export_product_sales_csv(
                session, probe_analytics_query
            )
        _assert_single_read_statement(
            "product-sales CSV export boundary probe",
            probe_products_statements,
        )
        with _capture_sql_statements(test_database_engine) as probe_payments_statements:
            probe_payments_export = export_payments_csv(session, probe_analytics_query)
        _assert_single_read_statement(
            "payments CSV export boundary probe",
            probe_payments_statements,
        )

    probe_application_statements = [
        *probe_orders_statements,
        *probe_products_statements,
        *probe_payments_statements,
    ]
    assert len(probe_application_statements) == 3
    _assert_no_dml(probe_application_statements)
    probe_order_headers, probe_order_rows = _read_csv(probe_orders_export)
    probe_product_headers, probe_product_rows = _read_csv(probe_products_export)
    probe_payment_headers, probe_payment_rows = _read_csv(probe_payments_export)
    probe_start = _format_oslo_datetime(probe.start)
    probe_end = _format_oslo_datetime(probe.end)
    assert probe_order_headers == ORDERS_CSV_HEADERS
    assert probe_product_headers == PRODUCT_SALES_CSV_HEADERS
    assert probe_payment_headers == PAYMENTS_CSV_HEADERS
    assert probe_order_rows == (
        (
            probe_start,
            probe_end,
            "Europe/Oslo",
            probe.lower_order_number,
            probe_start,
            probe_start,
            "created",
            "takeaway",
            "",
            "NOK",
            "1000",
            "1000",
        ),
        (
            probe_start,
            probe_end,
            "Europe/Oslo",
            probe.upper_payment_order_number,
            _format_oslo_datetime(probe.upper_payment.order_created_at),
            _format_oslo_datetime(probe.upper_payment.order_updated_at),
            "completed",
            "takeaway",
            "",
            "NOK",
            str(probe.upper_amount),
            str(probe.upper_amount),
        ),
    )
    assert probe_product_rows == (
        (
            probe_start,
            probe_end,
            "Europe/Oslo",
            str(probe.menu_item_id),
            probe.item_name,
            "NOK",
            "1",
            str(probe.amount),
        ),
    )
    assert probe_payment_rows == (
        (
            probe_start,
            probe_end,
            "Europe/Oslo",
            probe.lower_payment_order_number,
            "succeeded",
            probe_start,
            "NOK",
            str(probe.amount),
        ),
    )
    probe_start_token = _range_token(probe.start)
    probe_end_token = _range_token(probe.end)
    assert probe_orders_export.filename == (
        f"orders_{probe_start_token}_{probe_end_token}_all_all_all.csv"
    )
    assert probe_products_export.filename == (
        f"product-sales_{probe_start_token}_{probe_end_token}_all.csv"
    )
    assert probe_payments_export.filename == (
        f"payments_{probe_start_token}_{probe_end_token}_all.csv"
    )
    assert portfolio_plan.canonical_sha256 == EXPECTED_SHA256
    assert portfolio_plan.canonical_size_bytes == EXPECTED_SIZE
