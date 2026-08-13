"""Safe PostgreSQL fixtures for data-changing integration tests."""

from __future__ import annotations

import os
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

import pytest
from pydantic import Field, PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import URL, Engine, make_url
from sqlalchemy.orm import Session

from alembic import command
from app.database.session import create_database_engine

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
ENV_FILE = REPOSITORY_ROOT / ".env"
DEVELOPMENT_DATABASE_NAME = "restaurant_ordering_analytics_dev"
TEST_DATABASE_NAME = "restaurant_ordering_analytics_test"
ADMIN_DATABASE_NAME = "postgres"
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
REQUIRED_DRIVER = "postgresql+psycopg"
REQUIRED_PORT = 5433
HEAD_REVISION = "0008_add_order_ownership"
BASELINE_REVISION = "0001_database_baseline"


class TestDatabaseSettings(BaseSettings):
    """Load integration database URLs without exposing them in representations."""

    database_url: PostgresDsn = Field(repr=False)
    test_database_url: PostgresDsn | None = Field(default=None, repr=False)

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
    )


def _validate_database_url(
    database_url: URL,
    expected_database: str,
    *,
    expected_username: str | None = None,
) -> None:
    if database_url.drivername != REQUIRED_DRIVER:
        raise RuntimeError("Integration tests require the PostgreSQL Psycopg driver")
    if database_url.host not in ALLOWED_HOSTS:
        raise RuntimeError("Integration tests require an approved local database host")
    if database_url.port != REQUIRED_PORT:
        raise RuntimeError("Integration tests require local host port 5433")
    if database_url.database != expected_database:
        raise RuntimeError(
            "Integration database name failed the exact-name safety check"
        )
    if not database_url.username:
        raise RuntimeError("Integration database username is required")
    if not database_url.password:
        raise RuntimeError("Integration database password is required")
    if expected_username is not None and database_url.username != expected_username:
        raise RuntimeError("Test and development database usernames must match")


def _resolve_database_urls() -> tuple[URL, URL, URL]:
    settings = TestDatabaseSettings()
    development_url = make_url(str(settings.database_url))
    _validate_database_url(development_url, DEVELOPMENT_DATABASE_NAME)

    if settings.test_database_url is None:
        test_url = development_url.set(database=TEST_DATABASE_NAME)
    else:
        test_url = make_url(str(settings.test_database_url))

    _validate_database_url(
        test_url,
        TEST_DATABASE_NAME,
        expected_username=development_url.username,
    )
    if test_url.host != development_url.host or test_url.port != development_url.port:
        raise RuntimeError("Test and development database endpoints must match")

    admin_url = development_url.set(database=ADMIN_DATABASE_NAME)
    _validate_database_url(admin_url, ADMIN_DATABASE_NAME)
    return development_url, test_url, admin_url


def _validate_admin_engine(engine: Engine) -> None:
    """Reject an administrative engine that does not target approved PostgreSQL."""
    _validate_database_url(engine.url, ADMIN_DATABASE_NAME)


def _validate_test_database_name(database_name: str) -> None:
    """Allow administrative operations only for the exact test database."""
    if database_name != TEST_DATABASE_NAME:
        raise RuntimeError("Test database name failed the exact-name safety check")


@contextmanager
def _temporary_database_url(database_url: URL) -> Generator[None, None, None]:
    previous_database_url = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = database_url.render_as_string(hide_password=False)
    try:
        yield
    finally:
        if previous_database_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous_database_url


def _database_oid(engine: Engine, database_name: str) -> int | None:
    with engine.connect() as connection:
        value = connection.execute(
            text("SELECT oid FROM pg_database WHERE datname = :database_name"),
            {"database_name": database_name},
        ).scalar_one_or_none()
    return int(value) if value is not None else None


def _terminate_test_database_connections(
    engine: Engine,
    database_name: str = TEST_DATABASE_NAME,
) -> None:
    _validate_admin_engine(engine)
    _validate_test_database_name(database_name)
    with engine.connect() as connection:
        connection.execute(
            text("""
                SELECT pg_terminate_backend(pid)
                FROM pg_stat_activity
                WHERE datname = :database_name
                  AND pid <> pg_backend_pid()
                """),
            {"database_name": database_name},
        )


def _quoted_test_database_name(database_name: str = TEST_DATABASE_NAME) -> str:
    _validate_test_database_name(database_name)
    quote = chr(34)
    return f"{quote}{database_name}{quote}"


