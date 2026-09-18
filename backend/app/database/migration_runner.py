"""Run one exact Alembic upgrade through a migration-only database session."""

# Ruff and isort classify the repository's local alembic path differently.
# ruff: noqa: I001

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar

from pydantic import (
    Field,
    PostgresDsn,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict, SettingsError
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine, make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError
from app.core.config import (
    ENV_FILE,
    AppEnvironment,
    normalize_database_url,
    validate_alembic_head,
    validate_neon_database_url,
)

BACKEND_ROOT = Path(__file__).resolve().parents[2]
ALEMBIC_CONFIG_PATH = BACKEND_ROOT / "alembic.ini"
ALEMBIC_SCRIPT_PATH = BACKEND_ROOT / "alembic"
ROLE_IDENTIFIER_PATTERN = re.compile(r"[a-z_][a-z0-9_]{0,62}")
PRODUCTION_MIGRATION_LOGIN_ROLE = "roa_migrator"
PRODUCTION_MIGRATION_OWNER_ROLE = "roa_owner"
MIGRATION_SCHEMA = "public"
# A fixed session-level key serializes every migration release for this application.
MIGRATION_LOCK_KEY = int.from_bytes(b"ROA-MIGR", byteorder="big", signed=True)


class MigrationRunnerError(Exception):
    """Represent a migration failure with a stable secret-free public message."""

    public_message: ClassVar[str] = "Migration failed."

    def __init__(self) -> None:
        """Initialize the exception without accepting sensitive context."""
        super().__init__(self.public_message)


class MigrationConfigurationError(MigrationRunnerError):
    """Report an invalid runner or repository configuration."""

    public_message = "Migration configuration invalid."


class MigrationLockUnavailableError(MigrationRunnerError):
    """Report that another session owns the application migration lock."""

    public_message = "Migration lock unavailable."


class MigrationRoleError(MigrationRunnerError):
    """Report a production login or owner-role boundary failure."""

    public_message = "Migration role invalid."


class MigrationExecutionError(MigrationRunnerError):
    """Report a sanitized database or Alembic execution failure."""

    public_message = "Migration failed."


class MigrationVerificationError(MigrationRunnerError):
    """Report that the database did not reach the exact expected revision."""

    public_message = "Migration revision verification failed."


class MigrationSettings(BaseSettings):
    """Load migration-only settings without accepting the runtime database URL."""

    app_environment: AppEnvironment = "development"
    migration_database_url: PostgresDsn = Field(repr=False)
    expected_alembic_head: str
    migration_expected_login_role: str | None = None
    migration_owner_role: str | None = None

    @field_validator("migration_database_url", mode="before")
    @classmethod
    def normalize_migration_database_url(cls, value: object) -> object:
        """Normalize only the explicitly supplied migration database URL."""
        return normalize_database_url(value)

    @field_validator("migration_database_url")
    @classmethod
    def require_migration_credentials(cls, value: PostgresDsn) -> PostgresDsn:
        """Require an explicit login and password without exposing either value."""
        parsed_url = make_url(str(value))
        if not parsed_url.username or not parsed_url.password:
            raise ValueError("Migration database URL must include credentials")
        return value

    @field_validator("expected_alembic_head")
    @classmethod
    def validate_expected_head(cls, value: str) -> str:
        """Require one safe exact revision identifier."""
        validated = validate_alembic_head(value)
        if validated is None:
            raise ValueError("Expected Alembic head is required")
        return validated

    @field_validator(
        "migration_expected_login_role",
        "migration_owner_role",
    )
    @classmethod
    def validate_role_name(cls, value: str | None) -> str | None:
        """Accept only canonical unquoted PostgreSQL role identifiers."""
        if value is None:
            return None
        return validate_role_identifier(value)

    @model_validator(mode="after")
    def validate_production_roles(self) -> MigrationSettings:
        """Require both role-boundary identifiers in production."""
        if self.app_environment != "production":
            return self
        if (
            self.migration_expected_login_role is None
            or self.migration_owner_role is None
        ):
            raise ValueError("Production migration roles are required")
        if (
            self.migration_expected_login_role != PRODUCTION_MIGRATION_LOGIN_ROLE
            or self.migration_owner_role != PRODUCTION_MIGRATION_OWNER_ROLE
        ):
            raise ValueError("Production migration roles must match the role contract")
        validate_neon_database_url(
            self.migration_database_url,
            purpose="migration",
            expected_username=PRODUCTION_MIGRATION_LOGIN_ROLE,
        )
        return self

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
        hide_input_in_errors=True,
    )


