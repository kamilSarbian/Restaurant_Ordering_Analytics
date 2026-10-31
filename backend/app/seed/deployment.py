"""Operator-gated persistence of the canonical portfolio dataset in production."""

# Ruff and isort classify the aliased portfolio exception imports differently.
# ruff: noqa: I001

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Sequence
from datetime import datetime
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
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core.config import (
    GIT_SHA_PATTERN,
    PRODUCTION_RUNTIME_DATABASE_ROLE,
    AppEnvironment,
    PaymentProvider,
    normalize_database_url,
    validate_alembic_head,
    validate_neon_database_url,
)
from app.demo import (
    PortfolioDatasetError,
    PortfolioSeedPlan,
    generate_portfolio_dataset,
)
from app.seed.portfolio import (
    EXPECTED_SCHEMA_REVISION,
)
from app.seed.portfolio import (
    PortfolioSeedConflictError as PortfolioPersistenceConflictError,
)
from app.seed.portfolio import (
    PortfolioSeedDatabaseError as PortfolioPersistenceDatabaseError,
)
from app.seed.portfolio import PortfolioSeedPlanError as PortfolioPersistencePlanError
from app.seed.portfolio import (
    PortfolioSeedResult,
)
from app.seed.portfolio import (
    PortfolioSeedSchemaError as PortfolioPersistenceSchemaError,
)
from app.seed.portfolio import (
    seed_portfolio_data,
)
from app.seed.safety import (
    SeedSafetyError,
    reject_target_changing_postgres_environment,
)

DEPLOYMENT_SEED_CONFIRMATION = "SEED_NORDIC_HEARTH_DEMO"
DEPLOYMENT_SEED_LOCK_KEY = int.from_bytes(b"ROA-SEED", byteorder="big", signed=True)
DATABASE_NAME_PATTERN = re.compile(r"[a-z][a-z0-9_]{0,62}")
PLAN_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
DISALLOWED_DATABASE_NAMES = frozenset(
    {
        "postgres",
        "restaurant_ordering_analytics_dev",
        "restaurant_ordering_analytics_test",
    }
)


class DeploymentSeedError(Exception):
    """Represent one deployment seed failure with a stable public message."""

    public_message: ClassVar[str] = "Deployment demo seed failed."

    def __init__(self) -> None:
        """Initialize without accepting sensitive context."""
        super().__init__(self.public_message)


class DeploymentSeedConfigurationError(DeploymentSeedError):
    """Report invalid operator input or deployment configuration."""

    public_message = "Deployment demo seed configuration rejected."


class DeploymentSeedPlanError(DeploymentSeedError):
    """Report a non-canonical or unexpectedly hashed portfolio plan."""

    public_message = "Deployment demo seed plan rejected."


class DeploymentSeedTargetError(DeploymentSeedError):
    """Report a database identity or session-policy mismatch."""

    public_message = "Deployment demo seed target rejected."


class DeploymentSeedLockError(DeploymentSeedError):
    """Report a concurrent deployment seed attempt."""

    public_message = "Deployment demo seed lock unavailable."


class DeploymentSeedSchemaError(DeploymentSeedError):
    """Report a database outside the exact approved schema revision."""

    public_message = "Deployment demo seed schema rejected."


class DeploymentSeedConflictError(DeploymentSeedError):
    """Report partial, drifted, or conflicting portfolio data."""

    public_message = "Deployment demo seed data conflict."


class DeploymentSeedExecutionError(DeploymentSeedError):
    """Report a sanitized database or cleanup failure."""

    public_message = "Deployment demo seed failed."


class _SecretFreeArgumentParser(argparse.ArgumentParser):
    """Convert every invalid CLI shape to one stable redacted error."""

    def error(self, message: str) -> None:
        raise DeploymentSeedConfigurationError()


