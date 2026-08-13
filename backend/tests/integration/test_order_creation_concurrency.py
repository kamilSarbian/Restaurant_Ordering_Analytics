"""PostgreSQL concurrency tests for shared order-creation locks."""

from __future__ import annotations

from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, current_thread
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.service import UserTokenService
from app.categories.models import Category
from app.core.config import Settings
from app.core.rate_limit import FixedWindowRateLimiter
from app.database.session import create_session_factory
from app.main import create_app
from app.menu.models import MenuItem
from app.orders.access import hash_order_access_token
from app.orders.creation import create_order
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.schemas import OrderCreateRequest
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration

CREATE_PATH = "/api/v1/orders"
SYNTHETIC_SECRET = "c" * 32


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
        connection.execute(delete(User))
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


def _payload(item_id: UUID) -> dict[str, object]:
    return {
        "order_type": "takeaway",
        "items": [{"menu_item_id": str(item_id), "quantity": 2}],
    }


def _store_user(session_factory: sessionmaker[Session]) -> UUID:
    with session_factory.begin() as session:
        user = User(
            email=f"creation-concurrency-{uuid4().hex}@example.com",
            password_hash="synthetic-creation-concurrency-password-hash",
            role=UserRole.CUSTOMER,
            is_active=True,
        )
        session.add(user)
        session.flush()
        return user.id


def _application(
    session_factory: sessionmaker[Session],
    token_service: UserTokenService,
):
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
        ),
        session_factory=session_factory,
        user_token_service=token_service,
        order_creation_rate_limiter=FixedWindowRateLimiter(
            limit=10,
            window_seconds=60,
        ),
    )


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


def _is_menu_share_lock(statement: str) -> bool:
    normalized = " ".join(statement.upper().split())
    return (
        normalized.startswith("SELECT")
        and "MENU_ITEMS" in normalized
        and "FOR SHARE" in normalized
    )


def _install_creation_overlap_barrier(
    engine: Engine,
    barrier: Barrier,
) -> object:
    def wait_after_menu_lock(*args: object) -> None:
        if _is_menu_share_lock(str(args[2])):
            barrier.wait(timeout=10)

    event.listen(engine, "after_cursor_execute", wait_after_menu_lock)
    return wait_after_menu_lock


def _install_creation_pause(
    engine: Engine,
    *,
    transaction_open: Event,
    release: Event,
) -> object:
    def pause_after_menu_lock(*args: object) -> None:
        if _is_menu_share_lock(str(args[2])):
            transaction_open.set()
            if not release.wait(timeout=10):
                raise RuntimeError("Timed out waiting to release creation transaction")

    event.listen(engine, "after_cursor_execute", pause_after_menu_lock)
    return pause_after_menu_lock


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


def test_concurrent_authenticated_creations_keep_exact_owners_and_capabilities(
    test_database_engine: Engine,
    concurrency_session_factory: sessionmaker[Session],
    source_records: tuple[UUID, UUID],
) -> None:
    """Assign each concurrent aggregate to its initiating canonical User."""
    item_id, _ = source_records
    user_ids = [_store_user(concurrency_session_factory) for _ in range(2)]
    token_service = UserTokenService(SYNTHETIC_SECRET)
    application = _application(concurrency_session_factory, token_service)
    start_barrier = Barrier(2)
    transaction_barrier = Barrier(2)
    order_dml: list[str] = []

    def capture_order_dml(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        normalized = " ".join(statement.lower().split())
        if normalized.startswith(("insert into orders", "update orders")):
            order_dml.append(normalized)

    overlap_listener = _install_creation_overlap_barrier(
        test_database_engine,
        transaction_barrier,
    )
    event.listen(test_database_engine, "before_cursor_execute", capture_order_dml)
    try:
        with TestClient(
            application,
            client=("198.51.100.30", 50000),
        ) as test_client:

            def create_for(user_id: UUID):
                start_barrier.wait(timeout=10)
                return test_client.post(
                    CREATE_PATH,
                    json=_payload(item_id),
                    headers={
                        "Authorization": (
                            f"Bearer {token_service.create_access_token(user_id)}"
                        )
                    },
                )

            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [executor.submit(create_for, user_id) for user_id in user_ids]
                responses = [future.result(timeout=15) for future in futures]
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_order_dml)
        event.remove(test_database_engine, "after_cursor_execute", overlap_listener)

    assert [response.status_code for response in responses] == [201, 201]
    payloads = [response.json() for response in responses]
    assert len({payload["public_order_number"] for payload in payloads}) == 2
    assert len({payload["order_access_token"] for payload in payloads}) == 2

    with concurrency_session_factory() as session:
        orders = {
            order.public_order_number: order
            for order in session.scalars(select(Order)).all()
        }
        items = list(session.scalars(select(OrderItem)).all())
        history = list(session.scalars(select(OrderStatusHistory)).all())
    assert len(orders) == len(items) == len(history) == 2
    for user_id, payload in zip(user_ids, payloads, strict=True):
        order = orders[payload["public_order_number"]]
        assert order.customer_user_id == user_id
        assert order.order_access_token_hash == hash_order_access_token(
            payload["order_access_token"]
        )
        assert order.order_access_token_hash != payload["order_access_token"]

    inserts = [statement for statement in order_dml if statement.startswith("insert")]
    updates = [statement for statement in order_dml if statement.startswith("update")]
    assert len(inserts) == 2
    assert all("customer_user_id" in statement for statement in inserts)
    assert updates == []


