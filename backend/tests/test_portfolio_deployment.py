"""Unit coverage for the production portfolio deployment operator boundary."""

from __future__ import annotations

import subprocess
import traceback
from contextlib import AbstractContextManager
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
from zoneinfo import ZoneInfo

import pytest
from pydantic import PostgresDsn, TypeAdapter
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool

from app import portfolio_deployment as operator
from app.auth.demo_admin import DEMO_ADMIN_EMAIL, DEMO_ADMIN_ID, DemoAdminResult
from app.seed.portfolio import PortfolioSeedResult
from app.seed.safety import TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES

NEON_HOST = "ep-synthetic-portfolio-pooler.c-1.eu-central-1.aws.neon.tech"
DATABASE_SECRET = "synthetic-database-secret-never-render"
RAW_PRIVATE_MARKER = "raw-private-driver-marker"
REFERENCE_END = datetime(2026, 9, 23, tzinfo=ZoneInfo("Europe/Oslo"))
PLAN_SHA256 = "716200cc31feebe72a1dc237175e5c5780075bffa055a7086430dedb823bb9f3"
RELEASE_SHA = "b" * 40


def _url(
    *,
    username: str = operator.PORTFOLIO_RUNTIME_ROLE,
    host: str = NEON_HOST,
    database: str = operator.PORTFOLIO_DATABASE_NAME,
    query: str = "sslmode=require&channel_binding=require",
) -> str:
    return f"postgresql://{username}:{DATABASE_SECRET}@{host}/{database}?{query}"


def _parsed_url(**changes: str) -> PostgresDsn:
    return TypeAdapter(PostgresDsn).validate_python(_url(**changes))


def _portfolio_result() -> PortfolioSeedResult:
    return PortfolioSeedResult(
        inserted=False,
        categories_processed=5,
        menu_items_processed=15,
        tables_processed=12,
        orders_processed=500,
        order_items_processed=1_211,
        status_history_processed=2_326,
        payments_processed=484,
    )


def _operation_result(
    action: operator.PortfolioAction = "verify-state",
    status: str = "active",
) -> operator.PortfolioDeploymentResult:
    return operator.PortfolioDeploymentResult(
        action=action,
        portfolio=None if action == "deactivate" else _portfolio_result(),
        demo_admin=DemoAdminResult(
            id=DEMO_ADMIN_ID,
            email=DEMO_ADMIN_EMAIL,
            status=status,  # type: ignore[arg-type]
        ),
    )


def _clear_postgres_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for variable in TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(variable, raising=False)


@pytest.mark.parametrize(
    "changes",
    [
        {"username": "neondb_owner"},
        {"host": "ep-synthetic-portfolio.c-1.eu-central-1.aws.neon.tech"},
        {"host": "ep-other-pooler.c-1.eu-central-1.aws.neon.tech"},
        {"database": "other_database"},
        {"query": "sslmode=require"},
    ],
    ids=["owner-role", "direct-host", "different-host", "database", "tls-query"],
)
def test_runtime_url_rejects_every_non_exact_target(changes: dict[str, str]) -> None:
    """Accept only the independently pinned pooled runtime-role URL."""
    with pytest.raises(operator.PortfolioDeploymentConfigurationError):
        operator._parse_runtime_database_url(
            _url(**changes),
            expected_endpoint_host=NEON_HOST,
        )


def test_runtime_url_accepts_exact_pooled_target_without_disclosing_secret() -> None:
    """Normalize one exact credentialed URL while retaining secret redaction."""
    parsed = operator._parse_runtime_database_url(
        _url(),
        expected_endpoint_host=NEON_HOST,
    )

    normalized = make_url(str(parsed))
    assert normalized.host == NEON_HOST
    assert normalized.database == operator.PORTFOLIO_DATABASE_NAME