class DeploymentSeedSettings(BaseSettings):
    """Load only the explicit production demo seed boundary settings."""

    app_environment: AppEnvironment
    portfolio_demo_mode: bool
    payment_provider: PaymentProvider
    deployment_seed_database_url: PostgresDsn = Field(repr=False)
    deployment_seed_expected_database_name: str
    expected_alembic_head: str
    release_sha: str

    @field_validator("portfolio_demo_mode", mode="before")
    @classmethod
    def validate_portfolio_demo_mode(cls, value: object) -> bool:
        """Accept only an explicit true or false value."""
        if isinstance(value, bool):
            return value
        if value == "true":
            return True
        if value == "false":
            return False
        raise ValueError("Portfolio demo mode must be exactly true or false")

    @field_validator("deployment_seed_database_url", mode="before")
    @classmethod
    def normalize_seed_database_url(cls, value: object) -> object:
        """Normalize only the dedicated deployment seed URL."""
        return normalize_database_url(value)

    @field_validator("deployment_seed_database_url")
    @classmethod
    def validate_seed_database_url(cls, value: PostgresDsn) -> PostgresDsn:
        """Require credentialed Neon runtime-role connectivity."""
        parsed_url = make_url(str(value))
        if not parsed_url.username or not parsed_url.password:
            raise ValueError("Deployment seed database credentials are required")
        validate_neon_database_url(
            value,
            purpose="runtime",
            expected_username=PRODUCTION_RUNTIME_DATABASE_ROLE,
        )
        return value

    @field_validator("deployment_seed_expected_database_name")
    @classmethod
    def validate_expected_database_name(cls, value: str) -> str:
        """Require one explicit non-administrative database identifier."""
        if (
            DATABASE_NAME_PATTERN.fullmatch(value) is None
            or value in DISALLOWED_DATABASE_NAMES
        ):
            raise ValueError("Deployment seed database name is not allowed")
        return value

    @field_validator("expected_alembic_head")
    @classmethod
    def validate_expected_head(cls, value: str) -> str:
        """Require one safe exact Alembic revision."""
        validated = validate_alembic_head(value)
        if validated is None:
            raise ValueError("Expected Alembic head is required")
        return validated

    @field_validator("release_sha")
    @classmethod
    def validate_release_sha(cls, value: str) -> str:
        """Require a complete lowercase source commit identity."""
        if GIT_SHA_PATTERN.fullmatch(value) is None:
            raise ValueError("Release SHA must be a complete lowercase commit SHA")
        return value

    @model_validator(mode="after")
    def validate_deployment_contract(self) -> DeploymentSeedSettings:
        """Require the exact production demo runtime and database identity."""
        if (
            self.app_environment != "production"
            or self.portfolio_demo_mode is not True
            or self.payment_provider != "demo"
            or self.expected_alembic_head != EXPECTED_SCHEMA_REVISION
        ):
            raise ValueError("Deployment seed runtime contract is invalid")
        parsed_url = make_url(str(self.deployment_seed_database_url))
        if parsed_url.database != self.deployment_seed_expected_database_name:
            raise ValueError("Deployment seed database identity does not match")
        return self

    model_config = SettingsConfigDict(
        env_file=None,
        env_ignore_empty=True,
        extra="ignore",
        hide_input_in_errors=True,
    )


