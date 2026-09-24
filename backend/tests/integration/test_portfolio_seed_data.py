"""Integration tests for atomic deterministic portfolio persistence."""

from __future__ import annotations

import hashlib
import re
import uuid
from collections.abc import Generator
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import delete, event, func, insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.roles import UserRole
from app.categories.models import Category
from app.database.session import create_session_factory
from app.demo import generate_portfolio_dataset
from app.demo.dataset import PortfolioSeedPlan
from app.menu.models import MenuItem
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.payments.models import Payment, StripeEvent
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