def test_engine_is_null_pool_and_hides_sql_parameters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Create one non-reusing, parameter-redacting operator engine."""
    sentinel = object()
    captured: dict[str, object] = {}

    def fake_create_engine(url: str, **kwargs: object) -> object:
        captured["url"] = url
        captured.update(kwargs)
        return sentinel

    monkeypatch.setattr(operator, "create_engine", fake_create_engine)

    engine = operator._create_engine(_parsed_url())

    assert engine is sentinel
    assert captured["poolclass"] is NullPool
    assert captured["pool_pre_ping"] is True
    assert captured["hide_parameters"] is True


def test_run_rejects_target_changing_environment_before_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop ambient libpq routing controls before opening the hidden URL."""
    monkeypatch.setenv("PGHOST", "unapproved.example")
    engine = Mock(side_effect=AssertionError("engine must not be created"))
    monkeypatch.setattr(operator, "_create_engine", engine)

    with pytest.raises(operator.PortfolioDeploymentConfigurationError):
        operator._run_portfolio_operation(
            "verify-state",
            database_url=_parsed_url(),
            expected_endpoint_host=NEON_HOST,
            plan=object(),  # type: ignore[arg-type]
        )

    engine.assert_not_called()


def test_run_rejects_unknown_programmatic_action_before_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prevent a non-CLI caller from falling through to a write action."""
    _clear_postgres_environment(monkeypatch)
    engine = Mock(side_effect=AssertionError("engine must not be created"))
    monkeypatch.setattr(operator, "_create_engine", engine)

    with pytest.raises(operator.PortfolioDeploymentConfigurationError):
        operator._run_portfolio_operation(
            "unapproved",  # type: ignore[arg-type]
            database_url=_parsed_url(),
            expected_endpoint_host=NEON_HOST,
            plan=object(),  # type: ignore[arg-type]
        )

    engine.assert_not_called()


def test_main_prompts_for_url_only_after_offline_checks(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Keep the production URL out of argv and obtain it only via getpass."""
    _clear_postgres_environment(monkeypatch)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://ambient:ambient-secret@example.invalid/ambient",
    )
    monkeypatch.setenv(
        "DEPLOYMENT_SEED_DATABASE_URL",
        "postgresql://ambient:ambient-secret@example.invalid/ambient",
    )
    plan = object()
    getpass_mock = Mock(return_value=_url())
    parse_mock = Mock(return_value=_parsed_url())
    run_mock = Mock(return_value=_operation_result())
    monkeypatch.setattr(operator, "_require_exact_checkout", Mock())
    monkeypatch.setattr(operator, "_generate_expected_plan", Mock(return_value=plan))
    monkeypatch.setattr(operator.getpass, "getpass", getpass_mock)
    monkeypatch.setattr(operator, "_parse_runtime_database_url", parse_mock)
    monkeypatch.setattr(operator, "_run_portfolio_operation", run_mock)

    assert operator.main(_arguments("verify-state")) == 0

    output = capsys.readouterr()
    assert output.err == ""
    assert DATABASE_SECRET not in output.out
    for expected_count in (
        "5 categories",
        "15 menu items",
        "12 tables",
        "500 orders",
        "1211 items",
        "2326 history rows",
        "484 payments",
    ):
        assert expected_count in output.out
    getpass_mock.assert_called_once_with(
        "Neon pooled roa_runtime URL for roa_portfolio (hidden): "
    )
    parse_mock.assert_called_once_with(_url(), expected_endpoint_host=NEON_HOST)
    run_mock.assert_called_once_with(
        "verify-state",
        database_url=_parsed_url(),
        expected_endpoint_host=NEON_HOST,
        plan=plan,
    )


def test_plan_is_generated_from_exact_reference_end_and_hash() -> None:
    """Bind verification to the independently approved canonical plan bytes."""
    plan = operator._generate_expected_plan(REFERENCE_END.isoformat(), PLAN_SHA256)

    assert plan.canonical_sha256 == PLAN_SHA256
    with pytest.raises(operator.PortfolioDeploymentPlanError):
        operator._generate_expected_plan(REFERENCE_END.isoformat(), "0" * 64)