@dataclass(frozen=True)
class MigrationOutcome:
    """Describe a successfully verified exact migration without connection data."""

    expected_revision: str
    current_revisions: tuple[str, ...]


def validate_role_identifier(value: str) -> str:
    """Validate one canonical lowercase unquoted PostgreSQL role identifier."""
    if ROLE_IDENTIFIER_PATTERN.fullmatch(value) is None:
        raise ValueError("Migration role must be a safe PostgreSQL identifier")
    return value


def run_migration(settings: MigrationSettings) -> MigrationOutcome:
    """Upgrade and verify one exact revision on one protected database session."""
    try:
        alembic_config = _build_alembic_config()
        _require_exact_repository_head(
            alembic_config,
            settings.expected_alembic_head,
        )
        engine = _create_migration_engine(settings.migration_database_url)
        try:
            return _run_with_engine(engine, alembic_config, settings)
        finally:
            engine.dispose()
    except MigrationRunnerError:
        raise
    except (CommandError, OSError, SQLAlchemyError) as exc:
        raise MigrationExecutionError from exc
    except Exception as exc:
        # This is the redacting boundary around third-party migration code.
        raise MigrationExecutionError from exc


def main() -> int:
    """Run the migration CLI with stable secret-free output and exit status."""
    try:
        settings = MigrationSettings()
        run_migration(settings)
    except (ValidationError, SettingsError):
        print(MigrationConfigurationError.public_message, file=sys.stderr)
        return 1
    except MigrationRunnerError as exc:
        print(exc.public_message, file=sys.stderr)
        return 1
    except Exception:
        # Never render an unexpected exception at the command-line boundary.
        print(MigrationExecutionError.public_message, file=sys.stderr)
        return 1

    print("Migration revision verified.")
    return 0


def _build_alembic_config() -> Config:
    config = Config(str(ALEMBIC_CONFIG_PATH))
    config.set_main_option("script_location", str(ALEMBIC_SCRIPT_PATH))
    return config


def _require_exact_repository_head(config: Config, expected_revision: str) -> None:
    try:
        repository_heads = tuple(ScriptDirectory.from_config(config).get_heads())
    except (CommandError, OSError) as exc:
        raise MigrationConfigurationError from exc
    if repository_heads != (expected_revision,):
        raise MigrationConfigurationError


def _create_migration_engine(database_url: PostgresDsn) -> Engine:
    return create_engine(
        str(database_url),
        pool_pre_ping=True,
        poolclass=NullPool,
        hide_parameters=True,
    )


def _run_with_engine(
    engine: Engine,
    alembic_config: Config,
    settings: MigrationSettings,
) -> MigrationOutcome:
    connection: Connection | None = None
    lock_acquired = False
    try:
        connection = engine.connect()
        if settings.app_environment == "production":
            _require_expected_login_role(
                connection,
                settings.migration_expected_login_role,
            )

        _acquire_migration_lock(connection)
        lock_acquired = True

        # End preflight's implicit transaction. The session advisory lock remains
        # active while one caller-owned transaction contains DDL and verification.
        connection.commit()
        with connection.begin():
            if settings.app_environment == "production":
                owner_role = settings.migration_owner_role
                if owner_role is None:
                    raise MigrationRoleError
                _set_owner_role(connection, owner_role)
                _require_current_role(connection, owner_role)

            _pin_migration_search_path(connection)
            _upgrade_exact_revision(
                connection,
                alembic_config,
                settings.expected_alembic_head,
            )
            current_revisions = _read_current_revisions(connection)
            if current_revisions != (settings.expected_alembic_head,):
                raise MigrationVerificationError

        return MigrationOutcome(
            expected_revision=settings.expected_alembic_head,
            current_revisions=current_revisions,
        )
    finally:
        if connection is not None:
            try:
                _cleanup_session(
                    connection,
                    lock_acquired=lock_acquired,
                )
            finally:
                connection.close()


