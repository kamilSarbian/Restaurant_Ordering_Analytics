"""Integration tests for the protected deployment portfolio seed runner."""

from __future__ import annotations

import re
from collections.abc import Generator
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import delete, event, func, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.analytics.service import get_analytics_overview
from app.auth.demo_admin import (
    DEMO_ADMIN_DISABLED_PASSWORD_HASH,
    DEMO_ADMIN_EMAIL,
    DEMO_ADMIN_ID,
)
from app.auth.models import User
from app.auth.roles import UserRole
from app.categories.models import Category
from app.demo import PortfolioSeedPlan, generate_portfolio_dataset
from app.menu.models import MenuItem
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.payments.models import Payment, StripeEvent
from app.payments.providers import PaymentProvider
from app.payments.statuses import PaymentStatus
from app.restaurant_tables.models import RestaurantTable
from app.seed.deployment import (
    DeploymentSeedConflictError,
    DeploymentSeedTargetError,
    _run_with_engine,
)
from app.seed.portfolio import PortfolioSeedResult

pytestmark = pytest.mark.integration

FIXED_REFERENCE_END = datetime(2026, 9, 23, tzinfo=ZoneInfo("Europe/Oslo"))
EXPECTED_SHA256 = "716200cc31feebe72a1dc237175e5c5780075bffa055a7086430dedb823bb9f3"
DML_PATTERN = re.compile(r"\b(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b", re.IGNORECASE)
BUSINESS_MODELS: tuple[type[Any], ...] = (
    Category,
    MenuItem,
    RestaurantTable,
    User,
    Order,
    OrderItem,
    OrderStatusHistory,
    Payment,
    StripeEvent,
)


@pytest.fixture(scope="module")
def deployment_plan() -> PortfolioSeedPlan:
    """Generate and independently pin the canonical deployment candidate plan."""
    plan = generate_portfolio_dataset(FIXED_REFERENCE_END)
    assert plan.canonical_sha256 == EXPECTED_SHA256
    return plan


def _clear_business_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        for model in reversed(BUSINESS_MODELS):
            connection.execute(delete(model))


@pytest.fixture(autouse=True)
def isolated_empty_database(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Constrain every write to the migrated disposable integration database."""
    assert test_database_engine.url.drivername == "postgresql+psycopg"
    assert test_database_engine.url.host in {"127.0.0.1", "localhost"}
    assert test_database_engine.url.port == 5433
    assert test_database_engine.url.database == "restaurant_ordering_analytics_test"
    _clear_business_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_business_tables(test_database_engine)


def _expected_login_role(engine: Engine) -> str:
    username = engine.url.username
    assert username is not None
    return username


def _run(engine: Engine, plan: PortfolioSeedPlan) -> PortfolioSeedResult:
    return _run_with_engine(
        engine,
        plan=plan,
        expected_database_name="restaurant_ordering_analytics_test",
        expected_login_role=_expected_login_role(engine),
    )


def _snapshot(engine: Engine) -> tuple[tuple[str, tuple[tuple[object, ...], ...]], ...]:
    snapshots: list[tuple[str, tuple[tuple[object, ...], ...]]] = []
    with Session(engine) as session:
        for model in BUSINESS_MODELS:
            table = model.__table__
            rows = session.execute(select(*table.c).order_by(table.c.id.asc())).all()
            snapshots.append((table.name, tuple(tuple(row) for row in rows)))
    return tuple(snapshots)


def _capture_statements(engine: Engine) -> tuple[list[str], object]:
    statements: list[str] = []

    def capture(
        conn: object,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        statements.append(" ".join(statement.split()))

    return statements, capture


def _assert_no_dml(statements: list[str]) -> None:
    assert statements
    assert all(DML_PATTERN.search(statement) is None for statement in statements)


def test_deployment_runner_persists_counts_analytics_and_exact_no_op(
    test_database_engine: Engine,
    deployment_plan: PortfolioSeedPlan,
) -> None:
    """Persist all canonical rows and prove an analytics-correct zero-DML rerun."""
    first = _run(test_database_engine, deployment_plan)

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
    with Session(test_database_engine) as session:
        assert session.scalar(select(func.count()).select_from(Order)) == 500
        assert session.scalar(select(func.count()).select_from(Payment)) == 484
        assert (
            session.scalar(
                select(func.count())
                .select_from(Payment)
                .where(Payment.status == PaymentStatus.SUCCEEDED)
            )
            == 449
        )
        assert session.scalar(select(func.count()).select_from(StripeEvent)) == 0

        overview = get_analytics_overview(
            session,
            current_user=User(
                id=DEMO_ADMIN_ID,
                email=DEMO_ADMIN_EMAIL,
                password_hash=DEMO_ADMIN_DISABLED_PASSWORD_HASH,
                role=UserRole.ADMIN,
                is_active=True,
            ),
            portfolio_demo_mode=True,
            payment_provider=PaymentProvider.DEMO.value,
            start=deployment_plan.metadata.window_start_utc,
            end=deployment_plan.metadata.reference_end_utc,
            currency=None,
        )
    assert len(overview.currencies) == 1
    assert overview.currencies[0].currency == "NOK"
    assert overview.currencies[0].collected_revenue_amount == 31_542_500
    assert overview.currencies[0].succeeded_orders_count == 449
    assert overview.currencies[0].average_order_value_amount == 70_251

    before = _snapshot(test_database_engine)
    statements, listener = _capture_statements(test_database_engine)
    event.listen(test_database_engine, "before_cursor_execute", listener)
    try:
        second = _run(test_database_engine, deployment_plan)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", listener)

    assert second.inserted is False
    _assert_no_dml(statements)
    assert _snapshot(test_database_engine) == before


def test_deployment_runner_rejects_partial_data_without_repair(
    test_database_engine: Engine,
    deployment_plan: PortfolioSeedPlan,
) -> None:
    """Reject a missing canonical Payment without repairing any persisted row."""
    _run(test_database_engine, deployment_plan)
    with Session(test_database_engine) as session, session.begin():
        session.execute(
            delete(Payment).where(Payment.id == deployment_plan.payments[0].id)
        )
    partial = _snapshot(test_database_engine)

    statements, listener = _capture_statements(test_database_engine)
    event.listen(test_database_engine, "before_cursor_execute", listener)
    try:
        with pytest.raises(DeploymentSeedConflictError):
            _run(test_database_engine, deployment_plan)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", listener)

    _assert_no_dml(statements)
    assert _snapshot(test_database_engine) == partial


def test_deployment_runner_rejects_wrong_target_before_dml(
    test_database_engine: Engine,
    deployment_plan: PortfolioSeedPlan,
) -> None:
    """Reject a mismatched database identity before any portfolio write."""
    statements, listener = _capture_statements(test_database_engine)
    event.listen(test_database_engine, "before_cursor_execute", listener)
    try:
        with pytest.raises(DeploymentSeedTargetError):
            _run_with_engine(
                test_database_engine,
                plan=deployment_plan,
                expected_database_name="wrong_database",
                expected_login_role=_expected_login_role(test_database_engine),
            )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", listener)

    _assert_no_dml(statements)
    assert _snapshot(test_database_engine) == tuple(
        (model.__table__.name, ()) for model in BUSINESS_MODELS
    )