def test_deactivate_cli_does_not_require_or_generate_dataset_plan(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Keep emergency deactivation independent from dataset plan inputs."""
    _clear_postgres_environment(monkeypatch)
    generate = Mock(side_effect=AssertionError("plan generation must not run"))
    run = Mock(return_value=_operation_result("deactivate", "deactivated"))
    monkeypatch.setattr(operator, "_require_exact_checkout", Mock())
    monkeypatch.setattr(operator, "_generate_expected_plan", generate)
    monkeypatch.setattr(operator.getpass, "getpass", Mock(return_value=_url()))
    monkeypatch.setattr(
        operator,
        "_parse_runtime_database_url",
        Mock(return_value=_parsed_url()),
    )
    monkeypatch.setattr(operator, "_run_portfolio_operation", run)

    assert (
        operator.main(
            _arguments(
                "deactivate",
                confirmation=operator.DEACTIVATE_CONFIRMATION,
            )
        )
        == 0
    )

    output = capsys.readouterr()
    assert output.err == ""
    assert "exact schema verified" in output.out
    generate.assert_not_called()
    run.assert_called_once_with(
        "deactivate",
        database_url=_parsed_url(),
        expected_endpoint_host=NEON_HOST,
        plan=None,
    )


def test_main_rejects_url_like_argument_without_echo_or_prompt(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Reject accidental secret-bearing argv before opening the hidden prompt."""
    prompt = Mock(side_effect=AssertionError("prompt must not run"))
    monkeypatch.setattr(operator.getpass, "getpass", prompt)

    assert operator.main(["verify-state", "--database-url", _url()]) == 1

    output = capsys.readouterr()
    assert output.out == ""
    assert output.err.strip() == (
        operator.PortfolioDeploymentConfigurationError.public_message
    )
    assert DATABASE_SECRET not in output.err
    assert NEON_HOST not in output.err
    prompt.assert_not_called()


@pytest.mark.parametrize(
    ("action", "confirmation", "valid"),
    [
        ("verify-state", None, True),
        ("verify-state", operator.PROVISION_CONFIRMATION, False),
        ("provision", operator.PROVISION_CONFIRMATION, True),
        ("provision", None, False),
        ("deactivate", operator.DEACTIVATE_CONFIRMATION, True),
        ("deactivate", operator.PROVISION_CONFIRMATION, False),
    ],
)
def test_confirmation_is_exact_and_action_specific(
    action: operator.PortfolioAction,
    confirmation: str | None,
    valid: bool,
) -> None:
    """Require explicit distinct write confirmations and none for verification."""
    if valid:
        operator._require_confirmation(action, confirmation)
    else:
        with pytest.raises(operator.PortfolioDeploymentConfigurationError):
            operator._require_confirmation(action, confirmation)


def test_checkout_requires_exact_clean_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bind the operation to one clean checked-out source commit."""
    results = iter(
        (
            SimpleNamespace(returncode=0, stdout=f"{RELEASE_SHA}\n"),
            SimpleNamespace(returncode=0, stdout=""),
        )
    )
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: next(results))

    operator._require_exact_checkout(RELEASE_SHA)


@pytest.mark.parametrize(
    ("head", "status"),
    [("a" * 40, ""), (RELEASE_SHA, " M backend/app/example.py\n")],
    ids=["wrong-head", "dirty-worktree"],
)
def test_checkout_rejects_wrong_or_dirty_release(
    head: str,
    status: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop before credentials for source drift or uncommitted bytes."""
    results = iter(
        (
            SimpleNamespace(returncode=0, stdout=f"{head}\n"),
            SimpleNamespace(returncode=0, stdout=status),
        )
    )
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: next(results))

    with pytest.raises(operator.PortfolioDeploymentConfigurationError):
        operator._require_exact_checkout(RELEASE_SHA)


