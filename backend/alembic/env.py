"""Configure Alembic migrations from application settings."""

from logging.config import fileConfig

from alembic import context
from app.core.config import Settings
from app.database.base import Base
from app.database.session import create_database_engine

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _get_database_url() -> str:
    settings = Settings()
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is required to run database migrations")
    return str(settings.database_url)


def run_migrations_offline() -> None:
    """Run migrations without creating a database connection."""
    context.configure(
        url=_get_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations through a synchronous SQLAlchemy connection."""
    engine = create_database_engine(_get_database_url())
    try:
        with engine.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                compare_type=True,
            )

            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
