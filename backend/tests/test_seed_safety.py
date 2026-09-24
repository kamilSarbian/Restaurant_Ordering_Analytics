"""Unit tests for seed data, safety, transaction boundaries, and CLI behavior."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import traceback
from collections import Counter
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from zoneinfo import ZoneInfo

import pytest
from pydantic import PostgresDsn, TypeAdapter, ValidationError
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

import app.seed.__main__ as seed_cli
import app.seed.portfolio as seed_portfolio
import app.seed.runner as seed_runner
import tests.integration.conftest as integration_fixtures
from app.demo import generate_portfolio_dataset
from app.demo.dataset import PortfolioSeedPlan
from app.seed.data import CATEGORY_SEEDS, MENU_ITEM_SEEDS
from app.seed.portfolio import (
    PortfolioSeedConflictError,
    PortfolioSeedDatabaseError,
    PortfolioSeedPlanError,
    PortfolioSeedResult,
    PortfolioSeedSchemaError,
    seed_portfolio_data,
)
from app.seed.runner import SeedConflictError, SeedResult, seed_menu_data
from app.seed.safety import (
    DEVELOPMENT_DATABASE_NAME,
    PINNED_HOST,
    REQUIRED_PORT,
    TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES,
    SeedSafetyError,
    validate_local_seed_database_url,
)

APPROVED_DATABASE = "restaurant_ordering_analytics_dev"
SAFE_PASSWORD = "unit-test-password"
ALLERGEN_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
FIXED_REFERENCE_END = datetime(2026, 9, 23, tzinfo=ZoneInfo("Europe/Oslo"))
POSTGRES_DSN_ADAPTER = TypeAdapter(PostgresDsn)


@pytest.fixture(scope="module")
def portfolio_plan() -> PortfolioSeedPlan:
    """Generate the canonical fixed-reference plan once for unit boundaries."""
    return generate_portfolio_dataset(FIXED_REFERENCE_END)


def _database_url(
    *,
    drivername: str = "postgresql+psycopg",
    host: str | None = "127.0.0.1",
    port: int | None = 5433,
    database: str | None = APPROVED_DATABASE,
    username: str | None = "seed_user",
    password: str | None = SAFE_PASSWORD,
) -> str:
    return URL.create(
        drivername=drivername,
        username=username,
        password=password,
        host=host,
        port=port,
        database=database,
    ).render_as_string(hide_password=False)


def _clear_target_changing_postgres_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for variable in TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(variable, raising=False)


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
def test_local_seed_database_url_accepts_approved_hosts(host: str) -> None:
    """Accept local host forms and normalize the effective target without connecting."""
    parsed = validate_local_seed_database_url(_database_url(host=host))
    assert parsed.host == PINNED_HOST
    assert parsed.port == 5433
    assert parsed.database == APPROVED_DATABASE


@pytest.mark.parametrize(
    "database_url",
    [
        _database_url(port=5432),
        _database_url(port=None),
        _database_url(host="database.example.com"),
        _database_url(database="postgres"),
        _database_url(database="restaurant_ordering_analytics_test"),
        _database_url(database="another_database"),
        _database_url(database=None),
        _database_url(username=None),
        _database_url(password=None),
        "sqlite+pysqlite:///:memory:",
    ],
    ids=[
        "port-5432",
        "missing-port",
        "remote-host",
        "administrative-database",
        "test-database",
        "alternative-database",
        "missing-database",
        "missing-username",
        "missing-password",
        "wrong-driver",
    ],
)
def test_local_seed_database_url_rejects_unsafe_targets(
    database_url: str,
) -> None:
    """Reject every target outside the exact local development allowlist."""
    with pytest.raises(SeedSafetyError) as exc_info:
        validate_local_seed_database_url(database_url)

    message = str(exc_info.value)
    assert "://" not in message
    assert SAFE_PASSWORD not in message
    assert "seed_user" not in message


def test_local_seed_database_url_rejects_malformed_value_safely() -> None:
    """Hide malformed input details when URL parsing fails."""
    with pytest.raises(SeedSafetyError) as exc_info:
        validate_local_seed_database_url("not a database URL with private-data")
    assert "private-data" not in str(exc_info.value)


@pytest.mark.parametrize(
    "query",
    [
        "?",
        "?&",
        "?host=",
        "?host=remote.example.com&port=5432&dbname=postgres",
        "?hostaddr=203.0.113.9",
        "?service=private-service",
        "?host=127.0.0.1&host=remote.example.com",
        "?sslmode=require",
    ],
    ids=[
        "empty-query",
        "empty-component",
        "empty-host",
        "full-target-override",
        "hostaddr",
        "service",
        "repeated-host",
        "otherwise-benign-query",
    ],
)
def test_seed_and_integration_validators_reject_every_dsn_query_without_connecting(
    query: str,
) -> None:
    """Reject libpq query overrides in both gates without opening a connection."""
    database_url = POSTGRES_DSN_ADAPTER.validate_python(f"{_database_url()}{query}")

    with pytest.raises(SeedSafetyError) as seed_exc_info:
        validate_local_seed_database_url(database_url)
    with pytest.raises(RuntimeError) as fixture_exc_info:
        integration_fixtures._validate_database_url(
            database_url,
            integration_fixtures.DEVELOPMENT_DATABASE_NAME,
        )

    for message in (str(seed_exc_info.value), str(fixture_exc_info.value)):
        assert "://" not in message
        assert SAFE_PASSWORD not in message
        assert "seed_user" not in message
        assert "remote.example.com" not in message


def test_seed_and_integration_validators_reject_multihost_dsn_safely() -> None:
    """Translate SQLAlchemy's multihost parser failure without leaking input."""
    remote_host = "remote.example.test"
    database_url = POSTGRES_DSN_ADAPTER.validate_python(
        "postgresql+psycopg://seed_user:"
        f"{SAFE_PASSWORD}@127.0.0.1:5433,{remote_host}:5432/"
        f"{APPROVED_DATABASE}"
    )

    with pytest.raises(SeedSafetyError) as seed_exc_info:
        validate_local_seed_database_url(database_url)
    with pytest.raises(RuntimeError) as fixture_exc_info:
        integration_fixtures._validate_database_url(
            database_url,
            integration_fixtures.DEVELOPMENT_DATABASE_NAME,
        )

    for exc_info in (seed_exc_info, fixture_exc_info):
        message = str(exc_info.value)
        assert "invalid" in message.lower()
        assert exc_info.value.__cause__ is None
        assert exc_info.value.__suppress_context__ is True
        assert "postgresql" not in message
        assert SAFE_PASSWORD not in message
        assert "seed_user" not in message
        assert remote_host not in message


