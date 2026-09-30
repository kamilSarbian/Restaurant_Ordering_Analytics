"""PostgreSQL concurrency tests for synchronous demo checkout."""

from __future__ import annotations

import re
import traceback
from collections.abc import Callable, Generator
from concurrent.futures import Future, ThreadPoolExecutor, wait
from datetime import UTC, datetime
from threading import Event, local
from time import monotonic
from uuid import UUID, uuid4

import pytest
from sqlalchemy import delete, event, select, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.demo_admin import (
    DEMO_ADMIN_DISABLED_PASSWORD_HASH,
    DEMO_ADMIN_EMAIL,
    DEMO_ADMIN_ID,
)
from app.auth.models import User
from app.auth.roles import UserRole
from app.database.session import create_session_factory
from app.orders.access import (
    generate_order_access_token,
    generate_public_order_number,
    hash_order_access_token,
)
from app.orders.admin_service import (
    AdminOrderActivePaymentError,
    AdminOrderCannotCancelError,
    AdminOrderInvalidTransitionError,
    transition_order_status,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.origins import OrderDataOrigin
from app.orders.statuses import OrderStatus
from app.payments import checkout
from app.payments.demo_checkout import checkout_demo_order
from app.payments.models import Payment, StripeEvent
from app.payments.providers import PaymentProvider
from app.payments.statuses import PaymentStatus

pytestmark = pytest.mark.integration

NOW = datetime(2026, 9, 28, 12, tzinfo=UTC)
SUCCESS_ID = UUID("00000000-0000-4000-8000-00000000000b")
FAILED_ID = UUID("00000000-0000-4000-8000-000000000095")
EXPIRED_ID = UUID("00000000-0000-4000-8000-000000000040")
WRITING_VERBS = frozenset({"INSERT", "UPDATE", "DELETE", "TRUNCATE", "MERGE"})
SYNTHETIC_DB_MARKER = "synthetic-demo-db-password-marker"
LOCK_WAIT_TIMEOUT_SECONDS = 5.0
WORKER_BARRIER_TIMEOUT_SECONDS = 15.0
LOCK_WAIT_POLL_SECONDS = 0.01
SQL_DOLLAR_QUOTE_PATTERN = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$")
DETECTOR_TEST_NAME = "test_data_writing_statement_detector_handles_adversarial_sql"


def _demo_status_admin() -> User:
    return User(
        id=DEMO_ADMIN_ID,
        email=DEMO_ADMIN_EMAIL,
        password_hash=DEMO_ADMIN_DISABLED_PASSWORD_HASH,
        role=UserRole.ADMIN,
        is_active=True,
    )


@pytest.fixture(autouse=True)
def empty_demo_tables(request: pytest.FixtureRequest) -> Generator[None, None, None]:
    """Keep demo concurrency tests isolated in the approved test database."""
    if getattr(request.node, "originalname", request.node.name) == DETECTOR_TEST_NAME:
        yield
        return
    test_database_engine = request.getfixturevalue("test_database_engine")
    if not isinstance(test_database_engine, Engine):
        raise AssertionError("Expected the guarded PostgreSQL integration engine")
    _clear_tables(test_database_engine)
    try:
        yield
    finally:
        _clear_tables(test_database_engine)


@pytest.fixture
def demo_session_factory(test_database_engine: Engine) -> sessionmaker[Session]:
    """Provide independent sessions for real PostgreSQL concurrency."""
    return create_session_factory(test_database_engine)


def _clear_tables(engine: Engine) -> None:
    with engine.begin() as connection:
        connection.execute(delete(StripeEvent))
        connection.execute(delete(Payment))
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))
        connection.execute(delete(User))


def _store_runtime_order(
    session_factory: sessionmaker[Session],
) -> tuple[UUID, str, str]:
    order_id = uuid4()
    public_number = generate_public_order_number()
    token = generate_order_access_token()
    with session_factory.begin() as session:
        order = Order(
            id=order_id,
            public_order_number=public_number,
            order_access_token_hash=hash_order_access_token(token),
            customer_user_id=None,
            order_type="takeaway",
            table_id=None,
            table_number_snapshot=None,
            status=OrderStatus.CREATED.value,
            data_origin=OrderDataOrigin.PORTFOLIO_RUNTIME.value,
            currency="NOK",
            subtotal_amount=53700,
            total_amount=53700,
        )
        session.add(order)
        session.add(
            OrderStatusHistory(
                order=order,
                sequence=0,
                previous_status=None,
                new_status=OrderStatus.CREATED.value,
            )
        )
    return order_id, public_number, token


