"""Isolated PostgreSQL 17 acceptance tests for the exact migration runner."""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import time
import uuid
from collections.abc import Generator
from dataclasses import dataclass, field
from pathlib import Path

import psycopg
import pytest
from psycopg import sql
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import URL
from sqlalchemy.pool import NullPool

from app.database import migration_runner

BACKEND_ROOT = Path(__file__).resolve().parents[2]
OPT_IN_VARIABLE = "ROA_RUN_MIGRATION_RUNNER_INTEGRATION"
DOCKER_IMAGE = "postgres:17-alpine"
RESOURCE_LABEL = "com.restaurant-ordering-analytics.stage20d2a"
RESOURCE_PREFIX = "roa-d2a"
EXPECTED_HEAD = "0009_add_portfolio_demo_origin_and_payment_provider"
ROLE_OWNER = "roa_owner"
ROLE_MIGRATOR = "roa_migrator"
ROLE_RUNTIME = "roa_runtime"
RUNTIME_URL_MARKER = "runtime-url-must-not-be-used"
PUBLIC_ORIGIN = "https://app.restaurant.example"
PUBLIC_API_ORIGIN = "https://api.restaurant.example"
LOCAL_PRODUCTION_RUNNER_SCRIPT = """
import sys

from app.core import config as app_config


def allow_isolated_local_database(database_url, *, purpose, expected_username):
    return database_url


app_config.validate_neon_database_url = allow_isolated_local_database
from app.database import migration_runner

raise SystemExit(migration_runner.main())
""".strip()
LOCAL_PRODUCTION_ALEMBIC_SCRIPT = """
import sys

from app.core import config as app_config


def allow_isolated_local_database(database_url, *, purpose, expected_username):
    return database_url


app_config.validate_neon_database_url = allow_isolated_local_database
from alembic.config import CommandLine

CommandLine(prog="alembic").main(argv=sys.argv[1:])
""".strip()
APP_TABLES = {
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

pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class DisposablePostgres:
    """Describe one label-guarded PostgreSQL container without storing a DSN."""

    host: str
    port: int
    admin_password: str = field(repr=False)
    migrator_password: str = field(repr=False)
    runtime_password: str = field(repr=False)

    def connection_url(self, *, role: str, password: str, database: str) -> str:
        """Build a Psycopg SQLAlchemy URL without logging its credentials."""
        return URL.create(
            "postgresql+psycopg",
            username=role,
            password=password,
            host=self.host,
            port=self.port,
            database=database,
        ).render_as_string(hide_password=False)


def _docker(
    *arguments: str,
    environment: dict[str, str] | None = None,
    allow_failure: bool = False,
) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            ["docker", *arguments],
            cwd=BACKEND_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except (FileNotFoundError, subprocess.SubprocessError) as exc:
        raise RuntimeError("Disposable PostgreSQL Docker operation failed") from exc
    if completed.returncode != 0 and not allow_failure:
        raise RuntimeError("Disposable PostgreSQL Docker operation failed")
    return completed


def _require_opt_in() -> None:
    value = os.environ.get(OPT_IN_VARIABLE)
    if value is None:
        pytest.skip(f"Set {OPT_IN_VARIABLE}=1 to run isolated PostgreSQL proof")
    if value != "1":
        raise RuntimeError("Migration runner integration opt-in is invalid")


def _wait_for_postgres(harness: DisposablePostgres) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with psycopg.connect(
                host=harness.host,
                port=harness.port,
                dbname="postgres",
                user="postgres",
                password=harness.admin_password,
                connect_timeout=2,
            ) as connection:
                version = connection.execute(
                    "SELECT current_setting('server_version_num')"
                ).fetchone()
                if version is not None and str(version[0]).startswith("17"):
                    return
        except psycopg.Error:
            time.sleep(0.25)
    raise RuntimeError("Disposable PostgreSQL did not become ready")


def _inspect_exact_label(resource_type: str, resource_id: str, token: str) -> None:
    labels_template = (
        "{{json .Config.Labels}}"
        if resource_type == "container"
        else "{{json .Labels}}"
    )
    completed = _docker(
        resource_type,
        "inspect",
        "--format",
        labels_template,
        resource_id,
    )
    labels = json.loads(completed.stdout)
    if labels.get(RESOURCE_LABEL) != token:
        raise RuntimeError("Disposable Docker resource label check failed")


def _inspect_resource_id(
    resource_type: str,
    resource_reference: str,
) -> str | None:
    completed = _docker(
        resource_type,
        "inspect",
        "--format",
        "{{.Id}}",
        resource_reference,
        allow_failure=True,
    )
    if completed.returncode == 0:
        exact_id = completed.stdout.strip()
        if re.fullmatch(r"[0-9a-f]{64}", exact_id) is None:
            raise RuntimeError("Disposable Docker resource identity is invalid")
        return exact_id

    error = completed.stderr.strip()
    if resource_type == "container" and error.endswith(
        f"No such container: {resource_reference}"
    ):
        return None
    if resource_type == "network" and (
        error.endswith(f"network {resource_reference} not found")
        or error.endswith(f"No such network: {resource_reference}")
    ):
        return None
    raise RuntimeError("Disposable Docker resource inspection failed")


def _remove_exact_container(container_reference: str, token: str) -> None:
    exact_id = _inspect_resource_id("container", container_reference)
    if exact_id is None:
        return
    _inspect_exact_label("container", exact_id, token)
    _docker("container", "rm", "--force", exact_id)


def _remove_exact_network(network_reference: str, token: str) -> None:
    exact_id = _inspect_resource_id("network", network_reference)
    if exact_id is None:
        return
    _inspect_exact_label("network", exact_id, token)
    _docker("network", "rm", exact_id)


@pytest.fixture(scope="module")
def disposable_postgres() -> Generator[DisposablePostgres, None, None]:
    """Create one tmpfs-only PostgreSQL 17 container and remove exact resources."""
    _require_opt_in()
    token = uuid.uuid4().hex
    network_name = f"{RESOURCE_PREFIX}-net-{token}"
    container_name = f"{RESOURCE_PREFIX}-pg-{token}"
    network_id = ""
    container_id = ""
    admin_password = secrets.token_urlsafe(32)
    migrator_password = secrets.token_urlsafe(32)
    runtime_password = secrets.token_urlsafe(32)
    try:
        image_check = _docker("image", "inspect", DOCKER_IMAGE, allow_failure=True)
        if image_check.returncode != 0:
            raise RuntimeError("Required PostgreSQL 17 image is unavailable")

        network_id = _docker(
            "network",
            "create",
            "--label",
            f"{RESOURCE_LABEL}={token}",
            network_name,
        ).stdout.strip()
        child_environment = os.environ.copy()
        child_environment["POSTGRES_PASSWORD"] = admin_password
        container_id = _docker(
            "container",
            "run",
            "--detach",
            "--rm",
            "--name",
            container_name,
            "--label",
            f"{RESOURCE_LABEL}={token}",
            "--network",
            network_name,
            "--tmpfs",
            "/var/lib/postgresql/data:rw,nosuid,nodev",
            "--publish",
            "127.0.0.1::5432",
            "--env",
            "POSTGRES_PASSWORD",
            "--env",
            "POSTGRES_USER=postgres",
            "--env",
            "POSTGRES_DB=postgres",
            "--pull",
            "never",
            DOCKER_IMAGE,
            environment=child_environment,
        ).stdout.strip()

        port_output = _docker(
            "container",
            "port",
            container_id,
            "5432/tcp",
        ).stdout.strip()
        port_match = re.fullmatch(r"127\.0\.0\.1:(\d+)", port_output)
        if port_match is None:
            raise RuntimeError("Disposable PostgreSQL host binding is invalid")
        host_port = int(port_match.group(1))
        if host_port in {5432, 5433}:
            raise RuntimeError("Disposable PostgreSQL selected a protected host port")

        mounts_output = _docker(
            "container",
            "inspect",
            "--format",
            "{{json .Mounts}}",
            container_id,
        ).stdout
        mounts = json.loads(mounts_output)
        if any(mount.get("Type") == "volume" for mount in mounts):
            raise RuntimeError("Disposable PostgreSQL must not use Docker volumes")

        harness = DisposablePostgres(
            host="127.0.0.1",
            port=host_port,
            admin_password=admin_password,
            migrator_password=migrator_password,
            runtime_password=runtime_password,
        )
        _wait_for_postgres(harness)
        _create_production_roles(harness)
        yield harness
    finally:
        cleanup_errors: list[RuntimeError] = []
        try:
            _remove_exact_container(container_id or container_name, token)
        except RuntimeError as exc:
            cleanup_errors.append(exc)
        try:
            _remove_exact_network(network_id or network_name, token)
        except RuntimeError as exc:
            cleanup_errors.append(exc)
        if cleanup_errors:
            raise RuntimeError("Disposable PostgreSQL cleanup failed") from (
                cleanup_errors[0]
            )


def _admin_connection(
    harness: DisposablePostgres,
    *,
    database: str = "postgres",
    autocommit: bool = True,
) -> psycopg.Connection[tuple[object, ...]]:
    return psycopg.connect(
        host=harness.host,
        port=harness.port,
        dbname=database,
        user="postgres",
        password=harness.admin_password,
        autocommit=autocommit,
    )


def _create_production_roles(harness: DisposablePostgres) -> None:
    with _admin_connection(harness) as connection:
        for role_name in (
            ROLE_OWNER,
            ROLE_MIGRATOR,
            ROLE_RUNTIME,
        ):
            connection.execute(
                sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role_name))
            )
        connection.execute(
            sql.SQL(
                "CREATE ROLE {} NOLOGIN NOSUPERUSER NOCREATEDB "
                "NOCREATEROLE NOREPLICATION NOBYPASSRLS"
            ).format(sql.Identifier(ROLE_OWNER))
        )
        connection.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOINHERIT NOSUPERUSER "
                "NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
            ).format(
                sql.Identifier(ROLE_MIGRATOR),
                sql.Literal(harness.migrator_password),
            )
        )
        connection.execute(
            sql.SQL(
                "CREATE ROLE {} LOGIN PASSWORD {} NOINHERIT NOSUPERUSER "
                "NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
            ).format(
                sql.Identifier(ROLE_RUNTIME),
                sql.Literal(harness.runtime_password),
            )
        )
        connection.execute(
            sql.SQL("GRANT {} TO {} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE").format(
                sql.Identifier(ROLE_OWNER),
                sql.Identifier(ROLE_MIGRATOR),
            )
        )