def _require_expected_login_role(
    connection: Connection,
    expected_login_role: str | None,
) -> None:
    if expected_login_role is None:
        raise MigrationRoleError
    try:
        session_user = connection.execute(text("SELECT session_user")).scalar_one()
    except SQLAlchemyError as exc:
        raise MigrationRoleError from exc
    if session_user != expected_login_role:
        raise MigrationRoleError


def _acquire_migration_lock(connection: Connection) -> None:
    try:
        acquired = connection.execute(
            text("SELECT pg_try_advisory_lock(:lock_key)"),
            {"lock_key": MIGRATION_LOCK_KEY},
        ).scalar_one()
    except SQLAlchemyError as exc:
        raise MigrationExecutionError from exc
    if not acquired:
        raise MigrationLockUnavailableError


def _set_owner_role(connection: Connection, owner_role: str) -> None:
    quoted_role = connection.dialect.identifier_preparer.quote_identifier(owner_role)
    try:
        connection.exec_driver_sql(f"SET LOCAL ROLE {quoted_role}")
    except SQLAlchemyError as exc:
        raise MigrationRoleError from exc


def _require_current_role(connection: Connection, owner_role: str) -> None:
    try:
        current_user = connection.execute(text("SELECT current_user")).scalar_one()
    except SQLAlchemyError as exc:
        raise MigrationRoleError from exc
    if current_user != owner_role:
        raise MigrationRoleError


def _pin_migration_search_path(connection: Connection) -> None:
    try:
        connection.exec_driver_sql("SET LOCAL search_path TO public")
        schemas = connection.execute(text("SELECT current_schemas(false)")).scalar_one()
    except SQLAlchemyError as exc:
        raise MigrationExecutionError from exc
    if not isinstance(schemas, (list, tuple)) or tuple(schemas) != (MIGRATION_SCHEMA,):
        raise MigrationExecutionError


def _upgrade_exact_revision(
    connection: Connection,
    config: Config,
    expected_revision: str,
) -> None:
    config.attributes["connection"] = connection
    try:
        command.upgrade(config, expected_revision)
    except Exception as exc:
        raise MigrationExecutionError from exc
    finally:
        config.attributes.pop("connection", None)


def _read_current_revisions(connection: Connection) -> tuple[str, ...]:
    try:
        rows = connection.execute(
            text(
                "SELECT version_num "
                "FROM public.alembic_version "
                "ORDER BY version_num"
            )
        ).scalars()
        return tuple(str(revision) for revision in rows)
    except SQLAlchemyError as exc:
        raise MigrationVerificationError from exc


def _cleanup_session(
    connection: Connection,
    *,
    lock_acquired: bool,
) -> None:
    try:
        if connection.in_transaction():
            connection.rollback()
        if lock_acquired:
            unlocked = connection.execute(
                text("SELECT pg_advisory_unlock(:lock_key)"),
                {"lock_key": MIGRATION_LOCK_KEY},
            ).scalar_one()
            connection.commit()
            if not unlocked:
                raise MigrationExecutionError
    except MigrationRunnerError:
        raise
    except SQLAlchemyError as exc:
        raise MigrationExecutionError from exc


if __name__ == "__main__":
    raise SystemExit(main())
