"""Unit tests for the exact migration runner and its secret boundaries."""

# Ruff and isort classify the repository's local alembic path differently.
# ruff: noqa: I001

from __future__ import annotations

from collections.abc import Iterable
from types import SimpleNamespace, TracebackType
from typing import Any

import pytest
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from alembic.config import Config
from app.database import migration_runner

EXPECTED_HEAD = "0008_add_order_ownership"
MIGRATION_SECRET_MARKER = "migration-password-secret-marker"
RUNTIME_SECRET_MARKER = "runtime-password-secret-marker"


class FakeResult:
    """Return controlled scalar values from a fake SQLAlchemy execution."""

    def __init__(
        self,
        *,
        scalar: object | None = None,
        values: Iterable[object] = (),
    ) -> None:
        self.scalar = scalar
        self.values = tuple(values)

    def scalar_one(self) -> object:
        """Return the configured single scalar."""
        return self.scalar

    def scalars(self) -> tuple[object, ...]:
        """Return the configured scalar sequence."""
        return self.values


class FakeIdentifierPreparer:
    """Quote a prevalidated identifier like the PostgreSQL dialect."""

    def quote_identifier(self, value: str) -> str:
        """Return a deliberately quoted test identifier."""
        return f'"{value}"'


class FakeTransaction:
    """Model one caller-owned SQLAlchemy transaction."""

    def __init__(self, connection: FakeConnection) -> None:
        """Bind the fake transaction to its connection."""
        self.connection = connection

    def __enter__(self) -> FakeTransaction:
        """Open the transaction and record its boundary."""
        if self.connection.transaction_active:
            raise AssertionError("Fake transaction started while already active")
        self.connection.events.append("begin")
        self.connection.transaction_active = True
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        """Commit success or roll back a propagated exception."""
        del exception, traceback
        if exception_type is None:
            self.connection.events.append("transaction_commit")
        else:
            self.connection.events.append("transaction_rollback")
        self.connection.transaction_active = False
        return False


class FakeConnection:
    """Model the SQL and lifecycle surface used by the migration runner."""

    def __init__(
        self,
        *,
        lock_available: bool = True,
        unlock_succeeds: bool = True,
        session_user: str = "roa_migrator",
        current_user: str = "roa_owner",
        current_revisions: tuple[str, ...] = (EXPECTED_HEAD,),
        current_schemas: tuple[str, ...] = ("public",),
        set_role_error: SQLAlchemyError | None = None,
    ) -> None:
        self.lock_available = lock_available
        self.unlock_succeeds = unlock_succeeds
        self.session_user = session_user
        self.current_user = current_user
        self.current_revisions = current_revisions
        self.current_schemas = current_schemas
        self.set_role_error = set_role_error
        self.events: list[str] = []
        self.transaction_active = False
        self.closed = False
        self.dialect = SimpleNamespace(identifier_preparer=FakeIdentifierPreparer())

    def execute(
        self,
        statement: object,
        parameters: dict[str, object] | None = None,
    ) -> FakeResult:
        """Execute one recognized test statement."""
        del parameters
        sql = str(statement)
        self.transaction_active = True
        if sql == "SELECT session_user":
            self.events.append("session_user")
            return FakeResult(scalar=self.session_user)
        if "pg_try_advisory_lock" in sql:
            self.events.append("lock")
            return FakeResult(scalar=self.lock_available)
        if sql == "SELECT current_user":
            self.events.append("current_user")
            return FakeResult(scalar=self.current_user)
        if sql == "SELECT current_schemas(false)":
            self.events.append("search_path")
            return FakeResult(scalar=list(self.current_schemas))
        if sql.startswith("SELECT version_num"):
            self.events.append("verify")
            return FakeResult(values=self.current_revisions)
        if "pg_advisory_unlock" in sql:
            self.events.append("unlock")
            return FakeResult(scalar=self.unlock_succeeds)
        raise AssertionError(f"Unexpected SQL in test fake: {sql}")

    def exec_driver_sql(self, statement: str) -> None:
        """Execute SET or RESET ROLE without interpreting arbitrary SQL."""
        self.transaction_active = True
        if statement.startswith("SET LOCAL ROLE"):
            self.events.append(f"set_role:{statement}")
            if self.set_role_error is not None:
                raise self.set_role_error
            return
        if statement == "SET LOCAL search_path TO public":
            self.events.append("set_search_path")
            return
        raise AssertionError(f"Unexpected driver SQL in test fake: {statement}")

    def begin(self) -> FakeTransaction:
        """Create one explicit caller-owned fake transaction."""
        return FakeTransaction(self)

    def commit(self) -> None:
        """Record a commit and end the fake transaction."""
        self.events.append("commit")
        self.transaction_active = False

    def rollback(self) -> None:
        """Record a rollback and end the fake transaction."""
        self.events.append("rollback")
        self.transaction_active = False

    def in_transaction(self) -> bool:
        """Return whether a fake implicit transaction is active."""
        return self.transaction_active

    def close(self) -> None:
        """Record connection closure."""
        self.closed = True
        self.events.append("close")