@pytest.fixture
def fresh_database(
    disposable_postgres: DisposablePostgres,
) -> Generator[tuple[DisposablePostgres, str], None, None]:
    """Create and remove one exact uniquely named database for a test."""
    database_name = f"roa_d2a_{uuid.uuid4().hex}"
    if re.fullmatch(r"roa_d2a_[0-9a-f]{32}", database_name) is None:
        raise RuntimeError("Disposable database name validation failed")
    with _admin_connection(disposable_postgres) as connection:
        connection.execute(
            sql.SQL("CREATE DATABASE {} OWNER {}").format(
                sql.Identifier(database_name),
                sql.Identifier(ROLE_OWNER),
            )
        )
    try:
        yield disposable_postgres, database_name
    finally:
        with _admin_connection(disposable_postgres) as connection:
            connection.execute(
                """
                SELECT pg_terminate_backend(pid)
                FROM pg_stat_activity
                WHERE datname = %s
                  AND pid <> pg_backend_pid()
                """,
                (database_name,),
            )
            connection.execute(
                sql.SQL("DROP DATABASE {}").format(sql.Identifier(database_name))
            )


def _runner_environment(
    harness: DisposablePostgres,
    database_name: str,
    *,
    migration_role: str = ROLE_MIGRATOR,
    migration_password: str | None = None,
    expected_login_role: str = ROLE_MIGRATOR,
    owner_role: str = ROLE_OWNER,
) -> dict[str, str]:
    allowed_names = {
        "COMSPEC",
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "WINDIR",
    }
    environment = {
        name: value
        for name, value in os.environ.items()
        if name.upper() in allowed_names
    }
    selected_password = (
        harness.migrator_password if migration_password is None else migration_password
    )
    environment.update(
        {
            "APP_ENVIRONMENT": "production",
            "MIGRATION_DATABASE_URL": harness.connection_url(
                role=migration_role,
                password=selected_password,
                database=database_name,
            ),
            "DATABASE_URL": (
                "postgresql+psycopg://runtime:"
                f"{RUNTIME_URL_MARKER}@127.0.0.1:1/unreachable"
            ),
            "EXPECTED_ALEMBIC_HEAD": EXPECTED_HEAD,
            "MIGRATION_EXPECTED_LOGIN_ROLE": expected_login_role,
            "MIGRATION_OWNER_ROLE": owner_role,
            "PYTHONPATH": str(BACKEND_ROOT),
        }
    )
    return environment