def _run_demo(
    session_factory: sessionmaker[Session],
    *,
    public_number: str,
    token: str,
    request_key: UUID,
    payment_id: UUID,
    backend_pid_sink: Callable[[int], None] | None = None,
) -> checkout.CheckoutOutcome:
    with session_factory() as session:
        pid_listener = _backend_pid_listener(backend_pid_sink)
        if pid_listener is not None:
            event.listen(session, "after_begin", pid_listener)
        try:
            return checkout_demo_order(
                session,
                public_order_number=public_number,
                access_token=token,
                request_idempotency_key=request_key,
                payment_provider=PaymentProvider.DEMO.value,
                now_provider=lambda: NOW,
                payment_id_provider=lambda: payment_id,
            )
        finally:
            if pid_listener is not None:
                event.remove(session, "after_begin", pid_listener)


def _cancel(
    session_factory: sessionmaker[Session],
    public_number: str,
    *,
    backend_pid_sink: Callable[[int], None] | None = None,
) -> bool:
    with session_factory() as session:
        pid_listener = _backend_pid_listener(backend_pid_sink)
        if pid_listener is not None:
            event.listen(session, "after_begin", pid_listener)
        try:
            try:
                transition_order_status(
                    session,
                    public_order_number=public_number,
                    target_status=OrderStatus.CANCELLED,
                    current_user=_demo_status_admin(),
                    portfolio_demo_mode=True,
                    payment_provider=PaymentProvider.DEMO.value,
                )
            except (
                AdminOrderActivePaymentError,
                AdminOrderCannotCancelError,
                AdminOrderInvalidTransitionError,
            ):
                return False
        finally:
            if pid_listener is not None:
                event.remove(session, "after_begin", pid_listener)
    return True


def _backend_pid_listener(
    backend_pid_sink: Callable[[int], None] | None,
) -> Callable[[Session, object, Connection], None] | None:
    if backend_pid_sink is None:
        return None

    def record_backend_pid(
        _session: Session,
        _transaction: object,
        connection: Connection,
    ) -> None:
        value = connection.execute(text("SELECT pg_backend_pid()")).scalar_one()
        if not isinstance(value, int) or value <= 0:
            raise AssertionError("PostgreSQL returned an invalid backend PID")
        backend_pid_sink(value)

    return record_backend_pid


def _normalized(statement: str) -> str:
    return " ".join(statement.lower().split())


def _is_order_lock(statement: str) -> bool:
    normalized = _normalized(statement)
    return " from orders " in normalized and "for update" in normalized


def _sql_word_tokens(statement: str) -> tuple[tuple[str, ...], bool]:
    tokens: list[str] = []
    index = 0
    length = len(statement)
    while index < length:
        character = statement[index]
        if character.isspace():
            index += 1
            continue
        if statement.startswith("--", index):
            newline = statement.find("\n", index + 2)
            index = length if newline < 0 else newline + 1
            continue
        if statement.startswith("/*", index):
            depth = 1
            index += 2
            while index < length and depth:
                if statement.startswith("/*", index):
                    depth += 1
                    index += 2
                elif statement.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            if depth:
                return tuple(tokens), True
            continue
        if character in {"'", '"'}:
            quote = character
            index += 1
            closed = False
            while index < length:
                if statement[index] == quote:
                    if index + 1 < length and statement[index + 1] == quote:
                        index += 2
                        continue
                    index += 1
                    closed = True
                    break
                if quote == "'" and statement[index] == "\\":
                    index += 2
                else:
                    index += 1
            if not closed:
                return tuple(tokens), True
            continue
        if character == "$":
            delimiter_match = SQL_DOLLAR_QUOTE_PATTERN.match(statement, index)
            if delimiter_match is not None:
                delimiter = delimiter_match.group(0)
                closing = statement.find(delimiter, delimiter_match.end())
                if closing < 0:
                    return tuple(tokens), True
                index = closing + len(delimiter)
                continue
        if character.isalpha() or character == "_":
            end = index + 1
            while end < length and (
                statement[end].isalnum() or statement[end] in {"_", "$"}
            ):
                end += 1
            tokens.append(statement[index:end].upper())
            index = end
            continue
        index += 1
    return tuple(tokens), False