class _Rows:
    def __init__(self, rows: tuple[tuple[object, ...], ...]) -> None:
        self._rows = rows

    def all(self) -> list[tuple[object, ...]]:
        return list(self._rows)

    def one(self) -> tuple[object, ...]:
        assert len(self._rows) == 1
        return self._rows[0]

    def scalar_one(self) -> object:
        assert len(self._rows) == 1 and len(self._rows[0]) == 1
        return self._rows[0][0]


class _ScalarRows:
    def __init__(self, values: tuple[str, ...]) -> None:
        self._values = values

    def all(self) -> list[str]:
        return list(self._values)

    def scalars(self) -> _ScalarRows:
        return self


class _RoleConnection:
    def __init__(
        self,
        *,
        roles: tuple[tuple[object, ...], ...] | None = None,
        memberships: tuple[tuple[object, ...], ...] | None = None,
        capabilities: tuple[object, ...] = (True, False),
        effective_members: tuple[str, ...] = (
            operator.NEON_MANAGED_ADMIN_ROLE,
            operator.PORTFOLIO_MIGRATOR_ROLE,
        ),
    ) -> None:
        self.statements: list[str] = []
        self.roles = roles or (
            (operator.PORTFOLIO_MIGRATOR_ROLE, True, False),
            (operator.PORTFOLIO_OWNER_ROLE, False, True),
            (operator.PORTFOLIO_RUNTIME_ROLE, True, False),
        )
        self.memberships = memberships or ((operator.PORTFOLIO_MIGRATOR_ROLE, True),)
        self.capabilities = capabilities
        self.effective_members = effective_members

    def execute(self, statement: object) -> _Rows:
        rendered = str(statement)
        self.statements.append(rendered)
        if "rolcanlogin" in rendered:
            return _Rows(self.roles)
        if "pg_auth_members" in rendered:
            return _Rows(self.memberships)
        if "candidate.rolname" in rendered:
            return _ScalarRows(self.effective_members)  # type: ignore[return-value]
        if "pg_has_role" in rendered:
            return _Rows((self.capabilities,))
        raise AssertionError("unexpected query")


def test_role_contract_accepts_exact_login_and_set_role_boundary() -> None:
    """Accept app roles plus the exact Neon-managed effective capability."""
    connection = _RoleConnection()

    operator._require_role_contract(connection)  # type: ignore[arg-type]

    assert any(
        "candidate.rolname <> 'roa_owner'" in statement
        for statement in connection.statements
    )


@pytest.mark.parametrize(
    "connection",
    [
        _RoleConnection(
            roles=(
                (operator.PORTFOLIO_MIGRATOR_ROLE, True, True),
                (operator.PORTFOLIO_OWNER_ROLE, False, True),
                (operator.PORTFOLIO_RUNTIME_ROLE, True, False),
            )
        ),
        _RoleConnection(
            memberships=(
                (operator.PORTFOLIO_MIGRATOR_ROLE, True),
                (operator.PORTFOLIO_RUNTIME_ROLE, True),
            )
        ),
        _RoleConnection(
            memberships=(
                (operator.NEON_MANAGED_ADMIN_ROLE, True),
                (operator.PORTFOLIO_MIGRATOR_ROLE, True),
            )
        ),
        _RoleConnection(capabilities=(True, True)),
        _RoleConnection(effective_members=(operator.PORTFOLIO_MIGRATOR_ROLE,)),
        _RoleConnection(
            effective_members=(
                operator.NEON_MANAGED_ADMIN_ROLE,
                "unexpected_app_role",
                operator.PORTFOLIO_MIGRATOR_ROLE,
            )
        ),
    ],
    ids=[
        "inherit-drift",
        "extra-owner-member",
        "managed-role-direct-set-membership",
        "runtime-can-set-owner",
        "managed-role-missing",
        "unexpected-app-role-can-set-owner",
    ],
)
def test_role_contract_rejects_privilege_drift(connection: _RoleConnection) -> None:
    """Stop on login, inheritance, SET-capable membership, or SET ROLE drift."""
    with pytest.raises(operator.PortfolioDeploymentTargetError):
        operator._require_role_contract(connection)  # type: ignore[arg-type]