def _run_runner(environment: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Run production semantics with provider URL validation test-isolated."""
    try:
        return subprocess.run(
            [sys.executable, "-c", LOCAL_PRODUCTION_RUNNER_SCRIPT],
            cwd=BACKEND_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except subprocess.SubprocessError as exc:
        raise RuntimeError("Migration runner subprocess failed") from exc


def _run_unpatched_runner(
    environment: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    """Run the real CLI to prove local production URLs fail before connection."""
    try:
        return subprocess.run(
            [sys.executable, "-m", "app.database.migration_runner"],
            cwd=BACKEND_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except subprocess.SubprocessError as exc:
        raise RuntimeError("Migration runner subprocess failed") from exc


def _run_alembic(
    environment: dict[str, str],
    *arguments: str,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [sys.executable, "-c", LOCAL_PRODUCTION_ALEMBIC_SCRIPT, *arguments],
            cwd=BACKEND_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except subprocess.SubprocessError as exc:
        raise RuntimeError("Alembic subprocess failed") from exc


def _assert_safe_process_output(
    completed: subprocess.CompletedProcess[str],
    harness: DisposablePostgres,
) -> None:
    combined_output = completed.stdout + completed.stderr
    secret_values = (
        harness.admin_password,
        harness.migrator_password,
        harness.runtime_password,
        RUNTIME_URL_MARKER,
    )
    if any(secret_value in combined_output for secret_value in secret_values):
        pytest.fail("Process output exposed a protected test marker", pytrace=False)
    if "Traceback (most recent call last)" in combined_output:
        pytest.fail("Process output exposed a traceback", pytrace=False)


def _assert_runner_success(
    completed: subprocess.CompletedProcess[str],
    harness: DisposablePostgres,
) -> None:
    _assert_safe_process_output(completed, harness)
    if completed.returncode != 0:
        pytest.fail("Migration runner unexpectedly failed", pytrace=False)
    if completed.stdout.strip() != "Migration revision verified.":
        pytest.fail("Migration runner success output was not exact", pytrace=False)


def _assert_runner_failure(
    completed: subprocess.CompletedProcess[str],
    harness: DisposablePostgres,
    expected_message: str,
) -> None:
    _assert_safe_process_output(completed, harness)
    if completed.returncode == 0:
        pytest.fail("Migration runner unexpectedly succeeded", pytrace=False)
    if completed.stdout.strip():
        pytest.fail("Migration runner failure wrote to stdout", pytrace=False)
    if expected_message not in completed.stderr.splitlines():
        pytest.fail("Migration runner failure output was not generic", pytrace=False)


def _production_alembic_environment(
    harness: DisposablePostgres,
    database_name: str,
) -> dict[str, str]:
    environment = _runner_environment(harness, database_name)
    environment.update(
        {
            "APP_DEBUG": "false",
            "PORTFOLIO_DEMO_MODE": "false",
            "PAYMENT_PROVIDER": "stripe_test",
            "DATABASE_URL": harness.connection_url(
                role="postgres",
                password=harness.admin_password,
                database=database_name,
            ),
            "STRIPE_SECRET_KEY": "sk_test_synthetic_d2a",
            "STRIPE_WEBHOOK_SECRET": "whsec_synthetic_d2a",
            "STRIPE_SUCCESS_URL": (
                f"{PUBLIC_ORIGIN}/orders/{{public_order_number}}/payment-return"
            ),
            "STRIPE_CANCEL_URL": (
                f"{PUBLIC_ORIGIN}/orders/{{public_order_number}}/checkout-cancelled"
            ),
            "AUTH_JWT_SECRET": "d2a-" + ("a" * 32),
            "PUBLIC_APP_ORIGIN": PUBLIC_ORIGIN,
            "PUBLIC_API_ORIGIN": PUBLIC_API_ORIGIN,
            "TRUSTED_HOSTS": '["api.restaurant.example"]',
            "TRUSTED_PROXY_MODE": "direct",
            "STRIPE_EXPECTED_LIVEMODE": "false",
            "RELEASE_SHA": "a" * 40,
            "LOG_LEVEL": "info",
        }
    )
    return environment


def _database_engine(
    harness: DisposablePostgres,
    database_name: str,
) -> Generator[object, None, None]:
    engine = create_engine(
        harness.connection_url(
            role="postgres",
            password=harness.admin_password,
            database=database_name,
        ),
        poolclass=NullPool,
        hide_parameters=True,
    )
    try:
        yield engine
    finally:
        engine.dispose()


def _public_tables(harness: DisposablePostgres, database_name: str) -> set[str]:
    for engine in _database_engine(harness, database_name):
        return set(inspect(engine).get_table_names(schema="public"))
    raise AssertionError("Database engine fixture did not yield")


def test_exact_upgrade_is_idempotent_role_owned_and_seed_free(
    fresh_database: tuple[DisposablePostgres, str],
) -> None:
    """Prove exact upgrade, idempotency, role switching, and no seed/runtime URL."""
    harness, database_name = fresh_database
    environment = _runner_environment(harness, database_name)

    first = _run_runner(environment)
    second = _run_runner(environment)

    for completed in (first, second):
        _assert_runner_success(completed, harness)

    assert _public_tables(harness, database_name) == APP_TABLES | {"alembic_version"}
    for engine in _database_engine(harness, database_name):
        with engine.connect() as connection:
            revisions = tuple(
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalars()
            )
            assert revisions == (EXPECTED_HEAD,)
            owners = set(connection.execute(text("""
                        SELECT tableowner
                        FROM pg_tables
                        WHERE schemaname = 'public'
                        """)).scalars())
            assert owners == {ROLE_OWNER}
            for table_name in sorted(APP_TABLES):
                count = connection.execute(
                    text(f'SELECT count(*) FROM "{table_name}"')
                ).scalar_one()
                assert count == 0

    with _admin_connection(harness) as connection:
        owner_attributes = connection.execute(
            """
            SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                   rolreplication, rolbypassrls
            FROM pg_roles
            WHERE rolname = %s
            """,
            (ROLE_OWNER,),
        ).fetchone()
        migrator_attributes = connection.execute(
            """
            SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
                   rolreplication, rolbypassrls
            FROM pg_roles
            WHERE rolname = %s
            """,
            (ROLE_MIGRATOR,),
        ).fetchone()
        membership = connection.execute(
            """
            SELECT membership.admin_option,
                   membership.inherit_option,
                   membership.set_option
            FROM pg_auth_members AS membership
            JOIN pg_roles AS granted_role
              ON granted_role.oid = membership.roleid
            JOIN pg_roles AS member_role
              ON member_role.oid = membership.member
            WHERE granted_role.rolname = %s
              AND member_role.rolname = %s
            """,
            (ROLE_OWNER, ROLE_MIGRATOR),
        ).fetchone()
    assert owner_attributes == (False, False, False, False, False, False)
    assert migrator_attributes == (True, False, False, False, False, False, False)
    assert membership == (False, False, True)


def test_real_production_cli_rejects_local_database_url(
    fresh_database: tuple[DisposablePostgres, str],
) -> None:
    """Keep the real production CLI fail-closed for non-Neon database URLs."""
    harness, database_name = fresh_database

    completed = _run_unpatched_runner(_runner_environment(harness, database_name))

    _assert_runner_failure(completed, harness, "Migration configuration invalid.")
    assert _public_tables(harness, database_name) == set()


def test_held_session_lock_fails_immediately_without_mutation(
    fresh_database: tuple[DisposablePostgres, str],
) -> None:
    """Prove fail-fast session locking before any Alembic schema mutation."""
    harness, database_name = fresh_database
    migrator_url = harness.connection_url(
        role=ROLE_MIGRATOR,
        password=harness.migrator_password,
        database=database_name,
    )
    engine = create_engine(migrator_url, poolclass=NullPool, hide_parameters=True)
    try:
        with engine.connect() as lock_connection:
            assert lock_connection.execute(
                text("SELECT pg_try_advisory_lock(:lock_key)"),
                {"lock_key": migration_runner.MIGRATION_LOCK_KEY},
            ).scalar_one()
            started = time.monotonic()
            completed = _run_runner(_runner_environment(harness, database_name))
            elapsed = time.monotonic() - started
            _assert_runner_failure(
                completed,
                harness,
                "Migration lock unavailable.",
            )
            assert elapsed < 10
            lock_connection.execute(
                text("SELECT pg_advisory_unlock(:lock_key)"),
                {"lock_key": migration_runner.MIGRATION_LOCK_KEY},
            )
    finally:
        engine.dispose()
    assert _public_tables(harness, database_name) == set()


def test_wrong_migration_login_is_rejected_before_schema_mutation(
    fresh_database: tuple[DisposablePostgres, str],
) -> None:
    """Reject a runtime-style login even when its migration URL is reachable."""
    harness, database_name = fresh_database
    completed = _run_runner(
        _runner_environment(
            harness,
            database_name,
            migration_role=ROLE_RUNTIME,
            migration_password=harness.runtime_password,
        )
    )

    _assert_runner_failure(completed, harness, "Migration role invalid.")
    assert _public_tables(harness, database_name) == set()


def test_runner_overrides_connection_search_path_and_uses_only_public(
    fresh_database: tuple[DisposablePostgres, str],
) -> None:
    """Keep a credential-supplied shadow schema outside the migration target."""
    harness, database_name = fresh_database
    with _admin_connection(harness, database=database_name) as connection:
        connection.execute(
            sql.SQL("CREATE SCHEMA {} AUTHORIZATION {}").format(
                sql.Identifier("shadow"),
                sql.Identifier(ROLE_OWNER),
            )
        )

    environment = _runner_environment(harness, database_name)
    environment["MIGRATION_DATABASE_URL"] = URL.create(
        "postgresql+psycopg",
        username=ROLE_MIGRATOR,
        password=harness.migrator_password,
        host=harness.host,
        port=harness.port,
        database=database_name,
        query={"options": "-csearch_path=shadow,public"},
    ).render_as_string(hide_password=False)

    completed = _run_runner(environment)

    _assert_runner_success(completed, harness)
    assert _public_tables(harness, database_name) == APP_TABLES | {"alembic_version"}
    for engine in _database_engine(harness, database_name):
        assert set(inspect(engine).get_table_names(schema="shadow")) == set()


def test_final_verification_failure_rolls_back_migration_ddl(
    fresh_database: tuple[DisposablePostgres, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Roll back the exact upgrade when its same-transaction postcheck fails."""
    harness, database_name = fresh_database
    monkeypatch.setattr(
        migration_runner,
        "validate_neon_database_url",
        lambda database_url, **_: database_url,
    )
    settings = migration_runner.MigrationSettings(
        _env_file=None,
        app_environment="production",
        migration_database_url=harness.connection_url(
            role=ROLE_MIGRATOR,
            password=harness.migrator_password,
            database=database_name,
        ),
        expected_alembic_head=EXPECTED_HEAD,
        migration_expected_login_role=ROLE_MIGRATOR,
        migration_owner_role=ROLE_OWNER,
    )
    monkeypatch.setattr(
        migration_runner,
        "_read_current_revisions",
        lambda connection: ("0007_unify_user_auth_roles",),
    )

    with pytest.raises(migration_runner.MigrationVerificationError):
        migration_runner.run_migration(settings)

    assert _public_tables(harness, database_name) == set()


def test_direct_production_alembic_mutations_are_rejected(
    fresh_database: tuple[DisposablePostgres, str],
) -> None:
    """Reject online and offline production Alembic paths outside the runner."""
    harness, database_name = fresh_database
    environment = _production_alembic_environment(harness, database_name)

    offline = _run_alembic(
        environment,
        "upgrade",
        "--sql",
        EXPECTED_HEAD,
    )
    online = _run_alembic(environment, "upgrade", EXPECTED_HEAD)

    for completed in (offline, online):
        _assert_safe_process_output(completed, harness)
        if completed.returncode == 0:
            pytest.fail(
                "Direct production Alembic mutation was not rejected",
                pytrace=False,
            )
    assert _public_tables(harness, database_name) == set()


def test_production_alembic_current_check_remains_read_only(
    fresh_database: tuple[DisposablePostgres, str],
) -> None:
    """Retain the backend's production read-only current-head startup guard."""
    harness, database_name = fresh_database
    runner_result = _run_runner(_runner_environment(harness, database_name))
    _assert_runner_success(runner_result, harness)

    completed = _run_alembic(
        _production_alembic_environment(harness, database_name),
        "current",
        "--check-heads",
    )

    _assert_safe_process_output(completed, harness)
    if completed.returncode != 0:
        pytest.fail(
            "Production Alembic current check unexpectedly failed",
            pytrace=False,
        )


def test_failed_migration_releases_session_lock_and_connection(
    fresh_database: tuple[DisposablePostgres, str],
) -> None:
    """Prove cleanup after a controlled DDL conflict under the canonical owner."""
    harness, database_name = fresh_database
    with _admin_connection(harness, database=database_name) as connection:
        connection.execute(
            sql.SQL("CREATE TABLE {}.{} (sentinel integer)").format(
                sql.Identifier("public"),
                sql.Identifier("categories"),
            )
        )
    completed = _run_runner(_runner_environment(harness, database_name))

    _assert_runner_failure(completed, harness, "Migration failed.")
    assert _public_tables(harness, database_name) == {"categories"}

    with _admin_connection(harness, database=database_name) as connection:
        reacquired = connection.execute(
            "SELECT pg_try_advisory_lock(%s)",
            (migration_runner.MIGRATION_LOCK_KEY,),
        ).fetchone()
        active_migrators = connection.execute(
            """
            SELECT count(*)
            FROM pg_stat_activity
            WHERE usename = %s
              AND pid <> pg_backend_pid()
            """,
            (ROLE_MIGRATOR,),
        ).fetchone()
        connection.execute(
            "SELECT pg_advisory_unlock(%s)",
            (migration_runner.MIGRATION_LOCK_KEY,),
        )
    assert reacquired == (True,)
    assert active_migrators == (0,)
