"""Unit coverage for explicit offline demo-administrator provisioning."""

from __future__ import annotations

import os
import subprocess
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractContextManager
from pathlib import Path
from threading import Barrier, Lock
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID, uuid4

import pytest
from sqlalchemy.engine import URL
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.auth import demo_admin
from app.auth.bootstrap import SUPER_ADMIN_BOOTSTRAP_LOCK_KEY
from app.auth.demo_admin import (
    DEMO_ADMIN_DISABLED_PASSWORD_HASH,
    DEMO_ADMIN_EMAIL,
    DEMO_ADMIN_ID,
    DEMO_ADMIN_PROVISION_LOCK_KEY,
    DemoAdminConflictError,
    DemoAdminDatabaseError,
    DemoAdminResult,
    is_demo_admin_identity,
    provision_demo_admin,
    validate_local_demo_admin_database_url,
    verify_demo_admin,
)
from app.auth.models import User
from app.auth.passwords import verify_password
from app.auth.roles import UserRole
from app.auth.user_schemas import CurrentUserResponse
from app.core.config import Settings
from app.seed.safety import TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES

BACKEND_ROOT = Path(__file__).resolve().parents[1]
SAFE_PASSWORD = "synthetic-local-password"


SYNTHETIC_CLI_SECRET = "synthetic-cli-secret-never-log"
CLI_PARSE_ERROR = "Demo administrator command failed: invalid command arguments.\n"


class _ScalarRows:
    def __init__(self, rows: list[User]) -> None:
        self._rows = rows

    def all(self) -> list[User]:
        return list(self._rows)


class _FakeSession:
    def __init__(
        self,
        rows: list[User],
        calls: list[str],
        *,
        select_error: SQLAlchemyError | None = None,
        flush_error: SQLAlchemyError | None = None,
    ) -> None:
        self.rows = rows
        self.calls = calls
        self.added: list[User] = []
        self._select_error = select_error
        self._flush_error = flush_error

    def execute(self, statement: object, parameters: dict[str, int]) -> None:
        assert "pg_advisory_xact_lock" in str(statement)
        assert parameters == {"lock_key": DEMO_ADMIN_PROVISION_LOCK_KEY}
        self.calls.append("advisory-lock")

    def scalars(self, statement: object) -> _ScalarRows:
        rendered = str(statement)
        self.calls.append("select-for-update" if "FOR UPDATE" in rendered else "select")
        if self._select_error is not None:
            raise self._select_error
        return _ScalarRows(self.rows)

    def add(self, user: User) -> None:
        self.calls.append("add")
        self.added.append(user)

    def flush(self) -> None:
        self.calls.append("flush")
        if self._flush_error is not None:
            raise self._flush_error


class _Context(AbstractContextManager[_FakeSession]):
    def __init__(
        self,
        session: _FakeSession,
        calls: list[str],
        *,
        transactional: bool,
    ) -> None:
        self._session = session
        self._calls = calls
        self._transactional = transactional

    def __enter__(self) -> _FakeSession:
        self._calls.append("begin" if self._transactional else "open")
        return self._session

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback_object: object | None,
    ) -> None:
        del exc_value, traceback_object
        if self._transactional:
            self._calls.append("rollback" if exc_type is not None else "commit")
        else:
            self._calls.append("close")
        return None


class _FakeFactory:
    def __init__(self, session: _FakeSession, calls: list[str]) -> None:
        self._session = session
        self._calls = calls

    def begin(self) -> _Context:
        return _Context(self._session, self._calls, transactional=True)

    def __call__(self) -> _Context:
        return _Context(self._session, self._calls, transactional=False)


def _user(**changes: object) -> User:
    values: dict[str, object] = {
        "id": DEMO_ADMIN_ID,
        "email": DEMO_ADMIN_EMAIL,
        "password_hash": DEMO_ADMIN_DISABLED_PASSWORD_HASH,
        "role": UserRole.ADMIN,
        "is_active": True,
    }
    values.update(changes)
    return User(**values)  # type: ignore[arg-type]


def _database_url(
    *,
    host: str = "127.0.0.1",
    port: int = 5433,
    database: str = "restaurant_ordering_analytics_dev",
) -> str:
    return URL.create(
        drivername="postgresql+psycopg",
        username="demo_operator",
        password=SAFE_PASSWORD,
        host=host,
        port=port,
        database=database,
    ).render_as_string(hide_password=False)