def run_deployment_seed(
    settings: DeploymentSeedSettings,
    *,
    reference_end: datetime,
    expected_plan_sha256: str,
) -> PortfolioSeedResult:
    """Persist or verify one operator-approved canonical deployment dataset.

    Args:
        settings: Validated production-only deployment seed settings.
        reference_end: Explicit aware end of the 60-day Europe/Oslo window.
        expected_plan_sha256: Independently approved canonical plan digest.

    Returns:
        Exact persisted or already-present portfolio row counts.

    Raises:
        DeploymentSeedError: If any plan, target, schema, state, or database
            invariant fails.
    """
    configuration_failure: DeploymentSeedConfigurationError | None = None
    try:
        reject_target_changing_postgres_environment()
    except SeedSafetyError:
        configuration_failure = DeploymentSeedConfigurationError()
    if configuration_failure is not None:
        raise configuration_failure
    plan = _generate_expected_plan(reference_end, expected_plan_sha256)
    engine: Engine | None = None
    result: PortfolioSeedResult | None = None
    failure: DeploymentSeedError | None = None
    try:
        engine = _create_deployment_seed_engine(settings.deployment_seed_database_url)
        result = _run_with_engine(
            engine,
            plan=plan,
            expected_database_name=settings.deployment_seed_expected_database_name,
            expected_login_role=PRODUCTION_RUNTIME_DATABASE_ROLE,
        )
    except DeploymentSeedError as exc:
        failure = exc
    except (SQLAlchemyError, ValueError):
        failure = DeploymentSeedExecutionError()
    except Exception:
        # This is the final redaction boundary around third-party integrations.
        failure = DeploymentSeedExecutionError()
    finally:
        if engine is not None:
            try:
                engine.dispose()
            except SQLAlchemyError:
                if failure is None:
                    failure = DeploymentSeedExecutionError()

    if failure is not None:
        raise failure
    if result is None:  # pragma: no cover - defensive invariant
        raise DeploymentSeedExecutionError()
    return result


def main(argv: Sequence[str] | None = None) -> int:
    """Run the explicit deployment seed command with secret-free output."""
    parser = _build_parser()

    try:
        arguments = parser.parse_args(argv)
        if arguments.confirmation != DEPLOYMENT_SEED_CONFIRMATION:
            raise DeploymentSeedConfigurationError()
        reference_end = _parse_reference_end(arguments.portfolio_reference_end)
        expected_plan_sha256 = _validate_sha256(arguments.expected_plan_sha256)
        expected_release_sha = _validate_release_sha(arguments.expected_release_sha)
        reject_target_changing_postgres_environment()
        settings = DeploymentSeedSettings()
        if settings.release_sha != expected_release_sha:
            raise DeploymentSeedConfigurationError()
        result = run_deployment_seed(
            settings,
            reference_end=reference_end,
            expected_plan_sha256=expected_plan_sha256,
        )
    except (ValidationError, SettingsError, SeedSafetyError):
        print(DeploymentSeedConfigurationError.public_message, file=sys.stderr)
        return 1
    except PortfolioDatasetError:
        print(DeploymentSeedPlanError.public_message, file=sys.stderr)
        return 1
    except DeploymentSeedError as exc:
        print(exc.public_message, file=sys.stderr)
        return 1
    except Exception:
        # This is the final redaction boundary around third-party integrations.
        print(DeploymentSeedExecutionError.public_message, file=sys.stderr)
        return 1

    action = "inserted" if result.inserted else "already exact"
    print(
        "Deployment demo seed completed: "
        f"{result.orders_processed} orders and "
        f"{result.payments_processed} payments {action}."
    )
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = _SecretFreeArgumentParser(
        description="Persist one explicitly approved production demo dataset.",
        allow_abbrev=False,
    )
    parser.add_argument("--confirmation", required=True)
    parser.add_argument("--portfolio-reference-end", required=True)
    parser.add_argument("--expected-plan-sha256", required=True)
    parser.add_argument("--expected-release-sha", required=True)
    return parser