class _IdentityConnection:
    def __init__(self, row: tuple[object, ...], schemas: object = ["public"]) -> None:
        self.row = row
        self.schemas = schemas
        self.commands: list[str] = []

    def execute(self, statement: object) -> _Rows:
        rendered = str(statement)
        if "transaction_read_only" in rendered:
            return _Rows((self.row,))
        if "current_schemas" in rendered:
            return _Rows(((self.schemas,),))
        raise AssertionError("unexpected query")

    def exec_driver_sql(self, statement: str) -> None:
        self.commands.append(statement)


def test_target_and_search_path_require_exact_read_only_identity() -> None:
    """Verify the runtime login, database, transaction mode, and public schema."""
    connection = _IdentityConnection(
        (
            operator.PORTFOLIO_RUNTIME_ROLE,
            operator.PORTFOLIO_RUNTIME_ROLE,
            operator.PORTFOLIO_DATABASE_NAME,
            "on",
        )
    )

    operator._require_target_identity(
        connection,  # type: ignore[arg-type]
        expected_database_name=operator.PORTFOLIO_DATABASE_NAME,
        expected_login_role=operator.PORTFOLIO_RUNTIME_ROLE,
        read_only=True,
    )
    operator._pin_public_search_path(connection)  # type: ignore[arg-type]

    assert connection.commands == ["SET LOCAL search_path TO public"]


def test_target_rejects_transaction_mode_or_identity_drift() -> None:
    """Stop before domain access when any connected-session identity differs."""
    connection = _IdentityConnection(
        (
            operator.PORTFOLIO_RUNTIME_ROLE,
            operator.PORTFOLIO_RUNTIME_ROLE,
            "wrong_database",
            "off",
        )
    )
    with pytest.raises(operator.PortfolioDeploymentTargetError):
        operator._require_target_identity(
            connection,  # type: ignore[arg-type]
            expected_database_name=operator.PORTFOLIO_DATABASE_NAME,
            expected_login_role=operator.PORTFOLIO_RUNTIME_ROLE,
            read_only=True,
        )


class _FailingEngine:
    def connect(self) -> AbstractContextManager[object]:
        raise SQLAlchemyError(RAW_PRIVATE_MARKER)

    def dispose(self) -> None:
        return None


class _Context(AbstractContextManager[object]):
    def __init__(self, value: object) -> None:
        self.value = value

    def __enter__(self) -> object:
        return self.value

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback_object: object | None,
    ) -> None:
        del exc_type, exc_value, traceback_object
        return None


class _RunnerConnection:
    def __init__(self) -> None:
        self.events: list[str] = []

    def begin(self) -> AbstractContextManager[object]:
        return _Context(self)

    def exec_driver_sql(self, statement: str) -> None:
        self.events.append(statement)


class _RunnerEngine:
    def __init__(self, connection: _RunnerConnection) -> None:
        self.connection = connection

    def connect(self) -> AbstractContextManager[object]:
        return _Context(self.connection)