def _clear_postgres_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for variable in TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(variable, raising=False)


def test_import_has_no_output_or_runtime_side_effects() -> None:
    """Import the isolated command without opening a CLI or database boundary."""
    environment = os.environ.copy()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    completed = subprocess.run(
        [sys.executable, "-c", "import app.auth.demo_admin"],
        cwd=BACKEND_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0
    assert completed.stdout == ""
    assert completed.stderr == ""


def test_reserved_identity_is_exact_admin_and_never_super_admin() -> None:
    """Recognize only the complete reserved ordinary-admin identity."""
    user = _user()

    assert is_demo_admin_identity(user) is True
    assert user.role is UserRole.ADMIN
    assert user.role is not UserRole.SUPER_ADMIN
    assert user.is_active is True
    assert isinstance(user.id, UUID)
    response = CurrentUserResponse(
        id=user.id,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
    )
    assert response.email == DEMO_ADMIN_EMAIL


@pytest.mark.parametrize(
    "candidate",
    ["", "portfolio-demo-admin-login-disabled-v1", "unrelated-password"],
)
@pytest.mark.parametrize(
    ("portfolio_demo_mode", "payment_provider"),
    [(False, "stripe_test"), (True, "demo")],
)
def test_reserved_password_value_can_never_authenticate(
    candidate: str,
    portfolio_demo_mode: bool,
    payment_provider: str,
) -> None:
    """Keep the required database field unusable as a public password."""
    Settings(
        _env_file=None,
        database_url=None,
        portfolio_demo_mode=portfolio_demo_mode,
        payment_provider=payment_provider,
    )
    assert verify_password(candidate, DEMO_ADMIN_DISABLED_PASSWORD_HASH) is False


def test_provision_inserts_exact_identity_after_advisory_lock() -> None:
    """Insert one exact row only after acquiring the dedicated transaction lock."""
    calls: list[str] = []
    session = _FakeSession([], calls)

    result = provision_demo_admin(_FakeFactory(session, calls))  # type: ignore[arg-type]

    assert result == DemoAdminResult(
        id=DEMO_ADMIN_ID,
        email=DEMO_ADMIN_EMAIL,
        status="provisioned",
    )
    assert calls == [
        "begin",
        "advisory-lock",
        "select-for-update",
        "add",
        "flush",
        "commit",
    ]
    assert len(session.added) == 1
    assert is_demo_admin_identity(session.added[0]) is True
    assert DEMO_ADMIN_PROVISION_LOCK_KEY != SUPER_ADMIN_BOOTSTRAP_LOCK_KEY


def test_exact_provision_rerun_is_zero_dml_no_op() -> None:
    """Return an exact no-op without adding, flushing, or repairing the row."""
    calls: list[str] = []
    session = _FakeSession([_user()], calls)

    result = provision_demo_admin(_FakeFactory(session, calls))  # type: ignore[arg-type]

    assert result.status == "already_exact"
    assert calls == ["begin", "advisory-lock", "select-for-update", "commit"]
    assert session.added == []


@pytest.mark.parametrize(
    "rows",
    [
        [_user(id=uuid4())],
        [_user(email="different-admin@example.com")],
        [_user(role=UserRole.CUSTOMER)],
        [_user(role=UserRole.SUPER_ADMIN)],
        [_user(is_active=False)],
        [_user(password_hash="different-disabled-value")],
        [
            _user(email="different-admin@example.com"),
            _user(id=uuid4()),
        ],
    ],
    ids=[
        "email-collision",
        "id-collision",
        "customer-role-drift",
        "super-admin-role-drift",
        "inactive-drift",
        "password-marker-drift",
        "split-id-and-email-collision",
    ],
)
def test_provision_rejects_conflict_or_drift_without_dml(rows: list[User]) -> None:
    """Fail closed for every reserved-ID or reserved-email ownership conflict."""
    calls: list[str] = []
    session = _FakeSession(rows, calls)

    with pytest.raises(DemoAdminConflictError):
        provision_demo_admin(_FakeFactory(session, calls))  # type: ignore[arg-type]

    assert calls == ["begin", "advisory-lock", "select-for-update", "rollback"]
    assert session.added == []


def test_verify_is_select_only_for_exact_identity() -> None:
    """Verify exact state without a transaction lock or any DML method."""
    calls: list[str] = []
    session = _FakeSession([_user()], calls)

    result = verify_demo_admin(_FakeFactory(session, calls))  # type: ignore[arg-type]

    assert result.status == "verified"
    assert calls == ["open", "select", "close"]
    assert session.added == []


@pytest.mark.parametrize("rows", [[], [_user(is_active=False)]])
def test_verify_fails_closed_for_missing_or_drifted_identity(
    rows: list[User],
) -> None:
    """Reject missing or drifted state without attempting a repair."""
    calls: list[str] = []
    session = _FakeSession(rows, calls)

    with pytest.raises(DemoAdminConflictError):
        verify_demo_admin(_FakeFactory(session, calls))  # type: ignore[arg-type]

    assert calls == ["open", "select", "close"]
    assert session.added == []


def test_integrity_failure_rolls_back_and_removes_private_exception_context() -> None:
    """Translate an insert race only after rollback without raw DB diagnostics."""
    calls: list[str] = []
    private_marker = "SYNTHETIC_PRIVATE_INTEGRITY_MARKER"
    error = IntegrityError(
        "private statement",
        {"private": private_marker},
        RuntimeError(private_marker),
    )
    session = _FakeSession([], calls, flush_error=error)
    captured_error: DemoAdminConflictError | None = None

    try:
        provision_demo_admin(_FakeFactory(session, calls))  # type: ignore[arg-type]
    except DemoAdminConflictError as captured:
        captured_error = captured
        rendered = "".join(traceback.format_exception(captured))
    else:  # pragma: no cover - test assertion guard
        pytest.fail("Integrity failure was not translated")

    assert calls[-1] == "rollback"
    assert captured_error is not None
    assert captured_error.__cause__ is None
    assert captured_error.__context__ is None
    assert private_marker not in str(captured_error)
    assert private_marker not in rendered


def test_database_failure_is_fully_sanitized_after_transaction_exit() -> None:
    """Remove raw driver detail from the public database failure chain."""
    calls: list[str] = []
    private_marker = "SYNTHETIC_PRIVATE_DATABASE_MARKER"
    session = _FakeSession(
        [],
        calls,
        select_error=SQLAlchemyError(private_marker),
    )
    captured_error: DemoAdminDatabaseError | None = None

    try:
        provision_demo_admin(_FakeFactory(session, calls))  # type: ignore[arg-type]
    except DemoAdminDatabaseError as captured:
        captured_error = captured
        rendered = "".join(traceback.format_exception(captured))
    else:  # pragma: no cover - test assertion guard
        pytest.fail("Database failure was not translated")

    assert calls[-1] == "rollback"
    assert captured_error is not None
    assert captured_error.__cause__ is None
    assert captured_error.__context__ is None
    assert private_marker not in str(captured_error)
    assert private_marker not in rendered


@pytest.mark.parametrize(
    "argv",
    [
        [SYNTHETIC_CLI_SECRET],
        ["verify", "--token", SYNTHETIC_CLI_SECRET],
        [],
    ],
    ids=["invalid-action", "unknown-option", "missing-action"],
)
def test_cli_rejects_invalid_arguments_without_disclosing_input(
    argv: list[str],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Reject malformed command input before configuration or database access."""
    settings = Mock(side_effect=AssertionError("Settings accessed"))
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    session_factory = Mock(side_effect=AssertionError("Session factory accessed"))
    provision = Mock(side_effect=AssertionError("Provision attempted"))
    verify = Mock(side_effect=AssertionError("Verify attempted"))
    monkeypatch.setattr(demo_admin, "Settings", settings)
    monkeypatch.setattr(demo_admin, "create_engine", engine)
    monkeypatch.setattr(demo_admin, "create_session_factory", session_factory)
    monkeypatch.setattr(demo_admin, "provision_demo_admin", provision)
    monkeypatch.setattr(demo_admin, "verify_demo_admin", verify)

    assert demo_admin.main(argv) == 2

    output = capsys.readouterr()
    assert output.out == ""
    assert output.err == CLI_PARSE_ERROR
    assert SYNTHETIC_CLI_SECRET not in output.out + output.err
    assert "Traceback" not in output.out + output.err
    settings.assert_not_called()
    engine.assert_not_called()
    session_factory.assert_not_called()
    provision.assert_not_called()
    verify.assert_not_called()


@pytest.mark.parametrize(
    "argv",
    [
        [SYNTHETIC_CLI_SECRET],
        ["verify", "--token", SYNTHETIC_CLI_SECRET],
        [],
    ],
    ids=["invalid-action", "unknown-option", "missing-action"],
)
def test_cli_process_returns_sanitized_parse_exit(
    argv: list[str],
) -> None:
    """Return exit code two without exposing malformed process arguments."""
    environment = os.environ.copy()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    completed = subprocess.run(
        [sys.executable, "-m", "app.auth.demo_admin", *argv],
        cwd=BACKEND_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 2
    assert completed.stdout == ""
    assert completed.stderr == CLI_PARSE_ERROR
    assert SYNTHETIC_CLI_SECRET not in completed.stdout + completed.stderr
    assert "Traceback" not in completed.stdout + completed.stderr


def test_cli_help_is_static_and_has_no_configuration_or_database_access(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Render static help without inspecting configuration or opening a database."""
    settings = Mock(side_effect=AssertionError("Settings accessed"))
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    session_factory = Mock(side_effect=AssertionError("Session factory accessed"))
    monkeypatch.setattr(demo_admin, "Settings", settings)
    monkeypatch.setattr(demo_admin, "create_engine", engine)
    monkeypatch.setattr(demo_admin, "create_session_factory", session_factory)

    assert demo_admin.main(["--help"]) == 0

    output = capsys.readouterr()
    assert output.err == ""
    assert output.out.startswith("usage: python -m app.auth.demo_admin")
    assert "{provision,verify}" in output.out
    settings.assert_not_called()
    engine.assert_not_called()
    session_factory.assert_not_called()


@pytest.mark.parametrize(
    "database_url",
    [
        _database_url(host="db.example.invalid"),
        _database_url(port=5432),
        _database_url(database="restaurant_ordering_analytics_test"),
        _database_url(database="postgres"),
        f"{_database_url()}?host=db.example.invalid",
    ],
    ids=["remote", "host-port-5432", "test-db", "admin-db", "query-redirect"],
)
def test_cli_rejects_unsafe_target_before_engine_creation(
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Reject production, test, redirected, or non-project targets pre-engine."""
    _clear_postgres_environment(monkeypatch)
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    monkeypatch.setattr(
        demo_admin,
        "Settings",
        lambda: SimpleNamespace(database_url=database_url),
    )
    monkeypatch.setattr(demo_admin, "create_engine", engine)

    assert demo_admin.main(["verify"]) == 1

    output = capsys.readouterr()
    engine.assert_not_called()
    assert "local database target is not approved" in output.err
    assert SAFE_PASSWORD not in output.err
    assert "://" not in output.err


def test_cli_rejects_ambient_libpq_target_override_before_engine(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Reject any ambient libpq routing control before creating an engine."""
    _clear_postgres_environment(monkeypatch)
    monkeypatch.setenv("PGSERVICE", "synthetic-private-service")
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    monkeypatch.setattr(
        demo_admin,
        "Settings",
        lambda: SimpleNamespace(database_url=_database_url()),
    )
    monkeypatch.setattr(demo_admin, "create_engine", engine)

    assert demo_admin.main(["provision"]) == 1

    output = capsys.readouterr()
    engine.assert_not_called()
    assert "synthetic-private-service" not in output.err
    assert "local database target is not approved" in output.err


@pytest.mark.parametrize(
    ("action", "status", "expected_output"),
    [
        ("provision", "provisioned", "Demo administrator provisioned."),
        ("provision", "already_exact", "Demo administrator is already exact."),
        ("verify", "verified", "Demo administrator verified."),
    ],
)
def test_cli_runs_only_the_explicit_action_against_pinned_target(
    action: str,
    status: str,
    expected_output: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Dispatch one requested action with no email, password, or token input."""
    _clear_postgres_environment(monkeypatch)
    engine = Mock()
    factory = object()
    provision = Mock(
        return_value=DemoAdminResult(
            id=DEMO_ADMIN_ID,
            email=DEMO_ADMIN_EMAIL,
            status=status,  # type: ignore[arg-type]
        )
    )
    verify = Mock(return_value=provision.return_value)
    create_engine_mock = Mock(return_value=engine)
    monkeypatch.setattr(
        demo_admin,
        "Settings",
        lambda: SimpleNamespace(database_url=_database_url()),
    )
    monkeypatch.setattr(demo_admin, "create_engine", create_engine_mock)
    monkeypatch.setattr(demo_admin, "create_session_factory", lambda _: factory)
    monkeypatch.setattr(demo_admin, "provision_demo_admin", provision)
    monkeypatch.setattr(demo_admin, "verify_demo_admin", verify)

    assert demo_admin.main([action]) == 0

    output = capsys.readouterr()
    assert output.out.strip() == expected_output
    assert output.err == ""
    if action == "provision":
        provision.assert_called_once_with(factory)
        verify.assert_not_called()
    else:
        verify.assert_called_once_with(factory)
        provision.assert_not_called()
    create_engine_mock.assert_called_once()
    database_url = create_engine_mock.call_args.args[0]
    assert database_url.host == "127.0.0.1"
    assert database_url.port == 5433
    assert database_url.database == "restaurant_ordering_analytics_dev"
    assert create_engine_mock.call_args.kwargs == {
        "pool_pre_ping": True,
        "hide_parameters": True,
        "connect_args": {
            "host": "127.0.0.1",
            "hostaddr": "127.0.0.1",
            "port": 5433,
            "dbname": "restaurant_ordering_analytics_dev",
        },
    }
    engine.dispose.assert_called_once_with()


class _ConcurrentStore:
    def __init__(self) -> None:
        self.row: User | None = None
        self.inserts = 0
        self.lock = Lock()
        self.start = Barrier(2)


class _ConcurrentSession:
    def __init__(self, store: _ConcurrentStore) -> None:
        self._store = store
        self._pending: User | None = None

    def execute(self, statement: object, parameters: dict[str, int]) -> None:
        assert "pg_advisory_xact_lock" in str(statement)
        assert parameters == {"lock_key": DEMO_ADMIN_PROVISION_LOCK_KEY}
        acquired = self._store.lock.acquire(timeout=5)
        if not acquired:
            raise AssertionError("Synthetic advisory lock timed out")

    def scalars(self, statement: object) -> _ScalarRows:
        assert "FOR UPDATE" in str(statement)
        rows = [] if self._store.row is None else [self._store.row]
        return _ScalarRows(rows)

    def add(self, user: User) -> None:
        self._pending = user

    def flush(self) -> None:
        assert self._pending is not None
        self._store.row = self._pending
        self._store.inserts += 1


class _ConcurrentTransaction(AbstractContextManager[_ConcurrentSession]):
    def __init__(self, store: _ConcurrentStore) -> None:
        self._store = store
        self._session = _ConcurrentSession(store)

    def __enter__(self) -> _ConcurrentSession:
        self._store.start.wait(timeout=5)
        return self._session

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback_object: object | None,
    ) -> None:
        del exc_type, exc_value, traceback_object
        self._store.lock.release()
        return None


class _ConcurrentFactory:
    def __init__(self, store: _ConcurrentStore) -> None:
        self._store = store

    def begin(self) -> _ConcurrentTransaction:
        return _ConcurrentTransaction(self._store)


def test_two_synthetic_concurrent_attempts_serialize_to_one_insert() -> None:
    """Exercise service ordering with a simulated transaction advisory lock."""
    store = _ConcurrentStore()
    factory = _ConcurrentFactory(store)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(
                provision_demo_admin,
                factory,  # type: ignore[arg-type]
            )
            for _ in range(2)
        ]
        results = [future.result(timeout=10) for future in futures]

    assert sorted(result.status for result in results) == [
        "already_exact",
        "provisioned",
    ]
    assert store.inserts == 1
    assert store.row is not None
    assert is_demo_admin_identity(store.row) is True


def test_validator_accepts_only_the_pinned_local_development_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Normalize localhost to the exact loopback target without connecting."""
    _clear_postgres_environment(monkeypatch)

    parsed = validate_local_demo_admin_database_url(_database_url(host="localhost"))

    assert parsed.host == "127.0.0.1"
    assert parsed.port == 5433
    assert parsed.database == "restaurant_ordering_analytics_dev"