def _is_row_lock_update(tokens: tuple[str, ...], index: int) -> bool:
    if index >= 1 and tokens[index - 1] == "FOR":
        return True
    return index >= 3 and tokens[index - 3 : index] == ("FOR", "NO", "KEY")


def _is_data_writing_statement(statement: str) -> bool:
    tokens, ambiguous = _sql_word_tokens(statement)
    if ambiguous:
        return True
    for index, token in enumerate(tokens):
        if token not in WRITING_VERBS:
            continue
        if token == "UPDATE" and _is_row_lock_update(tokens, index):
            continue
        return True
    return False


@pytest.mark.parametrize(
    ("statement", "expected"),
    [
        ("UPDATE payments SET status = 'failed'", True),
        ("INSERT INTO payments (id) VALUES (1)", True),
        ("DELETE FROM payments", True),
        ("TRUNCATE payments", True),
        (
            "MERGE INTO payments USING staged ON false WHEN NOT MATCHED THEN INSERT DEFAULT VALUES",
            True,
        ),
        (
            "WITH changed AS (UPDATE payments SET status = 'failed' RETURNING *) "
            "SELECT * FROM changed",
            True,
        ),
        (
            "WITH chosen AS MATERIALIZED (SELECT 1) "
            "DELETE FROM payments WHERE id IN (SELECT * FROM chosen)",
            True,
        ),
        (
            "WITH locked AS (SELECT * FROM orders FOR UPDATE) " "SELECT * FROM locked",
            False,
        ),
        ("SELECT * FROM orders FOR UPDATE", False),
        ("SELECT * FROM orders FOR NO KEY UPDATE", False),
        (
            "SELECT 'UPDATE payments', $$DELETE FROM payments$$, "
            '"MERGE" FROM orders',
            False,
        ),
        (
            "SELECT 1 /* UPDATE payments SET status = 'failed' */ "
            "-- DELETE FROM payments\n",
            False,
        ),
        (
            "SELECT 1 /* outer DELETE /* inner UPDATE */ still comment */",
            False,
        ),
        ("SELECT 'unterminated", True),
    ],
)
def test_data_writing_statement_detector_handles_adversarial_sql(
    statement: str,
    expected: bool,
) -> None:
    """Detect direct and CTE writes without misclassifying row-locking SELECTs."""
    assert _is_data_writing_statement(statement) is expected


def _related_state_snapshot(
    engine: Engine,
    order_id: UUID,
) -> tuple[tuple[tuple[object, ...], ...], ...]:
    payment_ids = select(Payment.id).where(Payment.order_id == order_id)
    statements = (
        select(Order.__table__)
        .where(Order.id == order_id)
        .order_by(*tuple(Order.__table__.primary_key.columns)),
        select(Payment.__table__)
        .where(Payment.order_id == order_id)
        .order_by(*tuple(Payment.__table__.primary_key.columns)),
        select(OrderStatusHistory.__table__)
        .where(OrderStatusHistory.order_id == order_id)
        .order_by(*tuple(OrderStatusHistory.__table__.primary_key.columns)),
        select(StripeEvent.__table__)
        .where(StripeEvent.payment_id.in_(payment_ids))
        .order_by(*tuple(StripeEvent.__table__.primary_key.columns)),
    )
    with engine.connect() as connection:
        return tuple(
            tuple(tuple(row) for row in connection.execute(statement))
            for statement in statements
        )


