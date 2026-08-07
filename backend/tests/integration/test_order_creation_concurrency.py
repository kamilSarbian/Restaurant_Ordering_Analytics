"""PostgreSQL concurrency tests for shared order-creation locks."""

from __future__ import annotations

from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, current_thread
from uuid import UUID, uuid4

import pytest
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.categories.models import Category
from app.database.session import create_session_factory
from app.menu.models import MenuItem
from app.orders.creation import create_order
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.schemas import OrderCreateRequest
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def empty_concurrency_tables(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    _clear_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_tables(test_database_engine)


@pytest.fixture
def concurrency_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    return create_session_factory(test_database_engine)


@pytest.fixture
def source_records(
    concurrency_session_factory: sessionmaker[Session],
) -> tuple[UUID, UUID]:
    with concurrency_session_factory.begin() as session:
        category = Category(name=f"Concurrency {uuid4().hex}")
        item = MenuItem(
            category=category,
            name="Locked Item",
            price_amount=1000,
            cost_amount=400,
            currency="NOK",
            is_active=True,
            is_available=True,
        )
        session.add_all([category, item])
        session.flush()
        return item.id, category.id


def _clear_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))
        connection.execute(delete(RestaurantTable))
        connection.execute(delete(MenuItem))
        connection.execute(delete(Category))


def _request(item_id: UUID, *, table_number: int | None = None) -> OrderCreateRequest:
    payload: dict[str, object] = {
        "order_type": "takeaway" if table_number is None else "dine_in",
        "items": [{"menu_item_id": str(item_id), "quantity": 2}],
    }
    if table_number is not None:
        payload["table_number"] = table_number
    return OrderCreateRequest.model_validate(payload)


def _install_lock_pause(
    engine: Engine,
    *,
    expected_table: str,
    locked: Event,
    release: Event,
) -> object:
    def pause_after_lock(*args: object) -> None:
        statement = str(args[2])
        if (
            current_thread().name.startswith("creator")
            and expected_table in statement
            and "FOR SHARE" in statement
        ):
            locked.set()
            if not release.wait(timeout=10):
                raise RuntimeError("Timed out waiting to release creation lock")

    event.listen(engine, "after_cursor_execute", pause_after_lock)
    return pause_after_lock


def test_menu_update_waits_for_creation_shared_lock(
    test_database_engine: Engine,
    concurrency_session_factory: sessionmaker[Session],
    source_records: tuple[UUID, UUID],
) -> None:
    item_id, _ = source_records
    locked = Event()
    release = Event()
    listener = _install_lock_pause(
        test_database_engine,
        expected_table="menu_items",
        locked=locked,
        release=release,
    )

    def create() -> object:
        with concurrency_session_factory() as session:
            return create_order(session, _request(item_id))

    try:
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="creator") as pool:
            future = pool.submit(create)
            assert locked.wait(timeout=10)
            with pytest.raises(DBAPIError):
                with concurrency_session_factory.begin() as session:
                    session.execute(text("SET LOCAL lock_timeout = '250ms'"))
                    session.execute(
                        update(MenuItem)
                        .where(MenuItem.id == item_id)
                        .values(price_amount=2000)
                    )
            release.set()
            response = future.result(timeout=10)
    finally:
        release.set()
        event.remove(test_database_engine, "after_cursor_execute", listener)

    assert response.total_amount == 2000
    with concurrency_session_factory.begin() as session:
        session.execute(
            update(MenuItem).where(MenuItem.id == item_id).values(price_amount=2000)
        )
    with concurrency_session_factory() as session:
        assert session.scalars(select(OrderItem)).one().unit_price_amount == 1000


def test_two_creations_share_read_locks_without_global_serialization(
    concurrency_session_factory: sessionmaker[Session],
    source_records: tuple[UUID, UUID],
) -> None:
    item_id, _ = source_records
    barrier = Barrier(2)

    def create() -> str:
        barrier.wait(timeout=10)
        with concurrency_session_factory() as session:
            return create_order(session, _request(item_id)).public_order_number

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(create) for _ in range(2)]
        numbers = [future.result(timeout=10) for future in futures]
    assert len(set(numbers)) == 2
    with concurrency_session_factory() as session:
        assert len(session.scalars(select(Order)).all()) == 2


def test_table_update_waits_for_dine_in_creation_shared_lock(
    test_database_engine: Engine,
    concurrency_session_factory: sessionmaker[Session],
    source_records: tuple[UUID, UUID],
) -> None:
    item_id, _ = source_records
    with concurrency_session_factory.begin() as session:
        table = RestaurantTable(number=4, is_active=True)
        session.add(table)
        session.flush()
        table_id = table.id
    locked = Event()
    release = Event()
    listener = _install_lock_pause(
        test_database_engine,
        expected_table="restaurant_tables",
        locked=locked,
        release=release,
    )

    def create() -> object:
        with concurrency_session_factory() as session:
            return create_order(session, _request(item_id, table_number=4))

    try:
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="creator") as pool:
            future = pool.submit(create)
            assert locked.wait(timeout=10)
            with pytest.raises(DBAPIError):
                with concurrency_session_factory.begin() as session:
                    session.execute(text("SET LOCAL lock_timeout = '250ms'"))
                    session.execute(
                        update(RestaurantTable)
                        .where(RestaurantTable.id == table_id)
                        .values(number=8)
                    )
            release.set()
            response = future.result(timeout=10)
    finally:
        release.set()
        event.remove(test_database_engine, "after_cursor_execute", listener)

    assert response.table_number == 4
    with concurrency_session_factory.begin() as session:
        session.execute(
            update(RestaurantTable)
            .where(RestaurantTable.id == table_id)
            .values(number=8)
        )
    with concurrency_session_factory() as session:
        assert session.scalars(select(Order)).one().table_number_snapshot == 4


def test_dine_in_locked_select_order_is_table_then_menu(
    test_database_engine: Engine,
    concurrency_session_factory: sessionmaker[Session],
    source_records: tuple[UUID, UUID],
) -> None:
    item_id, _ = source_records
    with concurrency_session_factory.begin() as session:
        session.add(RestaurantTable(number=4))
    locked_selects: list[str] = []

    def capture(*args: object) -> None:
        statement = str(args[2])
        if statement.lstrip().upper().startswith("SELECT") and "FOR SHARE" in statement:
            locked_selects.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture)
    try:
        with concurrency_session_factory() as session:
            create_order(session, _request(item_id, table_number=4))
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    assert len(locked_selects) == 2
    assert "restaurant_tables" in locked_selects[0]
    assert "menu_items" in locked_selects[1]
    assert "categories" in locked_selects[1]
    assert "FOR UPDATE" not in " ".join(locked_selects)