def _drop_test_database(
    engine: Engine,
    database_name: str = TEST_DATABASE_NAME,
) -> None:
    _validate_admin_engine(engine)
    _validate_test_database_name(database_name)
    _terminate_test_database_connections(engine, database_name)
    _validate_admin_engine(engine)
    _validate_test_database_name(database_name)
    with engine.connect() as connection:
        connection.exec_driver_sql(
            f"DROP DATABASE IF EXISTS {_quoted_test_database_name(database_name)}"
        )


def _recreate_test_database(
    engine: Engine,
    database_name: str = TEST_DATABASE_NAME,
) -> None:
    _validate_admin_engine(engine)
    _validate_test_database_name(database_name)
    _drop_test_database(engine, database_name)
    _validate_admin_engine(engine)
    _validate_test_database_name(database_name)
    with engine.connect() as connection:
        connection.exec_driver_sql(
            f"CREATE DATABASE {_quoted_test_database_name(database_name)}"
        )


def _alembic_config():
    from alembic.config import Config

    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    return config


def _current_revision(database_url: URL) -> str:
    engine = create_database_engine(database_url.render_as_string(hide_password=False))
    try:
        with engine.connect() as connection:
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
        return str(revision)
    finally:
        engine.dispose()


def _public_tables(database_url: URL) -> set[str]:
    engine = create_database_engine(database_url.render_as_string(hide_password=False))
    try:
        return set(inspect(engine).get_table_names(schema="public"))
    finally:
        engine.dispose()


def _verify_migration_cycle(database_url: URL) -> None:
    config = _alembic_config()
    with _temporary_database_url(database_url):
        command.upgrade(config, "head")
    if _current_revision(database_url) != HEAD_REVISION:
        raise RuntimeError(
            "First migration upgrade did not reach the expected revision"
        )
    if _public_tables(database_url) != {
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
    }:
        raise RuntimeError("First migration upgrade created unexpected public tables")

    with _temporary_database_url(database_url):
        command.downgrade(config, BASELINE_REVISION)
    if _current_revision(database_url) != BASELINE_REVISION:
        raise RuntimeError("Migration downgrade did not reach the baseline revision")
    if _public_tables(database_url) != {"alembic_version"}:
        raise RuntimeError("Stage 4 tables remained after migration downgrade")

    with _temporary_database_url(database_url):
        command.upgrade(config, "head")
    if _current_revision(database_url) != HEAD_REVISION:
        raise RuntimeError(
            "Second migration upgrade did not reach the expected revision"
        )


@pytest.fixture(scope="session")
def test_database_url() -> Generator[URL, None, None]:
    """Create, migrate, and remove the exact isolated integration database."""
    development_url, isolated_test_url, admin_url = _resolve_database_urls()
    admin_engine: Engine | None = None
    development_oid: int | None = None
    cleanup_test_database = False
    try:
        admin_engine = create_engine(
            admin_url,
            isolation_level="AUTOCOMMIT",
            pool_pre_ping=True,
        )
        _validate_admin_engine(admin_engine)
        development_oid = _database_oid(admin_engine, DEVELOPMENT_DATABASE_NAME)
        if development_oid is None:
            raise RuntimeError("The approved development database does not exist")

        cleanup_test_database = True
        _recreate_test_database(admin_engine)
        _verify_migration_cycle(isolated_test_url)
        yield isolated_test_url
    finally:
        if admin_engine is not None:
            try:
                try:
                    if cleanup_test_database:
                        _drop_test_database(admin_engine)
                finally:
                    if (
                        development_oid is not None
                        and _database_oid(admin_engine, DEVELOPMENT_DATABASE_NAME)
                        != development_oid
                    ):
                        raise RuntimeError(
                            "The development database identity changed during tests"
                        )
            finally:
                admin_engine.dispose()


@pytest.fixture(scope="session")
def test_database_engine(test_database_url: URL) -> Generator[Engine, None, None]:
    """Provide one engine bound only to the isolated integration database."""
    engine: Engine | None = None
    try:
        engine = create_database_engine(
            test_database_url.render_as_string(hide_password=False)
        )
        yield engine
    finally:
        if engine is not None:
            engine.dispose()


@pytest.fixture
def db_session(test_database_engine: Engine) -> Generator[Session, None, None]:
    """Provide an isolated savepoint-backed session for one model test."""
    connection = None
    outer_transaction = None
    session = None
    try:
        connection = test_database_engine.connect()
        outer_transaction = connection.begin()
        session = Session(
            bind=connection,
            join_transaction_mode="create_savepoint",
            expire_on_commit=False,
        )
        yield session
    finally:
        if session is not None:
            session.close()
        if outer_transaction is not None and outer_transaction.is_active:
            outer_transaction.rollback()
        if connection is not None:
            connection.close()