def _wait_for_server_lock(
    engine: Engine,
    *,
    blocker_pid: int,
    waiter_pid: int,
) -> tuple[int, int, tuple[int, ...], str, str | None]:
    if blocker_pid == waiter_pid:
        raise AssertionError("Serialized workers unexpectedly share one backend PID")
    deadline = monotonic() + LOCK_WAIT_TIMEOUT_SECONDS
    last_observation: tuple[tuple[int, ...], str | None, str | None] | None = None
    poll_wait = Event()
    query = text("""
        SELECT
            pg_blocking_pids(waiter.pid) AS blocking_pids,
            waiter.wait_event_type,
            waiter.wait_event
        FROM pg_stat_activity AS waiter
        WHERE waiter.pid = :waiter_pid
          AND waiter.datname = current_database()
          AND EXISTS (
              SELECT 1
              FROM pg_stat_activity AS blocker
              WHERE blocker.pid = :blocker_pid
                AND blocker.datname = current_database()
          )
        """)
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as observer:
        while monotonic() < deadline:
            row = (
                observer.execute(
                    query,
                    {"blocker_pid": blocker_pid, "waiter_pid": waiter_pid},
                )
                .mappings()
                .one_or_none()
            )
            if row is not None:
                blocking_pids = tuple(int(value) for value in row["blocking_pids"])
                wait_event_type = row["wait_event_type"]
                wait_event = row["wait_event"]
                last_observation = (blocking_pids, wait_event_type, wait_event)
                if blocker_pid in blocking_pids and wait_event_type == "Lock":
                    return (
                        blocker_pid,
                        waiter_pid,
                        blocking_pids,
                        wait_event_type,
                        wait_event,
                    )
            poll_wait.wait(LOCK_WAIT_POLL_SECONDS)
    raise AssertionError(
        "PostgreSQL did not expose the expected blocker/waiter lock relation "
        f"before the deadline; last observation={last_observation!r}"
    )


def _assert_server_wait_observed(observations: dict[str, list[object]]) -> None:
    assert len(observations["server_waits"]) == 1
    evidence = observations["server_waits"][0]
    assert isinstance(evidence, tuple)
    blocker_pid, waiter_pid, blocking_pids, wait_event_type, _wait_event = evidence
    assert isinstance(blocker_pid, int)
    assert isinstance(waiter_pid, int)
    assert blocker_pid != waiter_pid
    assert isinstance(blocking_pids, tuple)
    assert blocker_pid in blocking_pids
    assert wait_event_type == "Lock"


