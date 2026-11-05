"""Integration coverage for portfolio verification and demo-admin control."""

from __future__ import annotations

import re
from collections.abc import Generator
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.auth.demo_admin import DEMO_ADMIN_ID
from app.auth.models import User
from app.auth.roles import UserRole
from app.categories.models import Category
from app.demo import PortfolioSeedPlan, generate_portfolio_dataset
from app.menu.models import MenuItem
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.payments.models import Payment, StripeEvent
from app.portfolio_deployment import PortfolioDeploymentStateError, _run_with_engine
from app.restaurant_tables.models import RestaurantTable
from app.seed.portfolio import seed_portfolio_data

pytestmark = pytest.mark.integration

FIXED_REFERENCE_END = datetime(2026, 9, 23, tzinfo=ZoneInfo("Europe/Oslo"))
EXPECTED_SHA256 = "716200cc31feebe72a1dc237175e5c5780075bffa055a7086430dedb823bb9f3"
DML_PATTERN = re.compile(
    r"^(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b",
    re.IGNORECASE,
)
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
    """Generate and independently pin the canonical deployment plan."""
    plan = generate_portfolio_dataset(FIXED_REFERENCE_END)
    assert plan.canonical_sha256 == EXPECTED_SHA256
    return plan


def _clear_business_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        for model in reversed(BUSINESS_MODELS):
            connection.execute(delete(model))


@pytest.fixture(autouse=True)
def isolated_exact_portfolio(
    test_database_engine: Engine,
    deployment_plan: PortfolioSeedPlan,
) -> Generator[None, None, None]:
    """Create canonical data only in the disposable integration database."""
    assert test_database_engine.url.drivername == "postgresql+psycopg"
    assert test_database_engine.url.host in {"127.0.0.1", "localhost"}
    assert test_database_engine.url.port == 5433
    assert test_database_engine.url.database == "restaurant_ordering_analytics_test"
    _clear_business_tables(test_database_engine)
    factory = sessionmaker[Session](bind=test_database_engine, expire_on_commit=False)
    seeded = seed_portfolio_data(factory, deployment_plan)
    assert seeded.inserted is True
    try:
        yield
    finally:
        _clear_business_tables(test_database_engine)


def _run(engine: Engine, plan: PortfolioSeedPlan, action: str):
    username = engine.url.username
    database = engine.url.database
    assert username is not None
    assert database == "restaurant_ordering_analytics_test"
    return _run_with_engine(
        engine,
        action=action,  # type: ignore[arg-type]
        plan=None if action == "deactivate" else plan,
        expected_database_name=database,
        expected_login_role=username,
        verify_roles=False,
    )


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
        del conn, cursor, parameters, context, executemany
        statements.append(" ".join(statement.split()))

    return statements, capture


def _run_captured(engine: Engine, plan: PortfolioSeedPlan, action: str):
    statements, listener = _capture_statements(engine)
    event.listen(engine, "before_cursor_execute", listener)
    try:
        result = _run(engine, plan, action)
    finally:
        event.remove(engine, "before_cursor_execute", listener)
    return result, statements


def _dml(statements: list[str]) -> list[str]:
    return [statement for statement in statements if DML_PATTERN.search(statement)]


def test_verify_provision_and_deactivate_lifecycle_is_exact_and_idempotent(
    test_database_engine: Engine,
    deployment_plan: PortfolioSeedPlan,
) -> None:
    """Prove read-only verification and zero-DML exact write reruns."""
    verified, verify_statements = _run_captured(
        test_database_engine, deployment_plan, "verify-state"
    )
    assert verified.portfolio.inserted is False
    assert verified.portfolio.categories_processed == 5
    assert verified.portfolio.menu_items_processed == 15
    assert verified.portfolio.tables_processed == 12
    assert verified.portfolio.orders_processed == 500
    assert verified.portfolio.order_items_processed == 1_211
    assert verified.portfolio.status_history_processed == 2_326
    assert verified.portfolio.payments_processed == 484
    assert verified.demo_admin.status == "missing"
    assert _dml(verify_statements) == []
    assert verify_statements[0] == "SET TRANSACTION READ ONLY"

    provisioned, provision_statements = _run_captured(
        test_database_engine, deployment_plan, "provision"
    )
    assert provisioned.demo_admin.status == "provisioned"
    assert len(_dml(provision_statements)) == 1
    assert _dml(provision_statements)[0].upper().startswith("INSERT INTO USERS")

    repeated, repeat_statements = _run_captured(
        test_database_engine, deployment_plan, "provision"
    )
    assert repeated.demo_admin.status == "already_exact"
    assert _dml(repeat_statements) == []

    deactivated, deactivate_statements = _run_captured(
        test_database_engine, deployment_plan, "deactivate"
    )
    assert deactivated.demo_admin.status == "deactivated"
    assert len(_dml(deactivate_statements)) == 1
    assert _dml(deactivate_statements)[0].upper().startswith("UPDATE USERS")

    repeated_deactivate, repeat_deactivate_statements = _run_captured(
        test_database_engine, deployment_plan, "deactivate"
    )
    assert repeated_deactivate.demo_admin.status == "already_inactive"
    assert _dml(repeat_deactivate_statements) == []

    inactive, inactive_statements = _run_captured(
        test_database_engine, deployment_plan, "verify-state"
    )
    assert inactive.demo_admin.status == "inactive"
    assert _dml(inactive_statements) == []


def test_provision_and_deactivate_reject_identity_drift_without_repair(
    test_database_engine: Engine,
    deployment_plan: PortfolioSeedPlan,
) -> None:
    """Leave a drifted reserved identity unchanged for both write actions."""
    _run(test_database_engine, deployment_plan, "provision")
    with Session(test_database_engine) as session, session.begin():
        user = session.get(User, DEMO_ADMIN_ID)
        assert user is not None
        user.role = UserRole.SUPER_ADMIN

    for action in ("provision", "deactivate"):
        statements, listener = _capture_statements(test_database_engine)
        event.listen(test_database_engine, "before_cursor_execute", listener)
        try:
            with pytest.raises(PortfolioDeploymentStateError):
                _run(test_database_engine, deployment_plan, action)
        finally:
            event.remove(test_database_engine, "before_cursor_execute", listener)
        assert _dml(statements) == []

    with Session(test_database_engine) as session:
        stored = session.scalar(select(User).where(User.id == DEMO_ADMIN_ID))
        assert stored is not None
        assert stored.role is UserRole.SUPER_ADMIN
        assert stored.is_active is True


def test_deactivate_remains_available_during_unrelated_portfolio_drift(
    test_database_engine: Engine,
    deployment_plan: PortfolioSeedPlan,
) -> None:
    """Deactivate an exact account even when canonical dataset verification fails."""
    _run(test_database_engine, deployment_plan, "provision")
    with Session(test_database_engine) as session, session.begin():
        session.execute(
            delete(Payment).where(Payment.id == deployment_plan.payments[0].id)
        )

    result, statements = _run_captured(
        test_database_engine, deployment_plan, "deactivate"
    )

    assert result.portfolio is None
    assert result.demo_admin.status == "deactivated"
    assert len(_dml(statements)) == 1
    assert _dml(statements)[0].upper().startswith("UPDATE USERS")
    with Session(test_database_engine) as session:
        stored = session.get(User, DEMO_ADMIN_ID)
        assert stored is not None
        assert stored.is_active is False