class FakeEngine:
    """Provide one fixed connection and track disposal."""

    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection
        self.disposed = False

    def connect(self) -> FakeConnection:
        """Return the configured fake connection."""
        return self.connection

    def dispose(self) -> None:
        """Record engine disposal."""
        self.disposed = True


def migration_settings(
    *,
    environment: str = "development",
    **overrides: object,
) -> migration_runner.MigrationSettings:
    """Build one synthetic runner configuration without reading the real .env."""
    values: dict[str, object] = {
        "_env_file": None,
        "app_environment": environment,
        "migration_database_url": (
            "postgresql://roa_migrator:"
            f"{MIGRATION_SECRET_MARKER}@db.internal/restaurant"
        ),
        "expected_alembic_head": EXPECTED_HEAD,
    }
    if environment == "production":
        values.update(
            {
                "migration_expected_login_role": "roa_migrator",
                "migration_owner_role": "roa_owner",
            }
        )
    values.update(overrides)
    return migration_runner.MigrationSettings(**values)


def patch_successful_runner(
    monkeypatch: pytest.MonkeyPatch,
    connection: FakeConnection,
) -> tuple[Config, FakeEngine]:
    """Patch repository and engine boundaries while retaining runner logic."""
    config = Config()
    engine = FakeEngine(connection)
    monkeypatch.setattr(migration_runner, "_build_alembic_config", lambda: config)
    monkeypatch.setattr(
        migration_runner,
        "_require_exact_repository_head",
        lambda received_config, expected: None,
    )
    monkeypatch.setattr(
        migration_runner,
        "_create_migration_engine",
        lambda database_url: engine,
    )
    return config, engine


def test_production_refuses_missing_migration_database_url() -> None:
    """Fail closed when production has no migration-only URL."""
    with pytest.raises(ValidationError):
        migration_runner.MigrationSettings(
            _env_file=None,
            app_environment="production",
            expected_alembic_head=EXPECTED_HEAD,
            migration_expected_login_role="roa_migrator",
            migration_owner_role="roa_owner",
        )


