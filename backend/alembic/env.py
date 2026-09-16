"""Configure Alembic migrations from application settings."""

# Ruff and isort classify the repository's local alembic path differently.
# ruff: noqa: I001

from logging.config import fileConfig
from typing import cast

from sqlalchemy.engine import Connection

from alembic import context
from alembic.util.exc import CommandError
from app.core.config import Settings
from app.database.model_registry import metadata
from app.database.session import create_database_engine

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = metadata


def _get_database_url(settings: Settings) -> str:
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is required to run database migrations")
    return str(settings.database_url)


def run_migrations_offline() -> None:
    """Run migrations without creating a database connection."""
    settings = Settings()
    if settings.app_environment == "production":
        raise CommandError("Production offline migrations are disabled")
    context.configure(
        url=_get_database_url(settings),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def _run_migrations(
    connection: Connection,
    *,
    require_read_only: bool,
    pin_public_version_table: bool,
) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        version_table_schema="public" if pin_public_version_table else None,
    )
    if require_read_only and not context.get_context().opts.get(
        "dont_mutate",
        False,
    ):
        raise CommandError("Production Alembic mutations require migration runner")

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations through a caller-owned or locally created connection."""
    external_connection = config.attributes.get("connection")
    if external_connection is not None:
        connection = cast(Connection, external_connection)
        if not connection.in_transaction():
            raise CommandError(
                "Migration runner connection requires an active transaction"
            )
        _run_migrations(
            connection,
            require_read_only=False,
            pin_public_version_table=True,
        )
        return

    settings = Settings()
    engine = create_database_engine(_get_database_url(settings))
    try:
        with engine.connect() as connection:
            _run_migrations(
                connection,
                require_read_only=settings.app_environment == "production",
                pin_public_version_table=settings.app_environment == "production",
            )
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