def test_concurrent_guest_and_authenticated_creation_do_not_bleed_ownership(
    test_database_engine: Engine,
    concurrency_session_factory: sessionmaker[Session],
    source_records: tuple[UUID, UUID],
) -> None:
    """Keep guest NULL ownership isolated from a concurrent owned aggregate."""
    item_id, _ = source_records
    user_id = _store_user(concurrency_session_factory)
    token_service = UserTokenService(SYNTHETIC_SECRET)
    application = _application(concurrency_session_factory, token_service)
    start_barrier = Barrier(2)
    transaction_barrier = Barrier(2)
    overlap_listener = _install_creation_overlap_barrier(
        test_database_engine,
        transaction_barrier,
    )

    try:
        with TestClient(
            application,
            client=("198.51.100.31", 50000),
        ) as test_client:

            def create(kind: str):
                headers = (
                    {
                        "Authorization": (
                            f"Bearer {token_service.create_access_token(user_id)}"
                        )
                    }
                    if kind == "authenticated"
                    else {}
                )
                start_barrier.wait(timeout=10)
                return kind, test_client.post(
                    CREATE_PATH,
                    json=_payload(item_id),
                    headers=headers,
                )

            with ThreadPoolExecutor(max_workers=2) as executor:
                results = dict(executor.map(create, ("guest", "authenticated")))
    finally:
        event.remove(test_database_engine, "after_cursor_execute", overlap_listener)

    assert {kind: response.status_code for kind, response in results.items()} == {
        "guest": 201,
        "authenticated": 201,
    }
    guest_payload = results["guest"].json()
    authenticated_payload = results["authenticated"].json()
    with concurrency_session_factory() as session:
        orders = {
            order.public_order_number: order
            for order in session.scalars(select(Order)).all()
        }
    assert len(orders) == 2
    assert orders[guest_payload["public_order_number"]].customer_user_id is None
    assert (
        orders[authenticated_payload["public_order_number"]].customer_user_id == user_id
    )
    for payload in (guest_payload, authenticated_payload):
        order = orders[payload["public_order_number"]]
        assert order.order_access_token_hash == hash_order_access_token(
            payload["order_access_token"]
        )
        assert order.order_access_token_hash != payload["order_access_token"]


def test_invalid_auth_racing_valid_creation_leaves_no_partial_aggregate(
    test_database_engine: Engine,
    concurrency_session_factory: sessionmaker[Session],
    source_records: tuple[UUID, UUID],
) -> None:
    """Reject one invalid identity without affecting a concurrent valid owner."""
    item_id, _ = source_records
    user_id = _store_user(concurrency_session_factory)
    token_service = UserTokenService(SYNTHETIC_SECRET)
    application = _application(concurrency_session_factory, token_service)
    transaction_open = Event()
    release_valid = Event()
    pause_listener = _install_creation_pause(
        test_database_engine,
        transaction_open=transaction_open,
        release=release_valid,
    )

    try:
        with TestClient(
            application,
            client=("198.51.100.32", 50000),
        ) as test_client:

            def create_valid():
                return test_client.post(
                    CREATE_PATH,
                    json=_payload(item_id),
                    headers={
                        "Authorization": (
                            f"Bearer {token_service.create_access_token(user_id)}"
                        )
                    },
                )

            with ThreadPoolExecutor(max_workers=1) as executor:
                valid_future = executor.submit(create_valid)
                try:
                    assert transaction_open.wait(timeout=10)
                    invalid_response = test_client.post(
                        CREATE_PATH,
                        json=_payload(item_id),
                        headers={"Authorization": "Bearer malformed-token"},
                    )
                    assert valid_future.done() is False
                finally:
                    release_valid.set()
                valid_response = valid_future.result(timeout=15)
    finally:
        release_valid.set()
        event.remove(test_database_engine, "after_cursor_execute", pause_listener)

    assert invalid_response.status_code == 401
    assert invalid_response.json() == {"detail": "Invalid authentication credentials"}
    assert invalid_response.headers["WWW-Authenticate"] == "Bearer"
    assert valid_response.status_code == 201
    valid_payload = valid_response.json()
    with concurrency_session_factory() as session:
        orders = list(session.scalars(select(Order)).all())
        items = list(session.scalars(select(OrderItem)).all())
        history = list(session.scalars(select(OrderStatusHistory)).all())
    assert len(orders) == len(items) == len(history) == 1
    assert orders[0].customer_user_id == user_id
    assert orders[0].public_order_number == valid_payload["public_order_number"]
    assert orders[0].order_access_token_hash == hash_order_access_token(
        valid_payload["order_access_token"]
    )