def test_runtime_database_url_is_never_a_migration_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ignore a valid runtime URL when the migration-only URL is absent."""
    monkeypatch.setenv(
        "DATABASE_URL",
        (
            "postgresql+psycopg://runtime:"
            f"{RUNTIME_SECRET_MARKER}@db.internal/restaurant"
        ),
    )
    monkeypatch.delenv("MIGRATION_DATABASE_URL", raising=False)

    with pytest.raises(ValidationError) as caught:
        migration_runner.MigrationSettings(
            _env_file=None,
            app_environment="production",
            expected_alembic_head=EXPECTED_HEAD,
            migration_expected_login_role="roa_migrator",
            migration_owner_role="roa_owner",
        )

    assert RUNTIME_SECRET_MARKER not in str(caught.value)
    assert RUNTIME_SECRET_MARKER not in repr(caught.value)


@pytest.mark.parametrize("scheme", ["postgres", "postgresql"])
def test_migration_url_uses_shared_psycopg_normalization(scheme: str) -> None:
    """Normalize provider PostgreSQL schemes without exposing credentials."""
    settings = migration_settings(
        migration_database_url=(
            f"{scheme}://roa_migrator:{MIGRATION_SECRET_MARKER}"
            "@db.internal/restaurant?sslmode=require"
        )
    )

    rendered_url = str(settings.migration_database_url)
    assert rendered_url.startswith("postgresql+psycopg://")
    assert rendered_url.endswith("@db.internal/restaurant?sslmode=require")
    assert MIGRATION_SECRET_MARKER not in repr(settings)
    assert MIGRATION_SECRET_MARKER not in str(settings)


@pytest.mark.parametrize(
    "database_url",
    [
        "mysql://roa_migrator:secret-marker@db.internal/restaurant",
        "postgresql+asyncpg://roa_migrator:secret-marker@db.internal/restaurant",
        "postgresql+psycopg://roa_migrator@db.internal/restaurant",
    ],
)
def test_invalid_migration_urls_are_rejected_without_echo(
    database_url: str,
) -> None:
    """Reject unsupported or credential-incomplete URLs with redacted errors."""
    with pytest.raises(ValidationError) as caught:
        migration_settings(migration_database_url=database_url)
    assert "secret-marker" not in str(caught.value)
    assert "secret-marker" not in repr(caught.value)


def test_development_does_not_require_production_role_variables() -> None:
    """Permit local role reuse while keeping the exact migration URL mandatory."""
    settings = migration_settings()

    assert settings.app_environment == "development"
    assert settings.migration_expected_login_role is None
    assert settings.migration_owner_role is None


@pytest.mark.parametrize(
    "role_name",
    [
        "",
        "roa-owner",
        "roa.owner",
        "roa owner",
        "ROA_OWNER",
        '"roa_owner"',
        "roa_owner;select",
        "9roa_owner",
        "a" * 64,
    ],
)
def test_role_identifier_validation_rejects_unsafe_forms(role_name: str) -> None:
    """Reject quoting, qualification, metacharacters, and noncanonical names."""
    with pytest.raises(ValueError):
        migration_runner.validate_role_identifier(role_name)


@pytest.mark.parametrize(
    "overrides",
    [
        {"migration_expected_login_role": None},
        {"migration_owner_role": None},
    ],
)
def test_production_requires_both_role_identifiers(
    overrides: dict[str, object],
) -> None:
    """Fail closed when either production role boundary is absent."""
    with pytest.raises(ValidationError):
        migration_settings(environment="production", **overrides)


@pytest.mark.parametrize(
    ("login_role", "owner_role"),
    [
        ("postgres", "roa_owner"),
        ("roa_migrator", "postgres"),
        ("roa_owner", "roa_owner"),
    ],
)
def test_production_requires_exact_role_contract(
    login_role: str,
    owner_role: str,
) -> None:
    """Reject safe-looking values that bypass the canonical production roles."""
    with pytest.raises(ValidationError):
        migration_settings(
            environment="production",
            migration_expected_login_role=login_role,
            migration_owner_role=owner_role,
        )


@pytest.mark.parametrize(
    "repository_heads",
    [
        (),
        ("0007_unify_user_auth_roles",),
        (EXPECTED_HEAD, "0009_other_head"),
    ],
)
def test_repository_head_contract_fails_before_engine_creation(
    monkeypatch: pytest.MonkeyPatch,
    repository_heads: tuple[str, ...],
) -> None:
    """Reject zero, mismatched, or multiple repository heads before connection."""

    class FakeScript:
        def get_heads(self) -> tuple[str, ...]:
            return repository_heads

    monkeypatch.setattr(
        migration_runner.ScriptDirectory,
        "from_config",
        staticmethod(lambda config: FakeScript()),
    )
    engine_requested = False

    def forbidden_engine(database_url: object) -> Any:
        nonlocal engine_requested
        engine_requested = True
        raise AssertionError("Engine must not be created")

    monkeypatch.setattr(
        migration_runner,
        "_create_migration_engine",
        forbidden_engine,
    )

    with pytest.raises(migration_runner.MigrationConfigurationError):
        migration_runner.run_migration(migration_settings())

    assert engine_requested is False


def test_advisory_lock_unavailable_fails_immediately() -> None:
    """Return the dedicated lock error without retrying."""
    connection = FakeConnection(lock_available=False)

    with pytest.raises(migration_runner.MigrationLockUnavailableError):
        migration_runner._acquire_migration_lock(connection)  # noqa: SLF001

    assert connection.events == ["lock"]


def test_wrong_production_session_user_is_rejected() -> None:
    """Require the exact configured migration login before role switching."""
    connection = FakeConnection(session_user="unexpected_login")

    with pytest.raises(migration_runner.MigrationRoleError):
        migration_runner._require_expected_login_role(  # noqa: SLF001
            connection,
            "roa_migrator",
        )


def test_set_role_failure_is_sanitized() -> None:
    """Wrap a database SET ROLE error without retaining its raw marker."""
    connection = FakeConnection(
        set_role_error=SQLAlchemyError(f"raw-{MIGRATION_SECRET_MARKER}")
    )

    with pytest.raises(migration_runner.MigrationRoleError) as caught:
        migration_runner._set_owner_role(  # noqa: SLF001
            connection,
            "roa_owner",
        )

    assert MIGRATION_SECRET_MARKER not in str(caught.value)
    assert MIGRATION_SECRET_MARKER not in repr(caught.value)


def test_exact_revision_uses_the_caller_connection_and_never_head(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pass the exact revision and caller-owned connection to Alembic."""
    connection = FakeConnection()
    config, engine = patch_successful_runner(monkeypatch, connection)
    upgrade_calls: list[tuple[object, str]] = []

    def fake_upgrade(received_config: Config, target: str) -> None:
        assert received_config.attributes["connection"] is connection
        connection.events.append("upgrade")
        upgrade_calls.append((received_config, target))

    monkeypatch.setattr(migration_runner.command, "upgrade", fake_upgrade)

    outcome = migration_runner.run_migration(migration_settings())

    assert outcome.current_revisions == (EXPECTED_HEAD,)
    assert upgrade_calls == [(config, EXPECTED_HEAD)]
    assert upgrade_calls[0][1] != "head"
    assert "connection" not in config.attributes
    assert engine.disposed is True
    assert connection.closed is True
    assert connection.events.index("lock") < connection.events.index("upgrade")
    assert connection.events.index("begin") < connection.events.index("set_search_path")
    assert connection.events.index("set_search_path") < connection.events.index(
        "search_path"
    )
    assert connection.events.index("search_path") < connection.events.index("upgrade")
    assert connection.events.index("upgrade") < connection.events.index("verify")
    assert connection.events.index("verify") < connection.events.index("unlock")
    assert "session_user" not in connection.events
    assert not any(event.startswith("set_role:") for event in connection.events)