def _parse_reference_end(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith(("Z", "z")):
        normalized = f"{normalized[:-1]}+00:00"
    reference_end: datetime | None = None
    try:
        reference_end = datetime.fromisoformat(normalized)
    except ValueError:
        pass
    if (
        reference_end is None
        or reference_end.tzinfo is None
        or reference_end.utcoffset() is None
    ):
        raise DeploymentSeedPlanError()
    return reference_end


def _validate_sha256(value: str) -> str:
    if PLAN_SHA256_PATTERN.fullmatch(value) is None:
        raise DeploymentSeedConfigurationError()
    return value


def _validate_release_sha(value: str) -> str:
    if GIT_SHA_PATTERN.fullmatch(value) is None:
        raise DeploymentSeedConfigurationError()
    return value


def _generate_expected_plan(
    reference_end: datetime,
    expected_plan_sha256: str,
) -> PortfolioSeedPlan:
    plan: PortfolioSeedPlan | None = None
    try:
        plan = generate_portfolio_dataset(reference_end)
    except PortfolioDatasetError:
        pass
    if plan is None or plan.canonical_sha256 != expected_plan_sha256:
        raise DeploymentSeedPlanError()
    return plan


def _create_deployment_seed_engine(database_url: PostgresDsn) -> Engine:
    return create_engine(
        str(database_url),
        pool_pre_ping=True,
        poolclass=NullPool,
        hide_parameters=True,
    )


def _run_with_engine(
    engine: Engine,
    *,
    plan: PortfolioSeedPlan,
    expected_database_name: str,
    expected_login_role: str,
) -> PortfolioSeedResult:
    result: PortfolioSeedResult | None = None
    failure: DeploymentSeedError | None = None
    try:
        with engine.connect() as connection:
            with connection.begin():
                _require_target_identity(
                    connection,
                    expected_database_name=expected_database_name,
                    expected_login_role=expected_login_role,
                )
                _pin_public_search_path(connection)
                _acquire_seed_lock(connection)
                factory = sessionmaker[Session](
                    bind=connection,
                    expire_on_commit=False,
                    join_transaction_mode="rollback_only",
                )
                result = seed_portfolio_data(factory, plan)
    except DeploymentSeedError as exc:
        failure = exc
    except PortfolioPersistencePlanError:
        failure = DeploymentSeedPlanError()
    except PortfolioPersistenceSchemaError:
        failure = DeploymentSeedSchemaError()
    except PortfolioPersistenceConflictError:
        failure = DeploymentSeedConflictError()
    except (PortfolioPersistenceDatabaseError, SQLAlchemyError):
        failure = DeploymentSeedExecutionError()

    if failure is not None:
        raise failure
    if result is None:  # pragma: no cover - defensive invariant
        raise DeploymentSeedExecutionError()
    return result


def _require_target_identity(
    connection: Connection,
    *,
    expected_database_name: str,
    expected_login_role: str,
) -> None:
    identity: object | None = None
    query_failed = False
    try:
        identity = connection.execute(
            text(
                "SELECT session_user, current_user, current_database(), "
                "current_setting('transaction_read_only')"
            )
        ).one()
    except SQLAlchemyError:
        query_failed = True
    if (
        query_failed
        or identity is None
        or tuple(identity)
        != (
            expected_login_role,
            expected_login_role,
            expected_database_name,
            "off",
        )
    ):
        raise DeploymentSeedTargetError()


def _pin_public_search_path(connection: Connection) -> None:
    schemas: object | None = None
    query_failed = False
    try:
        connection.exec_driver_sql("SET LOCAL search_path TO public")
        schemas = connection.execute(text("SELECT current_schemas(false)")).scalar_one()
    except SQLAlchemyError:
        query_failed = True
    if (
        query_failed
        or not isinstance(schemas, (list, tuple))
        or tuple(schemas) != ("public",)
    ):
        raise DeploymentSeedTargetError()


def _acquire_seed_lock(connection: Connection) -> None:
    acquired: object | None = None
    query_failed = False
    try:
        acquired = connection.execute(
            text("SELECT pg_try_advisory_xact_lock(:lock_key)"),
            {"lock_key": DEPLOYMENT_SEED_LOCK_KEY},
        ).scalar_one()
    except SQLAlchemyError:
        query_failed = True
    if query_failed:
        raise DeploymentSeedExecutionError()
    if acquired is not True:
        raise DeploymentSeedLockError()


if __name__ == "__main__":
    raise SystemExit(main())