def test_verify_state_sets_read_only_before_every_database_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Make transaction read-only the first database statement for verification."""
    connection = _RunnerConnection()
    factory = object()

    def target_check(*args: object, **kwargs: object) -> None:
        assert connection.events == ["SET TRANSACTION READ ONLY"]
        connection.events.append("target")

    monkeypatch.setattr(operator, "_require_target_identity", target_check)
    monkeypatch.setattr(
        operator,
        "_pin_public_search_path",
        lambda supplied: connection.events.append("search-path"),
    )
    monkeypatch.setattr(
        operator,
        "_require_role_contract",
        lambda supplied: connection.events.append("roles"),
    )
    monkeypatch.setattr(operator, "sessionmaker", lambda **kwargs: factory)
    monkeypatch.setattr(
        operator,
        "verify_portfolio_data",
        lambda supplied_factory, plan: _portfolio_result(),
    )
    monkeypatch.setattr(
        operator,
        "inspect_demo_admin",
        lambda supplied_factory: _operation_result().demo_admin,
    )

    result = operator._run_with_engine(
        _RunnerEngine(connection),  # type: ignore[arg-type]
        action="verify-state",
        plan=object(),  # type: ignore[arg-type]
    )

    assert result.action == "verify-state"
    assert connection.events == [
        "SET TRANSACTION READ ONLY",
        "target",
        "search-path",
        "roles",
    ]


def test_deactivate_checks_schema_but_not_drifted_dataset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep security rollback independent from unrelated portfolio row drift."""
    connection = _RunnerConnection()
    factory = object()
    inactive = _operation_result("deactivate", "deactivated").demo_admin
    monkeypatch.setattr(operator, "_require_target_identity", lambda *args, **kw: None)
    monkeypatch.setattr(operator, "_pin_public_search_path", lambda supplied: None)
    monkeypatch.setattr(operator, "_require_role_contract", lambda supplied: None)
    monkeypatch.setattr(operator, "sessionmaker", lambda **kwargs: factory)
    verify_data = Mock(side_effect=AssertionError("dataset must not be verified"))
    verify_schema = Mock(
        return_value="0009_add_portfolio_demo_origin_and_payment_provider"
    )
    deactivate = Mock(return_value=inactive)
    monkeypatch.setattr(operator, "verify_portfolio_data", verify_data)
    monkeypatch.setattr(operator, "verify_portfolio_schema", verify_schema)
    monkeypatch.setattr(operator, "deactivate_demo_admin", deactivate)

    result = operator._run_with_engine(
        _RunnerEngine(connection),  # type: ignore[arg-type]
        action="deactivate",
        plan=None,
    )

    assert result.portfolio is None
    assert result.demo_admin.status == "deactivated"
    verify_data.assert_not_called()
    verify_schema.assert_called_once_with(factory)
    deactivate.assert_called_once_with(factory)


def test_raw_database_failure_is_detached_and_secret_free(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Remove URL and driver detail from the public exception graph."""
    monkeypatch.setattr(
        operator, "_create_engine", lambda database_url: _FailingEngine()
    )
    captured: operator.PortfolioDeploymentExecutionError | None = None

    try:
        operator._run_portfolio_operation(
            "verify-state",
            database_url=_parsed_url(),
            expected_endpoint_host=NEON_HOST,
            plan=object(),  # type: ignore[arg-type]
        )
    except operator.PortfolioDeploymentExecutionError as exc:
        captured = exc
        rendered = "".join(traceback.format_exception(exc))
    else:  # pragma: no cover - test assertion guard
        pytest.fail("raw database error was not translated")

    assert captured is not None
    assert captured.__cause__ is None
    assert captured.__context__ is None
    assert RAW_PRIVATE_MARKER not in rendered
    assert DATABASE_SECRET not in rendered
    assert NEON_HOST not in rendered


def _arguments(
    action: operator.PortfolioAction,
    *,
    confirmation: str | None = None,
) -> list[str]:
    arguments = [
        action,
        "--expected-endpoint-host",
        NEON_HOST,
        "--expected-release-sha",
        RELEASE_SHA,
    ]
    if action != "deactivate":
        arguments.extend(
            (
                "--portfolio-reference-end",
                REFERENCE_END.isoformat(),
                "--expected-plan-sha256",
                PLAN_SHA256,
            )
        )
    if confirmation is not None:
        arguments.extend(("--confirmation", confirmation))
    return arguments