def test_production_uses_transaction_local_owner_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify canonical identities inside the caller-owned migration transaction."""
    connection = FakeConnection()
    patch_successful_runner(monkeypatch, connection)
    monkeypatch.setattr(
        migration_runner.command,
        "upgrade",
        lambda config, target: connection.events.append("upgrade"),
    )

    migration_runner.run_migration(migration_settings(environment="production"))

    assert connection.events.index("session_user") < connection.events.index("lock")
    assert connection.events.index("lock") < next(
        index
        for index, event in enumerate(connection.events)
        if event == 'set_role:SET LOCAL ROLE "roa_owner"'
    )
    assert connection.events.index("current_user") < connection.events.index("upgrade")
    assert connection.events.index("verify") < connection.events.index(
        "transaction_commit"
    )
    assert connection.events.index("transaction_commit") < connection.events.index(
        "unlock"
    )


def test_final_revision_mismatch_is_rejected_and_lock_is_released(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail verification while still explicitly unlocking the session."""
    connection = FakeConnection(current_revisions=("0007_unify_user_auth_roles",))
    _, engine = patch_successful_runner(monkeypatch, connection)
    monkeypatch.setattr(
        migration_runner.command, "upgrade", lambda config, target: None
    )

    with pytest.raises(migration_runner.MigrationVerificationError):
        migration_runner.run_migration(migration_settings())

    assert connection.events.index("transaction_rollback") < connection.events.index(
        "unlock"
    )
    assert "unlock" in connection.events
    assert connection.closed is True
    assert engine.disposed is True


def test_migration_failure_releases_lock_and_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Release session state even when Alembic raises during the upgrade."""
    connection = FakeConnection()
    _, engine = patch_successful_runner(monkeypatch, connection)

    def failing_upgrade(config: Config, target: str) -> None:
        connection.events.append("upgrade")
        raise RuntimeError(f"raw-{MIGRATION_SECRET_MARKER}")

    monkeypatch.setattr(migration_runner.command, "upgrade", failing_upgrade)

    with pytest.raises(migration_runner.MigrationExecutionError) as caught:
        migration_runner.run_migration(migration_settings())

    assert MIGRATION_SECRET_MARKER not in str(caught.value)
    assert MIGRATION_SECRET_MARKER not in repr(caught.value)
    assert connection.events.index("upgrade") < connection.events.index("unlock")
    assert connection.closed is True
    assert engine.disposed is True


def test_search_path_mismatch_is_rejected_before_upgrade(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject a session that does not resolve only the public migration schema."""
    connection = FakeConnection(current_schemas=("shadow", "public"))
    patch_successful_runner(monkeypatch, connection)
    upgrade_called = False

    def forbidden_upgrade(config: Config, target: str) -> None:
        nonlocal upgrade_called
        upgrade_called = True

    monkeypatch.setattr(migration_runner.command, "upgrade", forbidden_upgrade)

    with pytest.raises(migration_runner.MigrationExecutionError):
        migration_runner.run_migration(migration_settings())

    assert upgrade_called is False
    assert connection.events.index("transaction_rollback") < connection.events.index(
        "unlock"
    )


def test_cli_redacts_unexpected_secret_bearing_error(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Print only the stable generic message for an unexpected internal error."""
    monkeypatch.setattr(
        migration_runner,
        "MigrationSettings",
        lambda: object(),
    )

    def fail_with_secret(settings: object) -> None:
        raise RuntimeError(f"raw-{MIGRATION_SECRET_MARKER}")

    monkeypatch.setattr(migration_runner, "run_migration", fail_with_secret)

    assert migration_runner.main() == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.strip() == "Migration failed."
    assert MIGRATION_SECRET_MARKER not in captured.out + captured.err