def _submit_serialized_pair(
    engine: Engine,
    executor: ThreadPoolExecutor,
    first: Callable[[Callable[[int], None]], object],
    second: Callable[[Callable[[int], None]], object],
    *,
    snapshot_provider: Callable[[], object] | None = None,
) -> tuple[Future[object], Future[object], dict[str, list[object]], Callable[[], None]]:
    """Prove one PostgreSQL backend waits on another before serialization."""
    role = local()
    first_locked = Event()
    second_attempted = Event()
    second_locked = Event()
    release_first = Event()
    release_second = Event()
    backend_pids: dict[str, int] = {}
    observations: dict[str, list[object]] = {
        "connections": [],
        "second_statements": [],
        "server_waits": [],
        "state_before_second": [],
    }
    listeners_attached = True

    def before(
        connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        current_role = getattr(role, "value", None)
        if current_role == "second":
            observations["second_statements"].append(statement)
        if _is_order_lock(statement):
            observations["connections"].append((current_role, id(connection)))
            if current_role == "second":
                second_attempted.set()

    def after(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        current_role = getattr(role, "value", None)
        if current_role == "first" and _is_order_lock(statement):
            first_locked.set()
            assert release_first.wait(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)
        elif current_role == "second" and _is_order_lock(statement):
            second_locked.set()
            assert release_second.wait(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)

    def record_backend_pid(pid: int) -> None:
        current_role = getattr(role, "value", None)
        if current_role not in {"first", "second"}:
            raise AssertionError("Backend PID was reported outside a worker")
        existing = backend_pids.get(current_role)
        if existing is not None and existing != pid:
            raise AssertionError("One worker changed PostgreSQL backend PID")
        backend_pids[current_role] = pid

    def first_worker() -> object:
        role.value = "first"
        return first(record_backend_pid)

    def second_worker() -> object:
        role.value = "second"
        return second(record_backend_pid)

    def remove_listeners() -> None:
        nonlocal listeners_attached
        if not listeners_attached:
            return
        event.remove(engine, "before_cursor_execute", before)
        event.remove(engine, "after_cursor_execute", after)
        listeners_attached = False

    def join_workers(futures: tuple[Future[object], ...]) -> None:
        _done, unfinished = wait(
            futures,
            timeout=WORKER_BARRIER_TIMEOUT_SECONDS,
        )
        if unfinished:
            raise AssertionError("Serialized workers did not finish before cleanup")

    event.listen(engine, "before_cursor_execute", before)
    event.listen(engine, "after_cursor_execute", after)
    first_future = executor.submit(first_worker)
    second_future: Future[object] | None = None
    try:
        assert first_locked.wait(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)
        second_future = executor.submit(second_worker)
        assert second_attempted.wait(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)
        assert set(backend_pids) == {"first", "second"}
        observations["server_waits"].append(
            _wait_for_server_lock(
                engine,
                blocker_pid=backend_pids["first"],
                waiter_pid=backend_pids["second"],
            )
        )
        release_first.set()
        first_future.result(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)
        assert second_locked.wait(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)
        if snapshot_provider is not None:
            observations["state_before_second"].append(snapshot_provider())
        release_second.set()
    except BaseException:
        release_first.set()
        release_second.set()
        futures = (
            (first_future,) if second_future is None else (first_future, second_future)
        )
        try:
            join_workers(futures)
        finally:
            remove_listeners()
        raise

    if second_future is None:
        raise AssertionError("Second serialized worker was not submitted")

    def cleanup() -> None:
        release_first.set()
        release_second.set()
        try:
            join_workers((first_future, second_future))
        finally:
            remove_listeners()

    return first_future, second_future, observations, cleanup


def _typed_outcome(value: object) -> checkout.CheckoutOutcome:
    assert isinstance(value, checkout.CheckoutOutcome)
    return value


def test_demo_checkout_locks_order_before_ordered_payments(
    demo_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Prove the mandatory Order then deterministically ordered Payments locks."""
    _, public_number, token = _store_runtime_order(demo_session_factory)
    statements: list[str] = []

    def capture(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if "FOR UPDATE" in statement.upper():
            statements.append(_normalized(statement))

    event.listen(test_database_engine, "before_cursor_execute", capture)
    try:
        _run_demo(
            demo_session_factory,
            public_number=public_number,
            token=token,
            request_key=uuid4(),
            payment_id=FAILED_ID,
        )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    assert [
        "orders" if " from orders " in statement else "payments"
        for statement in statements
    ] == ["orders", "payments"]
    assert "order by payments.created_at asc, payments.id asc" in statements[1]


def test_same_key_concurrency_creates_one_payment_and_zero_replay_dml(
    demo_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Serialize two real connections onto one terminal Payment and response."""
    order_id, public_number, token = _store_runtime_order(demo_session_factory)
    request_key = uuid4()

    with ThreadPoolExecutor(max_workers=2) as executor:
        first, second, observations, cleanup = _submit_serialized_pair(
            test_database_engine,
            executor,
            lambda pid_sink: _run_demo(
                demo_session_factory,
                public_number=public_number,
                token=token,
                request_key=request_key,
                payment_id=SUCCESS_ID,
                backend_pid_sink=pid_sink,
            ),
            lambda pid_sink: _run_demo(
                demo_session_factory,
                public_number=public_number,
                token=token,
                request_key=request_key,
                payment_id=EXPIRED_ID,
                backend_pid_sink=pid_sink,
            ),
            snapshot_provider=lambda: _related_state_snapshot(
                test_database_engine,
                order_id,
            ),
        )
        try:
            outcomes = [
                _typed_outcome(first.result(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)),
                _typed_outcome(second.result(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)),
            ]
        finally:
            cleanup()

    assert {outcome.created for outcome in outcomes} == {True, False}
    assert len({outcome.response.model_dump_json() for outcome in outcomes}) == 1
    _assert_server_wait_observed(observations)
    assert not any(
        _is_data_writing_statement(str(statement))
        for statement in observations["second_statements"]
    )
    assert len(observations["state_before_second"]) == 1
    assert (
        _related_state_snapshot(test_database_engine, order_id)
        == observations["state_before_second"][0]
    )
    assert (
        len({connection_id for _role, connection_id in observations["connections"]})
        == 2
    )
    with demo_session_factory() as session:
        payments = list(session.scalars(select(Payment)).all())
        assert session.scalar(select(StripeEvent)) is None
    assert [(payment.id, payment.status) for payment in payments] == [
        (SUCCESS_ID, PaymentStatus.SUCCEEDED.value)
    ]


def test_different_key_after_concurrent_success_is_conflict(
    demo_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Let the first serialized success make the different key conflict."""
    order_id, public_number, token = _store_runtime_order(demo_session_factory)
    first_key = uuid4()
    second_key = uuid4()
    with ThreadPoolExecutor(max_workers=2) as executor:
        first, second, observations, cleanup = _submit_serialized_pair(
            test_database_engine,
            executor,
            lambda pid_sink: _run_demo(
                demo_session_factory,
                public_number=public_number,
                token=token,
                request_key=first_key,
                payment_id=SUCCESS_ID,
                backend_pid_sink=pid_sink,
            ),
            lambda pid_sink: _run_demo(
                demo_session_factory,
                public_number=public_number,
                token=token,
                request_key=second_key,
                payment_id=FAILED_ID,
                backend_pid_sink=pid_sink,
            ),
            snapshot_provider=lambda: _related_state_snapshot(
                test_database_engine,
                order_id,
            ),
        )
        try:
            assert (
                _typed_outcome(
                    first.result(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)
                ).created
                is True
            )
            with pytest.raises(checkout.OrderAlreadyPaidError):
                second.result(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)
        finally:
            cleanup()

    _assert_server_wait_observed(observations)
    assert not any(
        _is_data_writing_statement(str(statement))
        for statement in observations["second_statements"]
    )
    assert (
        _related_state_snapshot(test_database_engine, order_id)
        == observations["state_before_second"][0]
    )
    with demo_session_factory() as session:
        payments = list(session.scalars(select(Payment)).all())
    assert [(payment.id, payment.status) for payment in payments] == [
        (SUCCESS_ID, PaymentStatus.SUCCEEDED.value)
    ]


def test_different_key_after_concurrent_failure_creates_second_attempt(
    demo_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Allow a new key after a serialized non-success terminal attempt."""
    order_id, public_number, token = _store_runtime_order(demo_session_factory)
    first_key = uuid4()
    second_key = uuid4()
    with ThreadPoolExecutor(max_workers=2) as executor:
        first, second, observations, cleanup = _submit_serialized_pair(
            test_database_engine,
            executor,
            lambda pid_sink: _run_demo(
                demo_session_factory,
                public_number=public_number,
                token=token,
                request_key=first_key,
                payment_id=FAILED_ID,
                backend_pid_sink=pid_sink,
            ),
            lambda pid_sink: _run_demo(
                demo_session_factory,
                public_number=public_number,
                token=token,
                request_key=second_key,
                payment_id=EXPIRED_ID,
                backend_pid_sink=pid_sink,
            ),
            snapshot_provider=lambda: _related_state_snapshot(
                test_database_engine,
                order_id,
            ),
        )
        try:
            outcomes = [
                _typed_outcome(first.result(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)),
                _typed_outcome(second.result(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)),
            ]
        finally:
            cleanup()

    assert all(outcome.created for outcome in outcomes)
    _assert_server_wait_observed(observations)
    assert any(
        _is_data_writing_statement(str(statement))
        for statement in observations["second_statements"]
    )
    state_before_second = observations["state_before_second"][0]
    assert isinstance(state_before_second, tuple)
    state_after_second = _related_state_snapshot(test_database_engine, order_id)
    assert state_after_second[0] == state_before_second[0]
    assert state_after_second[2:] == state_before_second[2:]
    assert len(state_after_second[1]) == len(state_before_second[1]) + 1
    assert all(row in state_after_second[1] for row in state_before_second[1])
    with demo_session_factory() as session:
        payments = list(session.scalars(select(Payment)).all())
    assert {(payment.id, payment.status) for payment in payments} == {
        (FAILED_ID, PaymentStatus.FAILED.value),
        (EXPIRED_ID, PaymentStatus.EXPIRED.value),
    }


def test_committed_result_is_recovered_by_same_key_after_response_loss(
    demo_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Model ambiguous client delivery as a same-key, zero-DML replay."""
    order_id, public_number, token = _store_runtime_order(demo_session_factory)
    request_key = uuid4()
    first = _run_demo(
        demo_session_factory,
        public_number=public_number,
        token=token,
        request_key=request_key,
        payment_id=FAILED_ID,
    )
    state_before_replay = _related_state_snapshot(test_database_engine, order_id)
    statements: list[str] = []

    def capture(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture)
    try:
        replay = _run_demo(
            demo_session_factory,
            public_number=public_number,
            token=token,
            request_key=request_key,
            payment_id=SUCCESS_ID,
        )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    assert first.created is True
    assert replay.created is False
    assert replay.response == first.response
    assert not any(_is_data_writing_statement(statement) for statement in statements)
    assert (
        _related_state_snapshot(test_database_engine, order_id) == state_before_replay
    )


def test_cancellation_waits_for_failed_checkout_then_blocks_retry(
    demo_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Share the Order lock with cancellation and reject a later new key."""
    order_id, public_number, token = _store_runtime_order(demo_session_factory)
    with ThreadPoolExecutor(max_workers=2) as executor:
        checkout_future, cancellation_future, observations, cleanup = (
            _submit_serialized_pair(
                test_database_engine,
                executor,
                lambda pid_sink: _run_demo(
                    demo_session_factory,
                    public_number=public_number,
                    token=token,
                    request_key=uuid4(),
                    payment_id=FAILED_ID,
                    backend_pid_sink=pid_sink,
                ),
                lambda pid_sink: _cancel(
                    demo_session_factory,
                    public_number,
                    backend_pid_sink=pid_sink,
                ),
                snapshot_provider=lambda: _related_state_snapshot(
                    test_database_engine,
                    order_id,
                ),
            )
        )
        try:
            assert (
                _typed_outcome(
                    checkout_future.result(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)
                ).created
                is True
            )
            assert (
                cancellation_future.result(timeout=WORKER_BARRIER_TIMEOUT_SECONDS)
                is True
            )
        finally:
            cleanup()

    _assert_server_wait_observed(observations)
    state_before_retry = _related_state_snapshot(test_database_engine, order_id)
    retry_statements: list[str] = []

    def capture_retry(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        retry_statements.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture_retry)
    try:
        with pytest.raises(checkout.OrderNotPayableError):
            _run_demo(
                demo_session_factory,
                public_number=public_number,
                token=token,
                request_key=uuid4(),
                payment_id=EXPIRED_ID,
            )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_retry)

    assert not any(
        _is_data_writing_statement(statement) for statement in retry_statements
    )
    assert _related_state_snapshot(test_database_engine, order_id) == state_before_retry
    with demo_session_factory() as session:
        order = session.scalar(
            select(Order).where(Order.public_order_number == public_number)
        )
        payments = list(session.scalars(select(Payment)).all())
    assert order is not None
    assert order.status == OrderStatus.CANCELLED.value
    assert [(payment.id, payment.status) for payment in payments] == [
        (FAILED_ID, PaymentStatus.FAILED.value)
    ]


def test_second_flush_database_error_rolls_back_and_is_sanitized(
    demo_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Roll back pending insertion when the terminal update cannot persist."""
    _, public_number, token = _store_runtime_order(demo_session_factory)

    def reject_update(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if statement.lstrip().upper().startswith("UPDATE PAYMENTS"):
            raise OperationalError(
                f"UPDATE payments -- {SYNTHETIC_DB_MARKER}",
                {"secret": SYNTHETIC_DB_MARKER},
                RuntimeError(SYNTHETIC_DB_MARKER),
            )

    event.listen(test_database_engine, "before_cursor_execute", reject_update)
    try:
        with pytest.raises(
            checkout.PaymentSessionReconciliationRequiredError
        ) as captured:
            _run_demo(
                demo_session_factory,
                public_number=public_number,
                token=token,
                request_key=uuid4(),
                payment_id=SUCCESS_ID,
            )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", reject_update)

    error = captured.value
    assert error.__cause__ is None
    assert error.__context__ is None
    assert SYNTHETIC_DB_MARKER not in "".join(traceback.format_exception(error))
    with demo_session_factory() as session:
        assert session.scalar(select(Payment)) is None