@pytest.mark.parametrize(
    "variable",
    sorted(TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES),
)
def test_seed_and_fixture_validators_reject_target_changing_pg_environment(
    variable: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject every ambiguous target variable by presence, including empty values."""
    _clear_target_changing_postgres_environment(monkeypatch)
    monkeypatch.setenv(variable, "")

    with pytest.raises(SeedSafetyError) as seed_exc_info:
        validate_local_seed_database_url(_database_url())
    with pytest.raises(RuntimeError) as fixture_exc_info:
        integration_fixtures._validate_database_url(
            POSTGRES_DSN_ADAPTER.validate_python(_database_url()),
            integration_fixtures.DEVELOPMENT_DATABASE_NAME,
        )

    for message in (str(seed_exc_info.value), str(fixture_exc_info.value)):
        assert "environment variables are not allowed" in message
        assert variable not in message
        assert SAFE_PASSWORD not in message
        assert "://" not in message


def test_benign_pg_environment_does_not_change_local_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Permit non-routing libpq metadata while retaining the exact target."""
    _clear_target_changing_postgres_environment(monkeypatch)
    monkeypatch.setenv("PGAPPNAME", "synthetic-seed-review")

    seed_url = validate_local_seed_database_url(_database_url(host="localhost"))
    fixture_url = integration_fixtures._validate_database_url(
        POSTGRES_DSN_ADAPTER.validate_python(_database_url(host="localhost")),
        integration_fixtures.DEVELOPMENT_DATABASE_NAME,
    )

    assert seed_url.host == PINNED_HOST
    assert fixture_url.host == PINNED_HOST


def test_integration_settings_redact_malformed_dsn_input() -> None:
    """Hide synthetic credentials in Pydantic validation output and traceback."""
    private_username = "synthetic_private_user"
    private_password = "synthetic_private_password"
    raw_database_url = (
        "postgresql+psycopg://"
        f"{private_username}:{private_password}@x:notaport/private_database"
    )

    try:
        integration_fixtures.TestDatabaseSettings(
            _env_file=None,
            database_url=raw_database_url,
        )
    except ValidationError:
        rendered_traceback = traceback.format_exc()
    else:
        pytest.fail("Malformed synthetic database URL was accepted")

    assert raw_database_url not in rendered_traceback
    assert private_username not in rendered_traceback
    assert private_password not in rendered_traceback
    assert "private_database" not in rendered_traceback


def test_integration_fixture_rejects_dsn_query_before_engine_creation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail the fixture before create/drop work when libpq query data is present."""
    unsafe_url = POSTGRES_DSN_ADAPTER.validate_python(
        f"{_database_url()}?host=remote.example.com&port=5432&dbname=postgres"
    )
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    monkeypatch.setattr(
        integration_fixtures,
        "TestDatabaseSettings",
        lambda: SimpleNamespace(database_url=unsafe_url, test_database_url=None),
    )
    monkeypatch.setattr(integration_fixtures, "create_engine", engine)

    fixture_generator = integration_fixtures.test_database_url.__wrapped__()
    with pytest.raises(RuntimeError, match="must not include query parameters"):
        next(fixture_generator)

    engine.assert_not_called()


@pytest.mark.parametrize(
    "variable",
    sorted(TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES),
)
def test_cli_fixture_and_alembic_paths_reject_target_changing_pg_environment(
    variable: str,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject ambient routing controls before every Engine or Alembic boundary."""
    _clear_target_changing_postgres_environment(monkeypatch)
    private_value = f"synthetic-private-{variable.lower()}"
    monkeypatch.setenv(variable, private_value)
    configured_url = _database_url()
    fixture_url = POSTGRES_DSN_ADAPTER.validate_python(configured_url)
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    monkeypatch.setattr(
        seed_cli,
        "Settings",
        lambda: SimpleNamespace(database_url=configured_url),
    )
    monkeypatch.setattr(seed_cli, "create_engine", engine)
    monkeypatch.setattr(
        integration_fixtures,
        "TestDatabaseSettings",
        lambda: SimpleNamespace(database_url=fixture_url, test_database_url=None),
    )
    fixture_engine = Mock(side_effect=AssertionError("Fixture Engine attempted"))
    monkeypatch.setattr(
        integration_fixtures,
        "_create_pinned_engine",
        fixture_engine,
    )

    assert seed_cli.main([]) == 1
    cli_output = capsys.readouterr().out
    assert private_value not in cli_output
    assert configured_url not in cli_output

    fixture_generator = integration_fixtures.test_database_url.__wrapped__()
    with pytest.raises(RuntimeError) as fixture_exc_info:
        next(fixture_generator)
    assert private_value not in str(fixture_exc_info.value)

    isolated_url = URL.create(
        "postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host="127.0.0.1",
        port=5433,
        database=integration_fixtures.TEST_DATABASE_NAME,
    )
    with pytest.raises(RuntimeError):
        with integration_fixtures._temporary_database_url(isolated_url):
            pytest.fail("Alembic environment context was entered")

    engine.assert_not_called()
    fixture_engine.assert_not_called()


def test_cli_and_fixture_paths_reject_multihost_without_private_output(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject a Pydantic-valid multihost DSN through both real entry paths."""
    _clear_target_changing_postgres_environment(monkeypatch)
    remote_host = "remote.example.test"
    raw_database_url = (
        "postgresql+psycopg://seed_user:"
        f"{SAFE_PASSWORD}@127.0.0.1:5433,{remote_host}:5432/"
        f"{APPROVED_DATABASE}"
    )
    multihost_url = POSTGRES_DSN_ADAPTER.validate_python(raw_database_url)
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    monkeypatch.setattr(
        seed_cli,
        "Settings",
        lambda: SimpleNamespace(database_url=multihost_url),
    )
    monkeypatch.setattr(seed_cli, "create_engine", engine)

    assert seed_cli.main([]) == 1
    cli_output = capsys.readouterr().out
    for private_marker in (
        raw_database_url,
        SAFE_PASSWORD,
        "seed_user",
        remote_host,
    ):
        assert private_marker not in cli_output

    monkeypatch.setattr(
        integration_fixtures,
        "TestDatabaseSettings",
        lambda: SimpleNamespace(
            database_url=multihost_url,
            test_database_url=None,
        ),
    )
    fixture_engine = Mock(side_effect=AssertionError("Fixture Engine attempted"))
    monkeypatch.setattr(
        integration_fixtures,
        "_create_pinned_engine",
        fixture_engine,
    )
    fixture_generator = integration_fixtures.test_database_url.__wrapped__()
    try:
        next(fixture_generator)
    except RuntimeError:
        rendered_traceback = traceback.format_exc()
    else:
        pytest.fail("Multihost fixture URL was accepted")

    for private_marker in (
        raw_database_url,
        SAFE_PASSWORD,
        "seed_user",
        remote_host,
    ):
        assert private_marker not in rendered_traceback
    engine.assert_not_called()
    fixture_engine.assert_not_called()


@pytest.mark.parametrize(
    ("database_name", "isolation_level"),
    [
        (integration_fixtures.DEVELOPMENT_DATABASE_NAME, None),
        (integration_fixtures.TEST_DATABASE_NAME, None),
        (integration_fixtures.ADMIN_DATABASE_NAME, "AUTOCOMMIT"),
    ],
)
def test_fixture_engines_pin_the_complete_effective_target_without_connecting(
    database_name: str,
    isolation_level: str | None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pass exact host, hostaddr, port, and database to every fixture Engine."""
    _clear_target_changing_postgres_environment(monkeypatch)
    configured_url = URL.create(
        "postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host="localhost",
        port=5433,
        database=database_name,
    )
    engine = Mock()
    captured_calls: list[tuple[object, dict[str, object]]] = []

    def capture_create_engine(
        database_url: object,
        **engine_options: object,
    ) -> Mock:
        captured_calls.append((database_url, engine_options))
        return engine

    monkeypatch.setattr(
        integration_fixtures,
        "create_engine",
        capture_create_engine,
    )

    result = integration_fixtures._create_pinned_engine(
        configured_url,
        database_name,
        isolation_level=isolation_level,
    )

    assert result is engine
    assert len(captured_calls) == 1
    captured_url, engine_options = captured_calls[0]
    assert isinstance(captured_url, URL)
    assert captured_url.host == PINNED_HOST
    assert engine_options["connect_args"] == {
        "host": PINNED_HOST,
        "hostaddr": PINNED_HOST,
        "port": REQUIRED_PORT,
        "dbname": database_name,
    }
    assert engine_options["hide_parameters"] is True
    assert engine_options["pool_pre_ping"] is True
    if isolation_level is None:
        assert "isolation_level" not in engine_options
    else:
        assert engine_options["isolation_level"] == isolation_level


def test_alembic_cycle_uses_exact_temporary_pins_and_restores_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep controlled loopback pins active for every mocked Alembic command."""
    _clear_target_changing_postgres_environment(monkeypatch)
    previous_database_url = "synthetic-previous-database-url"
    monkeypatch.setenv("DATABASE_URL", previous_database_url)
    isolated_url = URL.create(
        "postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host="localhost",
        port=5433,
        database=integration_fixtures.TEST_DATABASE_NAME,
    )
    expected_tables = {
        "alembic_version",
        "categories",
        "menu_items",
        "order_items",
        "order_status_history",
        "orders",
        "payments",
        "restaurant_tables",
        "stripe_events",
        "users",
    }
    snapshots: list[dict[str, str]] = []
    calls: list[tuple[str, str]] = []

    def capture_pins(action: str, revision: str) -> None:
        database_url = make_url(os.environ["DATABASE_URL"])
        assert database_url.host == PINNED_HOST
        assert database_url.port == REQUIRED_PORT
        assert database_url.database == integration_fixtures.TEST_DATABASE_NAME
        assert database_url.username == "seed_user"
        assert database_url.password == SAFE_PASSWORD
        snapshot = {
            variable: os.environ[variable]
            for variable in ("PGDATABASE", "PGHOST", "PGHOSTADDR", "PGPORT")
        }
        assert snapshot == {
            "PGDATABASE": integration_fixtures.TEST_DATABASE_NAME,
            "PGHOST": PINNED_HOST,
            "PGHOSTADDR": PINNED_HOST,
            "PGPORT": str(REQUIRED_PORT),
        }
        snapshots.append(snapshot)
        calls.append((action, revision))

    monkeypatch.setattr(integration_fixtures, "_alembic_config", object)
    monkeypatch.setattr(
        integration_fixtures.command,
        "upgrade",
        lambda config, revision: capture_pins("upgrade", revision),
    )
    monkeypatch.setattr(
        integration_fixtures.command,
        "downgrade",
        lambda config, revision: capture_pins("downgrade", revision),
    )
    revisions = iter(
        [
            integration_fixtures.HEAD_REVISION,
            integration_fixtures.BASELINE_REVISION,
            integration_fixtures.HEAD_REVISION,
        ]
    )
    table_sets = iter([expected_tables, {"alembic_version"}])
    monkeypatch.setattr(
        integration_fixtures,
        "_current_revision",
        lambda value: next(revisions),
    )
    monkeypatch.setattr(
        integration_fixtures,
        "_public_tables",
        lambda value: next(table_sets),
    )

    integration_fixtures._verify_migration_cycle(isolated_url)

    assert calls == [
        ("upgrade", "head"),
        ("downgrade", integration_fixtures.BASELINE_REVISION),
        ("upgrade", "head"),
    ]
    assert len(snapshots) == 3
    assert os.environ["DATABASE_URL"] == previous_database_url
    for variable in ("PGDATABASE", "PGHOST", "PGHOSTADDR", "PGPORT"):
        assert variable not in os.environ


def test_alembic_connection_failure_is_redacted_and_restores_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Suppress synthetic connection details from migration tracebacks."""
    _clear_target_changing_postgres_environment(monkeypatch)
    previous_database_url = "synthetic-previous-database-url"
    monkeypatch.setenv("DATABASE_URL", previous_database_url)
    isolated_url = URL.create(
        "postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host="127.0.0.1",
        port=5433,
        database=integration_fixtures.TEST_DATABASE_NAME,
    )
    private_dsn = _database_url(host="private.example.test")

    try:
        with integration_fixtures._temporary_database_url(isolated_url):
            raise SQLAlchemyError(f"private connection failure: {private_dsn}")
    except RuntimeError as exc:
        rendered_traceback = traceback.format_exc()
        assert "migration failed" in str(exc)
    else:
        pytest.fail("Synthetic migration failure was not translated")

    assert private_dsn not in rendered_traceback
    assert SAFE_PASSWORD not in rendered_traceback
    assert "private.example.test" not in rendered_traceback
    assert os.environ["DATABASE_URL"] == previous_database_url
    for variable in ("PGDATABASE", "PGHOST", "PGHOSTADDR", "PGPORT"):
        assert variable not in os.environ


def test_fixture_setup_connection_failure_has_a_redacted_traceback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Translate setup failures without retaining synthetic DBAPI details."""
    _clear_target_changing_postgres_environment(monkeypatch)
    configured_url = POSTGRES_DSN_ADAPTER.validate_python(_database_url())
    monkeypatch.setattr(
        integration_fixtures,
        "TestDatabaseSettings",
        lambda: SimpleNamespace(
            database_url=configured_url,
            test_database_url=None,
        ),
    )
    admin_url = URL.create(
        "postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host=PINNED_HOST,
        port=REQUIRED_PORT,
        database=integration_fixtures.ADMIN_DATABASE_NAME,
    )
    engine = Mock()
    engine.url = admin_url
    monkeypatch.setattr(
        integration_fixtures,
        "_create_pinned_engine",
        lambda *args, **kwargs: engine,
    )
    private_dsn = _database_url(host="private.example.test")
    monkeypatch.setattr(
        integration_fixtures,
        "_database_oid",
        Mock(side_effect=SQLAlchemyError(f"private setup failure: {private_dsn}")),
    )

    fixture_generator = integration_fixtures.test_database_url.__wrapped__()
    try:
        next(fixture_generator)
    except RuntimeError as exc:
        rendered_traceback = traceback.format_exc()
        assert "setup failed" in str(exc)
    else:
        pytest.fail("Synthetic fixture setup failure was not translated")

    assert private_dsn not in rendered_traceback
    assert SAFE_PASSWORD not in rendered_traceback
    assert "private.example.test" not in rendered_traceback
    engine.dispose.assert_called_once_with()


def test_fixture_cleanup_connection_failure_has_a_redacted_traceback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prevent cleanup errors from exposing synthetic DBAPI details."""
    _clear_target_changing_postgres_environment(monkeypatch)
    configured_url = POSTGRES_DSN_ADAPTER.validate_python(_database_url())
    monkeypatch.setattr(
        integration_fixtures,
        "TestDatabaseSettings",
        lambda: SimpleNamespace(
            database_url=configured_url,
            test_database_url=None,
        ),
    )
    admin_url = URL.create(
        "postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host=PINNED_HOST,
        port=REQUIRED_PORT,
        database=integration_fixtures.ADMIN_DATABASE_NAME,
    )
    engine = Mock()
    engine.url = admin_url
    monkeypatch.setattr(
        integration_fixtures,
        "_create_pinned_engine",
        lambda *args, **kwargs: engine,
    )
    monkeypatch.setattr(
        integration_fixtures,
        "_database_oid",
        Mock(return_value=123),
    )
    monkeypatch.setattr(integration_fixtures, "_recreate_test_database", Mock())
    monkeypatch.setattr(integration_fixtures, "_verify_migration_cycle", Mock())
    private_dsn = _database_url(host="private.example.test")
    monkeypatch.setattr(
        integration_fixtures,
        "_drop_test_database",
        Mock(side_effect=SQLAlchemyError(f"private cleanup failure: {private_dsn}")),
    )

    fixture_generator = integration_fixtures.test_database_url.__wrapped__()
    yielded_url = next(fixture_generator)
    assert yielded_url.database == integration_fixtures.TEST_DATABASE_NAME
    try:
        fixture_generator.close()
    except RuntimeError as exc:
        rendered_traceback = traceback.format_exc()
        assert "cleanup failed" in str(exc)
    else:
        pytest.fail("Synthetic fixture cleanup failure was not translated")

    assert private_dsn not in rendered_traceback
    assert SAFE_PASSWORD not in rendered_traceback
    assert "private.example.test" not in rendered_traceback
    engine.dispose.assert_called_once_with()


def test_admin_engine_disposal_failure_has_a_redacted_traceback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Translate administrative Engine disposal failures without DB details."""
    _clear_target_changing_postgres_environment(monkeypatch)
    configured_url = POSTGRES_DSN_ADAPTER.validate_python(_database_url())
    monkeypatch.setattr(
        integration_fixtures,
        "TestDatabaseSettings",
        lambda: SimpleNamespace(
            database_url=configured_url,
            test_database_url=None,
        ),
    )
    admin_url = URL.create(
        "postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host=PINNED_HOST,
        port=REQUIRED_PORT,
        database=integration_fixtures.ADMIN_DATABASE_NAME,
    )
    private_dsn = _database_url(host="private.example.test")
    private_error = (
        f"private admin cleanup failure: {private_dsn} "
        "hostaddr=203.0.113.9 dbname=private_database"
    )
    engine = Mock()
    engine.url = admin_url
    engine.dispose.side_effect = SQLAlchemyError(private_error)
    monkeypatch.setattr(
        integration_fixtures,
        "_create_pinned_engine",
        Mock(return_value=engine),
    )
    monkeypatch.setattr(
        integration_fixtures,
        "_database_oid",
        Mock(return_value=123),
    )
    monkeypatch.setattr(integration_fixtures, "_recreate_test_database", Mock())
    monkeypatch.setattr(integration_fixtures, "_verify_migration_cycle", Mock())
    monkeypatch.setattr(integration_fixtures, "_drop_test_database", Mock())

    fixture_generator = integration_fixtures.test_database_url.__wrapped__()
    assert next(fixture_generator).database == integration_fixtures.TEST_DATABASE_NAME
    try:
        fixture_generator.close()
    except RuntimeError as exc:
        rendered_traceback = traceback.format_exc()
        assert "engine cleanup failed" in str(exc)
    else:
        pytest.fail("Synthetic admin Engine cleanup failure was not translated")

    for private_marker in (
        private_dsn,
        SAFE_PASSWORD,
        "private.example.test",
        "203.0.113.9",
        "private_database",
    ):
        assert private_marker not in rendered_traceback


def test_engine_fixture_setup_failure_has_a_redacted_traceback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Translate Engine construction failures at the fixture boundary."""
    _clear_target_changing_postgres_environment(monkeypatch)
    isolated_url = URL.create(
        "postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host=PINNED_HOST,
        port=REQUIRED_PORT,
        database=integration_fixtures.TEST_DATABASE_NAME,
    )
    private_dsn = _database_url(host="private.example.test")
    private_error = (
        f"private Engine failure: {private_dsn} "
        "hostaddr=203.0.113.9 dbname=private_database"
    )
    monkeypatch.setattr(
        integration_fixtures,
        "_create_pinned_engine",
        Mock(side_effect=SQLAlchemyError(private_error)),
    )

    fixture_generator = integration_fixtures.test_database_engine.__wrapped__(
        isolated_url
    )
    try:
        next(fixture_generator)
    except RuntimeError as exc:
        rendered_traceback = traceback.format_exc()
        assert "engine setup failed" in str(exc)
    else:
        pytest.fail("Synthetic Engine fixture failure was not translated")

    for private_marker in (
        private_dsn,
        SAFE_PASSWORD,
        "private.example.test",
        "203.0.113.9",
        "private_database",
    ):
        assert private_marker not in rendered_traceback


def test_engine_fixture_cleanup_failure_has_a_redacted_traceback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Translate Engine disposal failures at the fixture boundary."""
    _clear_target_changing_postgres_environment(monkeypatch)
    isolated_url = URL.create(
        "postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host=PINNED_HOST,
        port=REQUIRED_PORT,
        database=integration_fixtures.TEST_DATABASE_NAME,
    )
    private_dsn = _database_url(host="private.example.test")
    private_error = (
        f"private Engine cleanup failure: {private_dsn} "
        "hostaddr=203.0.113.9 dbname=private_database"
    )
    engine = Mock()
    engine.dispose.side_effect = SQLAlchemyError(private_error)
    monkeypatch.setattr(
        integration_fixtures,
        "_create_pinned_engine",
        Mock(return_value=engine),
    )

    fixture_generator = integration_fixtures.test_database_engine.__wrapped__(
        isolated_url
    )
    assert next(fixture_generator) is engine
    try:
        fixture_generator.close()
    except RuntimeError as exc:
        rendered_traceback = traceback.format_exc()
        assert "engine cleanup failed" in str(exc)
    else:
        pytest.fail("Synthetic Engine cleanup failure was not translated")

    for private_marker in (
        private_dsn,
        SAFE_PASSWORD,
        "private.example.test",
        "203.0.113.9",
        "private_database",
    ):
        assert private_marker not in rendered_traceback


@pytest.mark.parametrize("failure_phase", ["connect", "begin"])
def test_db_session_setup_failure_has_a_redacted_traceback(
    failure_phase: str,
) -> None:
    """Translate session connect and transaction setup failures safely."""
    private_dsn = _database_url(host="private.example.test")
    private_error = (
        f"private session setup failure: {private_dsn} "
        "hostaddr=203.0.113.9 dbname=private_database"
    )
    engine = Mock()
    connection = Mock()
    if failure_phase == "connect":
        engine.connect.side_effect = SQLAlchemyError(private_error)
    else:
        engine.connect.return_value = connection
        connection.begin.side_effect = SQLAlchemyError(private_error)

    fixture_generator = integration_fixtures.db_session.__wrapped__(engine)
    try:
        next(fixture_generator)
    except RuntimeError as exc:
        rendered_traceback = traceback.format_exc()
        assert "session setup failed" in str(exc)
    else:
        pytest.fail("Synthetic session setup failure was not translated")

    for private_marker in (
        private_dsn,
        SAFE_PASSWORD,
        "private.example.test",
        "203.0.113.9",
        "private_database",
    ):
        assert private_marker not in rendered_traceback
    if failure_phase == "begin":
        connection.close.assert_called_once_with()


def test_db_session_cleanup_failure_is_redacted_and_releases_resources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Attempt all session cleanup operations while hiding private failures."""
    private_dsn = _database_url(host="private.example.test")
    private_error = (
        f"private session cleanup failure: {private_dsn} "
        "hostaddr=203.0.113.9 dbname=private_database"
    )
    engine = Mock()
    connection = Mock()
    outer_transaction = Mock()
    outer_transaction.is_active = True
    session = Mock()
    session.close.side_effect = SQLAlchemyError(private_error)
    engine.connect.return_value = connection
    connection.begin.return_value = outer_transaction
    monkeypatch.setattr(integration_fixtures, "Session", Mock(return_value=session))

    fixture_generator = integration_fixtures.db_session.__wrapped__(engine)
    assert next(fixture_generator) is session
    try:
        fixture_generator.close()
    except RuntimeError as exc:
        rendered_traceback = traceback.format_exc()
        assert "session cleanup failed" in str(exc)
    else:
        pytest.fail("Synthetic session cleanup failure was not translated")

    for private_marker in (
        private_dsn,
        SAFE_PASSWORD,
        "private.example.test",
        "203.0.113.9",
        "private_database",
    ):
        assert private_marker not in rendered_traceback
    outer_transaction.rollback.assert_called_once_with()
    connection.close.assert_called_once_with()


def test_seed_dataset_matches_the_approved_contract() -> None:
    """Validate counts, identities, relationships, and business boundaries."""
    category_ids = {seed.id for seed in CATEGORY_SEEDS}
    menu_item_ids = {seed.id for seed in MENU_ITEM_SEEDS}
    all_ids = category_ids | menu_item_ids

    assert len(CATEGORY_SEEDS) == 5
    assert len(MENU_ITEM_SEEDS) == 15
    assert len(category_ids) == 5
    assert len(menu_item_ids) == 15
    assert len(all_ids) == 20
    assert Counter(item.category_id for item in MENU_ITEM_SEEDS) == {
        category_id: 3 for category_id in category_ids
    }
    assert all(item.category_id in category_ids for item in MENU_ITEM_SEEDS)

    category_names = [seed.name.strip().lower() for seed in CATEGORY_SEEDS]
    product_names = [
        (seed.category_id, seed.name.strip().lower()) for seed in MENU_ITEM_SEEDS
    ]
    assert len(category_names) == len(set(category_names))
    assert len(product_names) == len(set(product_names))
    assert all(seed.name.strip() for seed in (*CATEGORY_SEEDS, *MENU_ITEM_SEEDS))
    assert all(seed.price_amount > 0 for seed in MENU_ITEM_SEEDS)
    assert all(
        seed.cost_amount is None or seed.cost_amount >= 0 for seed in MENU_ITEM_SEEDS
    )
    assert all(seed.currency == "NOK" for seed in MENU_ITEM_SEEDS)
    assert all(seed.image_url is None for seed in MENU_ITEM_SEEDS)
    assert all(seed.display_order >= 0 for seed in CATEGORY_SEEDS)
    assert all(seed.display_order >= 0 for seed in MENU_ITEM_SEEDS)
    assert all(seed.is_active for seed in (*CATEGORY_SEEDS, *MENU_ITEM_SEEDS))
    assert sum(not seed.is_available for seed in MENU_ITEM_SEEDS) == 1
    assert any(seed.cost_amount is None for seed in MENU_ITEM_SEEDS)
    assert all(seed.cost_amount != 0 for seed in MENU_ITEM_SEEDS)
    assert sum(not seed.allergens for seed in MENU_ITEM_SEEDS) == 3
    assert all(
        ALLERGEN_PATTERN.fullmatch(allergen)
        for seed in MENU_ITEM_SEEDS
        for allergen in seed.allergens
    )


def test_seed_imports_have_no_engine_or_connection_side_effects() -> None:
    """Import seed modules in a fresh process without integration side effects."""
    backend_root = Path(__file__).resolve().parents[1]
    child_environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper() not in {"DATABASE_URL", "TEST_DATABASE_URL", "POSTGRES_PASSWORD"}
    }
    child_environment["PYTHONIOENCODING"] = "utf-8"
    import_code = """
import sqlalchemy

def forbidden_create_engine(*args, **kwargs):
    raise RuntimeError("Engine creation during import")

sqlalchemy.create_engine = forbidden_create_engine

import app.seed
import app.seed.data
import app.seed.portfolio
import app.seed.runner
import app.seed.safety

from datetime import datetime
from zoneinfo import ZoneInfo
from app.demo import generate_portfolio_dataset

plan = generate_portfolio_dataset(
    datetime(2026, 9, 23, tzinfo=ZoneInfo("Europe/Oslo"))
)
assert plan.canonical_sha256 == (
    "716200cc31feebe72a1dc237175e5c5780075bffa055a7086430dedb823bb9f3"
)
assert plan.canonical_size_bytes == 1_456_799
"""

    completed = subprocess.run(
        [sys.executable, "-c", import_code],
        cwd=backend_root,
        env=child_environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0
    assert completed.stdout == ""
    assert completed.stderr == ""


def test_seed_runner_uses_one_transaction_and_one_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Run every seed phase in order through one transaction-owned session."""
    session = object()
    calls: list[tuple[str, object]] = []

    class FakeSessionFactory:
        @contextmanager
        def begin(self):
            calls.append(("begin", session))
            yield session
            calls.append(("commit", session))

    monkeypatch.setattr(
        seed_runner,
        "_preflight_category_conflicts",
        lambda value: calls.append(("category_preflight", value)),
    )
    monkeypatch.setattr(
        seed_runner,
        "_preflight_menu_item_conflicts",
        lambda value: calls.append(("menu_item_preflight", value)),
    )
    monkeypatch.setattr(
        seed_runner,
        "_upsert_categories",
        lambda value: calls.append(("category_upsert", value)),
    )
    monkeypatch.setattr(
        seed_runner,
        "_upsert_menu_items",
        lambda value: calls.append(("menu_item_upsert", value)),
    )

    result = seed_menu_data(FakeSessionFactory())  # type: ignore[arg-type]

    assert result == SeedResult(categories_processed=5, menu_items_processed=15)
    assert calls == [
        ("begin", session),
        ("category_preflight", session),
        ("menu_item_preflight", session),
        ("category_upsert", session),
        ("menu_item_upsert", session),
        ("commit", session),
    ]


def test_cli_help_exits_before_settings_engine_and_runner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Let argparse finish help before any configuration or integration work."""
    settings = Mock(side_effect=AssertionError("Settings creation attempted"))
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    runner = Mock(side_effect=AssertionError("Seed execution attempted"))
    monkeypatch.setattr(seed_cli, "Settings", settings)
    monkeypatch.setattr(seed_cli, "create_engine", engine)
    monkeypatch.setattr(seed_cli, "seed_menu_data", runner)

    with pytest.raises(SystemExit) as exc_info:
        seed_cli.main(["--help"])

    assert exc_info.value.code == 0
    settings.assert_not_called()
    engine.assert_not_called()
    runner.assert_not_called()


@pytest.mark.parametrize("option", ["--p", "--portfolio", "--unknown"])
def test_cli_rejects_abbreviated_and_unknown_options_before_integrations(
    option: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject non-exact options before configuration, generation, or engine work."""
    settings = Mock(side_effect=AssertionError("Settings creation attempted"))
    generator = Mock(side_effect=AssertionError("Portfolio generation attempted"))
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    menu_runner = Mock(side_effect=AssertionError("Menu seed attempted"))
    portfolio_runner = Mock(side_effect=AssertionError("Portfolio seed attempted"))
    monkeypatch.setattr(seed_cli, "Settings", settings)
    monkeypatch.setattr(seed_cli, "generate_portfolio_dataset", generator)
    monkeypatch.setattr(seed_cli, "create_engine", engine)
    monkeypatch.setattr(seed_cli, "seed_menu_data", menu_runner)
    monkeypatch.setattr(seed_cli, "seed_portfolio_data", portfolio_runner)

    with pytest.raises(SystemExit) as exc_info:
        seed_cli.main([option, "2026-09-23T00:00:00+02:00"])

    assert exc_info.value.code == 2
    settings.assert_not_called()
    generator.assert_not_called()
    engine.assert_not_called()
    menu_runner.assert_not_called()
    portfolio_runner.assert_not_called()


def test_cli_rejects_missing_database_url(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Return a safe nonzero result when DATABASE_URL is absent."""
    monkeypatch.setattr(
        seed_cli,
        "Settings",
        lambda: SimpleNamespace(database_url=None),
    )
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    monkeypatch.setattr(seed_cli, "create_engine", engine)

    assert seed_cli.main([]) == 1
    assert "DATABASE_URL is required" in capsys.readouterr().out
    engine.assert_not_called()


def test_cli_rejects_unsafe_url_before_engine_creation(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Apply the allowlist before constructing an engine."""
    unsafe_url = _database_url(host="remote.example.com")
    monkeypatch.setattr(
        seed_cli,
        "Settings",
        lambda: SimpleNamespace(database_url=unsafe_url),
    )
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    monkeypatch.setattr(seed_cli, "create_engine", engine)

    assert seed_cli.main([]) == 1
    output = capsys.readouterr().out
    assert "://" not in output
    assert SAFE_PASSWORD not in output
    assert "seed_user" not in output
    engine.assert_not_called()


def test_cli_passes_complete_validated_url_to_engine_without_reporting_it(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Preserve credentials internally when the validated URL reaches the engine."""
    configured_url = _database_url()
    validated_url = URL.create(
        drivername="postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host="127.0.0.1",
        port=5433,
        database=APPROVED_DATABASE,
    )
    engine = Mock()
    captured_arguments: list[tuple[object, dict[str, object]]] = []

    def capture_create_engine(
        database_url: object,
        **engine_options: object,
    ) -> Mock:
        captured_arguments.append((database_url, engine_options))
        return engine

    monkeypatch.setattr(
        seed_cli,
        "Settings",
        lambda: SimpleNamespace(database_url=configured_url),
    )
    monkeypatch.setattr(
        seed_cli,
        "validate_local_seed_database_url",
        lambda value: validated_url,
    )
    monkeypatch.setattr(seed_cli, "create_engine", capture_create_engine)
    monkeypatch.setattr(seed_cli, "create_session_factory", lambda value: object())
    monkeypatch.setattr(
        seed_cli,
        "seed_menu_data",
        lambda value: SeedResult(5, 15),
    )

    assert seed_cli.main([]) == 0
    assert len(captured_arguments) == 1
    captured_url, engine_options = captured_arguments[0]
    assert captured_url is validated_url
    assert isinstance(captured_url, URL)
    assert not isinstance(captured_url, str)
    assert captured_url.password == SAFE_PASSWORD
    assert engine_options == {
        "pool_pre_ping": True,
        "hide_parameters": True,
        "connect_args": {
            "host": PINNED_HOST,
            "hostaddr": PINNED_HOST,
            "port": REQUIRED_PORT,
            "dbname": DEVELOPMENT_DATABASE_NAME,
        },
    }
    output = capsys.readouterr().out
    assert SAFE_PASSWORD not in output
    assert "://" not in output
    engine.dispose.assert_called_once_with()


@pytest.mark.parametrize(
    ("error", "expected_message"),
    [
        (SeedConflictError("Category name conflicts with seed data."), "conflicts"),
        (SQLAlchemyError("private database detail"), "did not complete"),
    ],
)
def test_cli_reports_runner_errors_safely_and_disposes_engine(
    error: Exception,
    expected_message: str,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Return nonzero, hide integration details, and always dispose the engine."""
    database_url = _database_url()
    engine = Mock()
    monkeypatch.setattr(
        seed_cli,
        "Settings",
        lambda: SimpleNamespace(database_url=database_url),
    )
    monkeypatch.setattr(
        seed_cli,
        "validate_local_seed_database_url",
        lambda value: URL.create("postgresql+psycopg", database="approved"),
    )
    monkeypatch.setattr(
        seed_cli,
        "create_engine",
        lambda value, **kwargs: engine,
    )
    monkeypatch.setattr(seed_cli, "create_session_factory", lambda value: object())
    monkeypatch.setattr(seed_cli, "seed_menu_data", Mock(side_effect=error))

    assert seed_cli.main([]) == 1
    output = capsys.readouterr().out
    assert expected_message in output
    assert "://" not in output
    assert SAFE_PASSWORD not in output
    assert "private database detail" not in output
    engine.dispose.assert_called_once_with()


def test_cli_reports_engine_disposal_errors_without_private_details(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Return failure when Engine cleanup fails without exposing its cause."""
    engine = Mock()
    private_dsn = _database_url(host="private.example.test")
    engine.dispose.side_effect = SQLAlchemyError(
        f"private cleanup failure: {private_dsn} hostaddr=203.0.113.9"
    )
    monkeypatch.setattr(
        seed_cli,
        "Settings",
        lambda: SimpleNamespace(database_url=_database_url()),
    )
    monkeypatch.setattr(
        seed_cli,
        "validate_local_seed_database_url",
        lambda value: URL.create("postgresql+psycopg", database="approved"),
    )
    monkeypatch.setattr(
        seed_cli,
        "create_engine",
        lambda value, **kwargs: engine,
    )
    monkeypatch.setattr(seed_cli, "create_session_factory", lambda value: object())
    monkeypatch.setattr(
        seed_cli,
        "seed_menu_data",
        lambda value: SeedResult(5, 15),
    )

    assert seed_cli.main([]) == 1
    output = capsys.readouterr().out
    assert "database cleanup did not complete" in output
    for private_marker in (
        private_dsn,
        SAFE_PASSWORD,
        "private.example.test",
        "203.0.113.9",
    ):
        assert private_marker not in output


def test_cli_without_portfolio_option_remains_menu_only(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep the legacy no-argument command isolated from portfolio generation."""
    engine = Mock()
    generator = Mock(side_effect=AssertionError("Portfolio generation attempted"))
    portfolio_runner = Mock(side_effect=AssertionError("Portfolio seed attempted"))
    menu_runner = Mock(return_value=SeedResult(5, 15))
    monkeypatch.setattr(seed_cli, "generate_portfolio_dataset", generator)
    monkeypatch.setattr(seed_cli, "seed_portfolio_data", portfolio_runner)
    monkeypatch.setattr(seed_cli, "seed_menu_data", menu_runner)
    monkeypatch.setattr(
        seed_cli,
        "Settings",
        lambda: SimpleNamespace(database_url=_database_url()),
    )
    monkeypatch.setattr(
        seed_cli,
        "validate_local_seed_database_url",
        lambda value: URL.create("postgresql+psycopg", database="approved"),
    )
    monkeypatch.setattr(seed_cli, "create_engine", lambda value, **kwargs: engine)
    monkeypatch.setattr(seed_cli, "create_session_factory", lambda value: object())

    assert seed_cli.main([]) == 0
    assert "5 categories and 15 menu items" in capsys.readouterr().out
    generator.assert_not_called()
    portfolio_runner.assert_not_called()
    menu_runner.assert_called_once()
    engine.dispose.assert_called_once_with()


@pytest.mark.parametrize(
    "reference_end",
    [
        "not-a-private-reference",
        "2026-09-23T00:00:00",
        "2026-09-23T01:00:00+02:00",
    ],
    ids=["malformed", "naive", "not-oslo-midnight"],
)
def test_portfolio_cli_rejects_invalid_reference_before_settings_and_engine(
    reference_end: str,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject invalid explicit boundaries before configuration or integration."""
    settings = Mock(side_effect=AssertionError("Settings creation attempted"))
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))
    monkeypatch.setattr(seed_cli, "Settings", settings)
    monkeypatch.setattr(seed_cli, "create_engine", engine)

    assert seed_cli.main(["--portfolio-reference-end", reference_end]) == 1
    output = capsys.readouterr().out
    assert reference_end not in output
    assert "Seed failed" in output
    settings.assert_not_called()
    engine.assert_not_called()


def test_portfolio_cli_generates_before_engine_and_uses_opt_in_runner(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Generate the complete opt-in plan before constructing an engine."""
    configured_url = _database_url()
    validated_url = URL.create(
        "postgresql+psycopg",
        username="seed_user",
        password=SAFE_PASSWORD,
        host="127.0.0.1",
        port=5433,
        database=APPROVED_DATABASE,
    )
    engine = Mock()
    plan = object()
    session_factory = object()
    events: list[str] = []

    def generate(reference_end: datetime) -> object:
        assert reference_end == FIXED_REFERENCE_END
        events.append("generate")
        return plan

    def settings() -> SimpleNamespace:
        events.append("settings")
        return SimpleNamespace(database_url=configured_url)

    def validate(value: object) -> URL:
        events.append("validate")
        return validated_url

    def create(value: object, **kwargs: object) -> Mock:
        events.append("engine")
        return engine

    def create_factory(value: object) -> object:
        events.append("factory")
        return session_factory

    def persist(factory: object, value: object) -> PortfolioSeedResult:
        assert factory is session_factory
        assert value is plan
        events.append("portfolio")
        return PortfolioSeedResult(
            inserted=True,
            categories_processed=5,
            menu_items_processed=15,
            tables_processed=12,
            orders_processed=500,
            order_items_processed=1_211,
            status_history_processed=2_326,
            payments_processed=484,
        )

    menu_runner = Mock(side_effect=AssertionError("Menu-only runner attempted"))
    monkeypatch.setattr(seed_cli, "generate_portfolio_dataset", generate)
    monkeypatch.setattr(seed_cli, "Settings", settings)
    monkeypatch.setattr(seed_cli, "validate_local_seed_database_url", validate)
    monkeypatch.setattr(seed_cli, "create_engine", create)
    monkeypatch.setattr(seed_cli, "create_session_factory", create_factory)
    monkeypatch.setattr(seed_cli, "seed_portfolio_data", persist)
    monkeypatch.setattr(seed_cli, "seed_menu_data", menu_runner)

    assert (
        seed_cli.main(["--portfolio-reference-end", "2026-09-23T00:00:00+02:00"]) == 0
    )
    assert events == [
        "generate",
        "settings",
        "validate",
        "engine",
        "factory",
        "portfolio",
    ]
    assert "500 orders inserted" in capsys.readouterr().out
    menu_runner.assert_not_called()
    engine.dispose.assert_called_once_with()


def test_portfolio_cli_rejects_unsafe_url_after_generation_before_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep the existing local allowlist on the explicit portfolio path."""
    events: list[str] = []
    plan = object()
    engine = Mock(side_effect=AssertionError("Engine creation attempted"))

    def generate(reference_end: datetime) -> object:
        events.append("generate")
        return plan

    def settings() -> SimpleNamespace:
        events.append("settings")
        return SimpleNamespace(database_url=_database_url(host="remote.example.com"))

    monkeypatch.setattr(seed_cli, "generate_portfolio_dataset", generate)
    monkeypatch.setattr(seed_cli, "Settings", settings)
    monkeypatch.setattr(seed_cli, "create_engine", engine)

    assert (
        seed_cli.main(["--portfolio-reference-end", "2026-09-23T00:00:00+02:00"]) == 1
    )
    assert events == ["generate", "settings"]
    engine.assert_not_called()


def test_portfolio_cli_reports_conflicts_without_database_details(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Expose only the adapter's constant conflict message at the CLI boundary."""
    engine = Mock()
    monkeypatch.setattr(seed_cli, "generate_portfolio_dataset", lambda value: object())
    monkeypatch.setattr(
        seed_cli,
        "Settings",
        lambda: SimpleNamespace(database_url=_database_url()),
    )
    monkeypatch.setattr(
        seed_cli,
        "validate_local_seed_database_url",
        lambda value: URL.create("postgresql+psycopg", database="approved"),
    )
    monkeypatch.setattr(seed_cli, "create_engine", lambda value, **kwargs: engine)
    monkeypatch.setattr(seed_cli, "create_session_factory", lambda value: object())
    monkeypatch.setattr(
        seed_cli,
        "seed_portfolio_data",
        Mock(
            side_effect=PortfolioSeedConflictError(
                "Portfolio seed conflicts with existing database records."
            )
        ),
    )

    assert (
        seed_cli.main(["--portfolio-reference-end", "2026-09-23T00:00:00+02:00"]) == 1
    )
    output = capsys.readouterr().out
    assert "conflicts with existing database records" in output
    assert SAFE_PASSWORD not in output
    assert "SELECT" not in output
    assert "://" not in output
    engine.dispose.assert_called_once_with()


class _RecordingFactory:
    def __init__(self, session: object, calls: list[str]) -> None:
        self._session = session
        self._calls = calls

    @contextmanager
    def begin(self):
        self._calls.append("begin")
        try:
            yield self._session
        except Exception:
            self._calls.append("rollback")
            raise
        else:
            self._calls.append("commit")


class _ScalarResult:
    def __init__(self, values: tuple[str, ...]) -> None:
        self._values = values

    def scalars(self) -> tuple[str, ...]:
        return self._values


def _assert_fully_sanitized_portfolio_error(
    error: Exception,
    *,
    expected_type: type[Exception],
    expected_message: str,
    forbidden_markers: tuple[str, ...],
) -> None:
    """Assert that a public portfolio error has no reachable private chain."""
    assert type(error) is expected_type
    assert str(error) == expected_message
    assert error.args == (expected_message,)
    assert vars(error) == {}
    assert error.__cause__ is None
    assert error.__context__ is None

    rendered = "".join(traceback.format_exception(error, chain=True))
    assert expected_message in rendered
    public_material = (str(error), repr(error), rendered)
    for marker in forbidden_markers:
        assert all(marker not in value for value in public_material)


def test_portfolio_schema_lookup_failure_is_fully_redacted(
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Remove raw schema-query failures from the public exception graph."""
    calls: list[str] = []
    private_marker = "SCHEMA_LOOKUP_PRIVATE_MARKER"

    class Session:
        def execute(self, statement: object) -> _ScalarResult:
            calls.append("schema")
            raise SQLAlchemyError(private_marker)

    with pytest.raises(PortfolioSeedSchemaError) as exc_info:
        seed_portfolio_data(
            _RecordingFactory(Session(), calls),  # type: ignore[arg-type]
            portfolio_plan,
        )

    assert calls == ["begin", "schema", "rollback"]
    _assert_fully_sanitized_portfolio_error(
        exc_info.value,
        expected_type=PortfolioSeedSchemaError,
        expected_message="The database schema revision could not be verified.",
        forbidden_markers=(private_marker,),
    )


@pytest.mark.parametrize(
    "revisions",
    [
        (),
        ("0008_add_order_ownership",),
        ("unexpected",),
        (
            "0008_add_order_ownership",
            "0009_add_portfolio_demo_origin_and_payment_provider",
        ),
    ],
    ids=["missing", "old", "unexpected", "ambiguous"],
)
def test_portfolio_wrong_schema_is_first_query_and_performs_zero_dml(
    revisions: tuple[str, ...],
    portfolio_plan: PortfolioSeedPlan,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail before menu or portfolio DML unless the sole head is exact 0009."""
    calls: list[str] = []

    class Session:
        def execute(self, statement: object) -> _ScalarResult:
            calls.append(str(statement))
            return _ScalarResult(revisions)

    menu_runner = Mock(side_effect=AssertionError("Menu DML attempted"))
    exact_menu_reader = Mock(side_effect=AssertionError("Menu read attempted"))
    monkeypatch.setattr(seed_portfolio, "seed_menu_data_in_session", menu_runner)
    monkeypatch.setattr(seed_portfolio, "require_exact_menu_data", exact_menu_reader)
    factory = _RecordingFactory(Session(), calls)

    with pytest.raises(PortfolioSeedSchemaError):
        seed_portfolio_data(factory, portfolio_plan)  # type: ignore[arg-type]

    assert calls[0] == "begin"
    assert "public.alembic_version" in calls[1]
    assert calls[2] == "rollback"
    assert len(calls) == 3
    menu_runner.assert_not_called()
    exact_menu_reader.assert_not_called()


def test_portfolio_runner_uses_one_transaction_and_ordered_phases(
    portfolio_plan: PortfolioSeedPlan,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep schema, menu, insert, and verification in one transaction."""
    calls: list[str] = []
    session = object()
    expected = seed_portfolio._validated_expected_rows(portfolio_plan)
    monkeypatch.setattr(
        seed_portfolio,
        "_validated_expected_rows",
        lambda value: expected,
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_require_exact_schema_revision",
        lambda value: calls.append("schema"),
    )
    monkeypatch.setattr(
        seed_portfolio,
        "seed_menu_data_in_session",
        lambda value: calls.append("menu") or SeedResult(5, 15),
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_classify_portfolio_state",
        lambda value, rows: calls.append("classify") or "empty",
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_insert_expected_rows",
        lambda value, rows: calls.append("insert"),
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_require_exact_rows",
        lambda value, rows: calls.append("verify"),
    )

    result = seed_portfolio_data(
        _RecordingFactory(session, calls),  # type: ignore[arg-type]
        portfolio_plan,
    )

    assert result.inserted is True
    assert result.orders_processed == 500
    assert calls == [
        "begin",
        "schema",
        "classify",
        "menu",
        "insert",
        "verify",
        "commit",
    ]


def test_portfolio_adapter_rejects_noncanonical_plan_before_transaction(
    portfolio_plan: PortfolioSeedPlan,
) -> None:
    """Reject a structurally valid drifted plan before opening a transaction."""
    first_order = portfolio_plan.orders[0]
    changed_order = replace(
        first_order,
        updated_at=first_order.updated_at + timedelta(microseconds=1),
    )
    changed_plan = replace(
        portfolio_plan,
        orders=(changed_order, *portfolio_plan.orders[1:]),
    )
    factory = Mock(side_effect=AssertionError("Transaction attempted"))

    with pytest.raises(PortfolioSeedPlanError, match="not the canonical"):
        seed_portfolio_data(factory, changed_plan)  # type: ignore[arg-type]

    factory.assert_not_called()


def test_portfolio_plan_generation_failure_is_fully_redacted(
    portfolio_plan: PortfolioSeedPlan,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Remove generator internals from a sanitized pre-transaction failure."""
    private_marker = "PLAN_GENERATION_PRIVATE_MARKER"
    factory = Mock(side_effect=AssertionError("Transaction attempted"))

    def fail_generation(reference_end: datetime) -> PortfolioSeedPlan:
        raise seed_portfolio.PortfolioDatasetError(private_marker)

    monkeypatch.setattr(
        seed_portfolio,
        "generate_portfolio_dataset",
        fail_generation,
    )

    with pytest.raises(PortfolioSeedPlanError) as exc_info:
        seed_portfolio_data(factory, portfolio_plan)  # type: ignore[arg-type]

    factory.assert_not_called()
    _assert_fully_sanitized_portfolio_error(
        exc_info.value,
        expected_type=PortfolioSeedPlanError,
        expected_message="Portfolio seed identity could not be validated.",
        forbidden_markers=(private_marker,),
    )


def test_portfolio_menu_conflict_rolls_back_as_adapter_conflict(
    portfolio_plan: PortfolioSeedPlan,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Translate a canonical-menu ownership conflict after transaction rollback."""
    calls: list[str] = []
    menu_marker = "MENU_CONFLICT_PRIVATE_MARKER"
    database_marker = "MENU_DATABASE_PRIVATE_MARKER"
    expected = seed_portfolio._validated_expected_rows(portfolio_plan)
    monkeypatch.setattr(
        seed_portfolio,
        "_validated_expected_rows",
        lambda value: expected,
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_require_exact_schema_revision",
        lambda value: calls.append("schema"),
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_classify_portfolio_state",
        lambda value, rows: calls.append("classify") or "empty",
    )

    def fail_menu(value: object) -> SeedResult:
        calls.append("menu")
        try:
            raise SQLAlchemyError(database_marker)
        except SQLAlchemyError as exc:
            raise SeedConflictError(menu_marker) from exc

    monkeypatch.setattr(seed_portfolio, "seed_menu_data_in_session", fail_menu)

    with pytest.raises(PortfolioSeedConflictError) as exc_info:
        seed_portfolio_data(
            _RecordingFactory(object(), calls),  # type: ignore[arg-type]
            portfolio_plan,
        )

    assert calls == ["begin", "schema", "classify", "menu", "rollback"]
    _assert_fully_sanitized_portfolio_error(
        exc_info.value,
        expected_type=PortfolioSeedConflictError,
        expected_message=(
            "Canonical menu data conflicts with existing database records."
        ),
        forbidden_markers=(menu_marker, database_marker),
    )


def test_portfolio_integrity_failure_rolls_back_and_is_sanitized(
    portfolio_plan: PortfolioSeedPlan,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Translate an integrity race only after the transaction rolls back."""
    calls: list[str] = []
    statement_marker = "INTEGRITY_SQL_PRIVATE_MARKER"
    parameter_marker = "INTEGRITY_PARAMETER_PRIVATE_MARKER"
    driver_marker = "INTEGRITY_DRIVER_PRIVATE_MARKER"
    expected = seed_portfolio._validated_expected_rows(portfolio_plan)
    monkeypatch.setattr(
        seed_portfolio,
        "_validated_expected_rows",
        lambda value: expected,
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_require_exact_schema_revision",
        lambda value: calls.append("schema"),
    )
    monkeypatch.setattr(
        seed_portfolio,
        "seed_menu_data_in_session",
        lambda value: calls.append("menu") or SeedResult(5, 15),
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_classify_portfolio_state",
        lambda value, rows: calls.append("classify") or "empty",
    )

    def fail_insert(value: object, rows: object) -> None:
        calls.append("insert")
        raise IntegrityError(
            statement_marker,
            {"value": parameter_marker},
            RuntimeError(driver_marker),
        )

    monkeypatch.setattr(seed_portfolio, "_insert_expected_rows", fail_insert)

    with pytest.raises(PortfolioSeedConflictError) as exc_info:
        seed_portfolio_data(
            _RecordingFactory(object(), calls),  # type: ignore[arg-type]
            portfolio_plan,
        )

    assert calls == ["begin", "schema", "classify", "menu", "insert", "rollback"]
    _assert_fully_sanitized_portfolio_error(
        exc_info.value,
        expected_type=PortfolioSeedConflictError,
        expected_message="Portfolio seed conflicts with existing database records.",
        forbidden_markers=(statement_marker, parameter_marker, driver_marker),
    )


def test_portfolio_sqlalchemy_failure_rolls_back_and_is_fully_redacted(
    portfolio_plan: PortfolioSeedPlan,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Remove generic database details after the transaction rolls back."""
    calls: list[str] = []
    private_marker = "GENERIC_DATABASE_PRIVATE_MARKER"
    expected = seed_portfolio._validated_expected_rows(portfolio_plan)
    monkeypatch.setattr(
        seed_portfolio,
        "_validated_expected_rows",
        lambda value: expected,
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_require_exact_schema_revision",
        lambda value: calls.append("schema"),
    )

    def fail_classification(value: object, rows: object) -> str:
        calls.append("classify")
        raise SQLAlchemyError(private_marker)

    monkeypatch.setattr(
        seed_portfolio,
        "_classify_portfolio_state",
        fail_classification,
    )

    with pytest.raises(PortfolioSeedDatabaseError) as exc_info:
        seed_portfolio_data(
            _RecordingFactory(object(), calls),  # type: ignore[arg-type]
            portfolio_plan,
        )

    assert calls == ["begin", "schema", "classify", "rollback"]
    _assert_fully_sanitized_portfolio_error(
        exc_info.value,
        expected_type=PortfolioSeedDatabaseError,
        expected_message="The portfolio database operation did not complete.",
        forbidden_markers=(private_marker,),
    )


def test_exact_portfolio_path_uses_read_only_menu_verification(
    portfolio_plan: PortfolioSeedPlan,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Avoid every menu and portfolio writer for an already exact seed."""
    calls: list[str] = []
    expected = seed_portfolio._validated_expected_rows(portfolio_plan)
    menu_writer = Mock(side_effect=AssertionError("Menu DML attempted"))
    portfolio_writer = Mock(side_effect=AssertionError("Portfolio DML attempted"))
    monkeypatch.setattr(
        seed_portfolio,
        "_validated_expected_rows",
        lambda value: expected,
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_require_exact_schema_revision",
        lambda value: calls.append("schema"),
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_classify_portfolio_state",
        lambda value, rows: calls.append("classify") or "exact",
    )
    monkeypatch.setattr(seed_portfolio, "seed_menu_data_in_session", menu_writer)
    monkeypatch.setattr(
        seed_portfolio,
        "require_exact_menu_data",
        lambda value: calls.append("menu-exact") or SeedResult(5, 15),
    )
    monkeypatch.setattr(seed_portfolio, "_insert_expected_rows", portfolio_writer)
    monkeypatch.setattr(
        seed_portfolio,
        "_require_exact_rows",
        lambda value, rows: calls.append("verify"),
    )

    result = seed_portfolio_data(
        _RecordingFactory(object(), calls),  # type: ignore[arg-type]
        portfolio_plan,
    )

    assert result.inserted is False
    assert calls == [
        "begin",
        "schema",
        "classify",
        "menu-exact",
        "verify",
        "commit",
    ]
    menu_writer.assert_not_called()
    portfolio_writer.assert_not_called()


def test_exact_portfolio_with_menu_drift_rolls_back_without_writes(
    portfolio_plan: PortfolioSeedPlan,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Translate exact-menu drift without invoking either database writer."""
    calls: list[str] = []
    expected = seed_portfolio._validated_expected_rows(portfolio_plan)
    menu_writer = Mock(side_effect=AssertionError("Menu DML attempted"))
    portfolio_writer = Mock(side_effect=AssertionError("Portfolio DML attempted"))
    monkeypatch.setattr(
        seed_portfolio,
        "_validated_expected_rows",
        lambda value: expected,
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_require_exact_schema_revision",
        lambda value: calls.append("schema"),
    )
    monkeypatch.setattr(
        seed_portfolio,
        "_classify_portfolio_state",
        lambda value, rows: calls.append("classify") or "exact",
    )
    monkeypatch.setattr(seed_portfolio, "seed_menu_data_in_session", menu_writer)

    def fail_exact_menu(value: object) -> SeedResult:
        calls.append("menu-exact")
        raise SeedConflictError("Private canonical record detail")

    monkeypatch.setattr(seed_portfolio, "require_exact_menu_data", fail_exact_menu)
    monkeypatch.setattr(seed_portfolio, "_insert_expected_rows", portfolio_writer)

    with pytest.raises(PortfolioSeedConflictError) as exc_info:
        seed_portfolio_data(
            _RecordingFactory(object(), calls),  # type: ignore[arg-type]
            portfolio_plan,
        )

    assert calls == ["begin", "schema", "classify", "menu-exact", "rollback"]
    assert "Private" not in str(exc_info.value)
    assert "Canonical menu data conflicts" in str(exc_info.value)
    menu_writer.assert_not_called()
    portfolio_writer.assert_not_called()
