"""Isolated PostgreSQL acceptance for the manual runtime-data reset."""

from __future__ import annotations

import re
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Event, current_thread
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app import portfolio_deployment as deployment_operator
from app.auth.models import User
from app.auth.roles import UserRole
from app.categories.models import Category
from app.demo import PortfolioSeedPlan, generate_portfolio_dataset
from app.menu.models import MenuItem
from app.orders.creation import (
    PORTFOLIO_RUNTIME_ORDER_CAPACITY_LOCK_KEY,
    create_order,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.origins import OrderDataOrigin
from app.orders.runtime_reset import (
    PortfolioRuntimeResetDatabaseError,
    reset_portfolio_runtime_data,
)
from app.orders.schemas import OrderCreateRequest
from app.orders.statuses import OrderStatus
from app.payments.demo_checkout import build_demo_provider_idempotency_key
from app.payments.models import Payment, StripeEvent
from app.payments.statuses import PaymentStatus
from app.portfolio_deployment import PortfolioDeploymentStateError, _run_with_engine
from app.restaurant_tables.models import RestaurantTable
from app.seed.portfolio import (
    PortfolioSeedConflictError,
    seed_portfolio_data,
    verify_portfolio_data,
)

pytestmark = pytest.mark.integration

FIXED_REFERENCE_END = datetime(2026, 9, 23, tzinfo=ZoneInfo("Europe/Oslo"))
EXPECTED_SHA256 = "716200cc31feebe72a1dc237175e5c5780075bffa055a7086430dedb823bb9f3"
MODIFYING_PATTERN = re.compile(
    r"\b(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b",
    re.IGNORECASE,
)
ROW_LOCK_PATTERN = re.compile(
    r"\bFOR(?:\s+NO\s+KEY)?\s+UPDATE\b",
    re.IGNORECASE,
)
BUSINESS_MODELS: tuple[type[object], ...] = (
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
def reset_plan() -> PortfolioSeedPlan:
    """Generate the independently pinned canonical portfolio plan."""
    plan = generate_portfolio_dataset(FIXED_REFERENCE_END)
    assert plan.canonical_sha256 == EXPECTED_SHA256
    return plan


@pytest.fixture(autouse=True)
def exact_seed_only(
    test_database_engine: Engine,
    reset_plan: PortfolioSeedPlan,
) -> Generator[None, None, None]:
    """Start every reset case from the exact disposable canonical seed."""
    _clear_business_tables(test_database_engine)
    factory = _factory(test_database_engine)
    seeded = seed_portfolio_data(factory, reset_plan)
    assert seeded.inserted is True
    try:
        yield
    finally:
        _clear_business_tables(test_database_engine)


def _factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)


def _clear_business_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        for model in reversed(BUSINESS_MODELS):
            connection.execute(delete(model))


def _request(item_id: UUID) -> OrderCreateRequest:
    return OrderCreateRequest.model_validate(
        {
            "order_type": "takeaway",
            "items": [{"menu_item_id": str(item_id), "quantity": 2}],
        }
    )


def _create_order(
    factory: sessionmaker[Session],
    *,
    origin: OrderDataOrigin,
) -> Order:
    with factory() as session:
        item_id = session.scalars(select(MenuItem.id).order_by(MenuItem.id)).first()
    assert item_id is not None
    with factory() as session:
        response = create_order(session, _request(item_id), data_origin=origin)
    with factory() as session:
        order = session.scalar(
            select(Order).where(
                Order.public_order_number == response.public_order_number
            )
        )
        assert order is not None
        session.expunge(order)
        return order


def _add_demo_payment(
    factory: sessionmaker[Session],
    order_id: UUID,
    *,
    status: str = "failed",
    provider: str = "demo",
) -> UUID:
    payment_id = uuid4()
    with factory.begin() as session:
        order = session.get(Order, order_id)
        assert order is not None
        session.add(
            Payment(
                id=payment_id,
                order_id=order.id,
                status=status,
                amount=order.total_amount,
                currency=order.currency,
                request_idempotency_key=uuid4(),
                provider=provider,
                provider_idempotency_key=(
                    build_demo_provider_idempotency_key(payment_id)
                    if provider == "demo"
                    else f"stripe-test:{payment_id.hex}"
                ),
                provider_session_id=None,
                provider_checkout_url=None,
                provider_checkout_expires_at=None,
                succeeded_at=(datetime.now(UTC) if status == "succeeded" else None),
            )
        )
    return payment_id


def _run_reset(engine: Engine, plan: PortfolioSeedPlan):
    assert engine.url.database == "restaurant_ordering_analytics_test"
    assert engine.url.username is not None
    return _run_with_engine(
        engine,
        action="reset-runtime",
        plan=plan,
        expected_database_name=engine.url.database,
        expected_login_role=engine.url.username,
        verify_roles=False,
    )


def _capture_statements(engine: Engine):
    statements: list[tuple[str, object]] = []

    def capture(
        _connection: object,
        _cursor: object,
        statement: str,
        parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append((" ".join(statement.split()), parameters))

    return statements, capture


def _modifying(statements: list[tuple[str, object]]) -> list[str]:
    return [
        statement
        for statement, _ in statements
        if MODIFYING_PATTERN.search(ROW_LOCK_PATTERN.sub("FOR ROW LOCK", statement))
    ]


def _nonruntime_snapshot(
    factory: sessionmaker[Session],
) -> tuple[tuple[object, ...], ...]:
    with factory() as session:
        orders = tuple(
            session.execute(
                select(*Order.__table__.columns)
                .where(Order.data_origin != OrderDataOrigin.PORTFOLIO_RUNTIME.value)
                .order_by(Order.id)
            ).all()
        )
        items = tuple(
            session.execute(
                select(*OrderItem.__table__.columns)
                .join(Order, Order.id == OrderItem.order_id)
                .where(Order.data_origin != OrderDataOrigin.PORTFOLIO_RUNTIME.value)
                .order_by(OrderItem.id)
            ).all()
        )
        history = tuple(
            session.execute(
                select(*OrderStatusHistory.__table__.columns)
                .join(Order, Order.id == OrderStatusHistory.order_id)
                .where(Order.data_origin != OrderDataOrigin.PORTFOLIO_RUNTIME.value)
                .order_by(OrderStatusHistory.id)
            ).all()
        )
        payments = tuple(
            session.execute(
                select(*Payment.__table__.columns)
                .join(Order, Order.id == Payment.order_id)
                .where(Order.data_origin != OrderDataOrigin.PORTFOLIO_RUNTIME.value)
                .order_by(Payment.id)
            ).all()
        )
        events = tuple(session.execute(select(*StripeEvent.__table__.columns)).all())
    return orders + items + history + payments + events


def test_reset_deletes_only_validated_runtime_rows_and_empty_rerun_has_zero_dml(
    test_database_engine: Engine,
    reset_plan: PortfolioSeedPlan,
) -> None:
    """Preserve seed/live bytes and perform exact child-first runtime deletion."""
    factory = _factory(test_database_engine)
    _create_order(factory, origin=OrderDataOrigin.PORTFOLIO_RUNTIME)
    second = _create_order(factory, origin=OrderDataOrigin.PORTFOLIO_RUNTIME)
    with factory.begin() as session:
        session.add_all(
            [
                OrderStatusHistory(
                    order_id=second.id,
                    sequence=1,
                    previous_status=OrderStatus.CREATED.value,
                    new_status=OrderStatus.ACCEPTED.value,
                ),
                OrderStatusHistory(
                    order_id=second.id,
                    sequence=2,
                    previous_status=OrderStatus.ACCEPTED.value,
                    new_status=OrderStatus.PREPARING.value,
                ),
            ]
        )
        session.execute(
            update(Order)
            .where(Order.id == second.id)
            .values(status=OrderStatus.PREPARING.value)
        )
    _add_demo_payment(factory, second.id, status=PaymentStatus.SUCCEEDED.value)
    for _ in range(2):
        _add_demo_payment(factory, second.id)
    live = _create_order(factory, origin=OrderDataOrigin.LIVE)
    live_payment_id = _add_demo_payment(
        factory,
        live.id,
        provider="stripe_test",
    )
    with factory.begin() as session:
        session.add(
            StripeEvent(
                stripe_event_id=f"evt_{uuid4().hex}",
                event_type="checkout.session.expired",
                livemode=False,
                stripe_created_at=datetime.now(UTC),
                stripe_checkout_session_id=f"cs_test_{uuid4().hex}",
                payment_id=live_payment_id,
                processing_result="already_applied",
            )
        )
    before = _nonruntime_snapshot(factory)
    statements, listener = _capture_statements(test_database_engine)
    event.listen(test_database_engine, "before_cursor_execute", listener)
    try:
        result = _run_reset(test_database_engine, reset_plan)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", listener)

    assert result.runtime_reset is not None
    assert result.runtime_reset.orders_deleted == 2
    assert result.runtime_reset.order_items_deleted == 2
    assert result.runtime_reset.status_history_deleted == 4
    assert result.runtime_reset.payments_deleted == 3
    assert _nonruntime_snapshot(factory) == before
    verify_portfolio_data(factory, reset_plan)
    deletes = [
        statement
        for statement in _modifying(statements)
        if "DELETE" in statement.upper()
    ]
    assert [statement.split()[2].removeprefix("public.") for statement in deletes] == [
        "payments",
        "order_status_history",
        "order_items",
        "orders",
    ]

    repeated_statements, repeated_listener = _capture_statements(test_database_engine)
    event.listen(test_database_engine, "before_cursor_execute", repeated_listener)
    try:
        repeated = _run_reset(test_database_engine, reset_plan)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", repeated_listener)
    assert repeated.runtime_reset is not None
    assert repeated.runtime_reset.already_empty is True
    assert _modifying(repeated_statements) == []
    assert _nonruntime_snapshot(factory) == before


@pytest.mark.parametrize(
    "drift",
    (
        "owner",
        "stripe-payment",
        "pending-payment",
        "four-payments",
        "stripe-event",
        "missing-history",
        "item-total",
        "history-chain",
        "accepted-without-payment",
        "cancelled-with-succeeded",
    ),
)
def test_reset_refuses_runtime_drift_without_dml(
    test_database_engine: Engine,
    reset_plan: PortfolioSeedPlan,
    drift: str,
) -> None:
    """Fail closed for ownership, payment, receipt, and aggregate drift."""
    factory = _factory(test_database_engine)
    runtime = _create_order(factory, origin=OrderDataOrigin.PORTFOLIO_RUNTIME)
    with factory.begin() as session:
        if drift == "owner":
            user = User(
                email=f"runtime-owner-{uuid4().hex}@example.com",
                password_hash="synthetic-runtime-owner-password-hash",
                role=UserRole.CUSTOMER,
                is_active=True,
            )
            session.add(user)
            session.flush()
            session.execute(
                update(Order)
                .where(Order.id == runtime.id)
                .values(customer_user_id=user.id)
            )
        elif drift == "missing-history":
            session.execute(
                delete(OrderStatusHistory).where(
                    OrderStatusHistory.order_id == runtime.id
                )
            )
        elif drift == "item-total":
            session.execute(
                update(Order)
                .where(Order.id == runtime.id)
                .values(total_amount=runtime.total_amount + 1)
            )
        elif drift in {
            "history-chain",
            "accepted-without-payment",
            "cancelled-with-succeeded",
        }:
            target_status = {
                "history-chain": "preparing",
                "accepted-without-payment": "accepted",
                "cancelled-with-succeeded": "cancelled",
            }[drift]
            session.add(
                OrderStatusHistory(
                    order_id=runtime.id,
                    sequence=1,
                    previous_status="created",
                    new_status=target_status,
                )
            )
            session.execute(
                update(Order).where(Order.id == runtime.id).values(status=target_status)
            )
    if drift in {
        "stripe-payment",
        "pending-payment",
        "stripe-event",
        "cancelled-with-succeeded",
    }:
        payment_id = _add_demo_payment(
            factory,
            runtime.id,
            status=(
                "pending"
                if drift == "pending-payment"
                else "succeeded" if drift == "cancelled-with-succeeded" else "failed"
            ),
            provider=("stripe_test" if drift == "stripe-payment" else "demo"),
        )
        if drift == "stripe-event":
            with factory.begin() as session:
                session.add(
                    StripeEvent(
                        stripe_event_id=f"evt_{uuid4().hex}",
                        event_type="checkout.session.expired",
                        livemode=False,
                        stripe_created_at=datetime.now(UTC),
                        stripe_checkout_session_id=f"cs_test_{uuid4().hex}",
                        payment_id=payment_id,
                        processing_result="already_applied",
                    )
                )
    elif drift == "four-payments":
        for _ in range(4):
            _add_demo_payment(factory, runtime.id)

    before = _nonruntime_snapshot(factory)
    statements, listener = _capture_statements(test_database_engine)
    event.listen(test_database_engine, "before_cursor_execute", listener)
    try:
        with pytest.raises(PortfolioDeploymentStateError):
            _run_reset(test_database_engine, reset_plan)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", listener)
    assert _modifying(statements) == []
    assert _nonruntime_snapshot(factory) == before
    with factory() as session:
        assert session.get(Order, runtime.id) is not None


def test_reset_refuses_unexpected_incoming_foreign_key_without_dml(
    test_database_engine: Engine,
    reset_plan: PortfolioSeedPlan,
) -> None:
    """Reject a changed reset-relevant FK graph before deleting runtime rows."""
    factory = _factory(test_database_engine)
    runtime = _create_order(factory, origin=OrderDataOrigin.PORTFOLIO_RUNTIME)
    with test_database_engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE public.runtime_reset_fk_probe ("
                "id uuid PRIMARY KEY, "
                "order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT"
                ")"
            )
        )

    statements, listener = _capture_statements(test_database_engine)
    event.listen(test_database_engine, "before_cursor_execute", listener)
    try:
        with pytest.raises(PortfolioDeploymentStateError):
            _run_reset(test_database_engine, reset_plan)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", listener)
        with test_database_engine.begin() as connection:
            connection.execute(text("DROP TABLE public.runtime_reset_fk_probe"))

    assert _modifying(statements) == []
    with factory() as session:
        assert session.get(Order, runtime.id) is not None


def test_reset_refuses_seed_drift_before_runtime_dml(
    test_database_engine: Engine,
    reset_plan: PortfolioSeedPlan,
) -> None:
    """Require the canonical seed before acquiring reset deletion authority."""
    factory = _factory(test_database_engine)
    runtime = _create_order(factory, origin=OrderDataOrigin.PORTFOLIO_RUNTIME)
    with factory.begin() as session:
        session.execute(delete(Payment).where(Payment.id == reset_plan.payments[0].id))
    statements, listener = _capture_statements(test_database_engine)
    event.listen(test_database_engine, "before_cursor_execute", listener)
    try:
        with pytest.raises(PortfolioDeploymentStateError):
            _run_reset(test_database_engine, reset_plan)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", listener)
    assert _modifying(statements) == []
    with factory() as session:
        assert session.get(Order, runtime.id) is not None


def test_failure_after_deletes_rolls_back_every_runtime_row(
    test_database_engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Roll back child-first DELETE statements when final verification fails."""
    from app.orders import runtime_reset

    factory = _factory(test_database_engine)
    runtime = _create_order(factory, origin=OrderDataOrigin.PORTFOLIO_RUNTIME)
    original = runtime_reset._require_runtime_rows_absent

    def fail_after_verification(*args: object, **kwargs: object) -> None:
        original(*args, **kwargs)
        raise SQLAlchemyError("synthetic final verification failure")

    monkeypatch.setattr(
        runtime_reset,
        "_require_runtime_rows_absent",
        fail_after_verification,
    )
    with factory() as session:
        with pytest.raises(PortfolioRuntimeResetDatabaseError):
            reset_portfolio_runtime_data(session)
    with factory() as session:
        assert session.get(Order, runtime.id) is not None
        assert (
            session.scalar(select(OrderItem).where(OrderItem.order_id == runtime.id))
            is not None
        )
        assert (
            session.scalar(
                select(OrderStatusHistory).where(
                    OrderStatusHistory.order_id == runtime.id
                )
            )
            is not None
        )


def test_post_reset_operator_check_failure_rolls_back_outer_transaction(
    test_database_engine: Engine,
    reset_plan: PortfolioSeedPlan,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep reset DELETEs uncommitted through the operator's final seed check."""
    factory = _factory(test_database_engine)
    runtime = _create_order(factory, origin=OrderDataOrigin.PORTFOLIO_RUNTIME)
    payment_id = _add_demo_payment(factory, runtime.id)
    nonruntime_before = _nonruntime_snapshot(factory)
    original_verify = deployment_operator.verify_portfolio_data
    verify_calls = 0

    def fail_second_verify(
        supplied_factory: sessionmaker[Session],
        supplied_plan: PortfolioSeedPlan,
    ):
        nonlocal verify_calls
        result = original_verify(supplied_factory, supplied_plan)
        verify_calls += 1
        if verify_calls == 2:
            raise PortfolioSeedConflictError
        return result

    monkeypatch.setattr(
        deployment_operator,
        "verify_portfolio_data",
        fail_second_verify,
    )

    with pytest.raises(PortfolioDeploymentStateError):
        _run_reset(test_database_engine, reset_plan)

    assert verify_calls == 2
    assert _nonruntime_snapshot(factory) == nonruntime_before
    with factory() as session:
        assert session.get(Order, runtime.id) is not None
        assert (
            session.scalar(select(OrderItem).where(OrderItem.order_id == runtime.id))
            is not None
        )
        assert (
            session.scalar(
                select(OrderStatusHistory).where(
                    OrderStatusHistory.order_id == runtime.id
                )
            )
            is not None
        )
        assert session.get(Payment, payment_id) is not None


@pytest.mark.parametrize("first_actor", ("reset", "create"))
def test_reset_and_runtime_creation_share_one_linearization_lock(
    test_database_engine: Engine,
    reset_plan: PortfolioSeedPlan,
    first_actor: str,
) -> None:
    """Prove both reset/create orderings share the exact advisory lock."""
    factory = _factory(test_database_engine)
    existing = _create_order(factory, origin=OrderDataOrigin.PORTFOLIO_RUNTIME)
    with factory() as session:
        item_id = session.scalars(select(MenuItem.id).order_by(MenuItem.id)).first()
    assert item_id is not None
    first_locked = Event()
    second_attempted = Event()
    release_first = Event()
    lock_parameters: dict[str, list[object]] = {"reset": [], "create": []}

    def is_capacity_lock(statement: str) -> bool:
        return "pg_advisory_xact_lock" in statement.lower()

    def before(
        _connection: object,
        _cursor: object,
        statement: str,
        parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        actor = "reset" if current_thread().name.startswith("reset") else "create"
        if is_capacity_lock(statement) and current_thread().name.startswith(
            ("reset", "create")
        ):
            lock_parameters[actor].append(parameters)
            if actor != first_actor:
                second_attempted.set()

    def after(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        actor = "reset" if current_thread().name.startswith("reset") else "create"
        if actor == first_actor and is_capacity_lock(statement):
            first_locked.set()
            if not release_first.wait(timeout=10):
                raise RuntimeError("Timed out while holding the capacity lock")

    def run_reset() -> object:
        return _run_reset(test_database_engine, reset_plan)

    def run_create() -> object:
        with factory() as session:
            return create_order(
                session,
                _request(item_id),
                data_origin=OrderDataOrigin.PORTFOLIO_RUNTIME,
            )

    first_callable = run_reset if first_actor == "reset" else run_create
    second_callable = run_create if first_actor == "reset" else run_reset
    event.listen(test_database_engine, "before_cursor_execute", before)
    event.listen(test_database_engine, "after_cursor_execute", after)
    try:
        with ThreadPoolExecutor(
            max_workers=1, thread_name_prefix=first_actor
        ) as first_pool:
            first = first_pool.submit(first_callable)
            assert first_locked.wait(timeout=10)
            second_name = "create" if first_actor == "reset" else "reset"
            with ThreadPoolExecutor(
                max_workers=1, thread_name_prefix=second_name
            ) as second_pool:
                second = second_pool.submit(second_callable)
                assert second_attempted.wait(timeout=10)
                assert not second.done()
                release_first.set()
                first.result(timeout=20)
                second.result(timeout=20)
    finally:
        release_first.set()
        event.remove(test_database_engine, "after_cursor_execute", after)
        event.remove(test_database_engine, "before_cursor_execute", before)

    expected_parameters = {"lock_key": PORTFOLIO_RUNTIME_ORDER_CAPACITY_LOCK_KEY}
    assert lock_parameters == {
        "reset": [expected_parameters],
        "create": [expected_parameters],
    }
    with factory() as session:
        runtime_ids = set(
            session.scalars(
                select(Order.id).where(
                    Order.data_origin == OrderDataOrigin.PORTFOLIO_RUNTIME.value
                )
            ).all()
        )
    if first_actor == "reset":
        assert existing.id not in runtime_ids
        assert len(runtime_ids) == 1
    else:
        assert runtime_ids == set()
