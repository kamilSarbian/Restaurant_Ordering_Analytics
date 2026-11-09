"""Operator-gated verification and demo-admin control for portfolio deployment."""

from __future__ import annotations

import argparse
import getpass
import re
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import ClassVar, Literal

from pydantic import PostgresDsn, TypeAdapter, ValidationError
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine, make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from app.auth.demo_admin import (
    DemoAdminConflictError,
    DemoAdminDatabaseError,
    DemoAdminResult,
    deactivate_demo_admin,
    inspect_demo_admin,
    provision_demo_admin,
)
from app.core.config import (
    GIT_SHA_PATTERN,
    PRODUCTION_RUNTIME_DATABASE_ROLE,
    normalize_database_url,
    validate_neon_database_url,
)
from app.demo import (
    PortfolioDatasetError,
    PortfolioSeedPlan,
    generate_portfolio_dataset,
)
from app.orders.runtime_reset import (
    PortfolioRuntimeResetConflictError,
    PortfolioRuntimeResetDatabaseError,
    PortfolioRuntimeResetResult,
    reset_portfolio_runtime_data,
)
from app.seed.portfolio import (
    PortfolioSeedConflictError,
    PortfolioSeedDatabaseError,
    PortfolioSeedPlanError,
    PortfolioSeedResult,
    PortfolioSeedSchemaError,
    verify_portfolio_data,
    verify_portfolio_schema,
)
from app.seed.safety import (
    SeedSafetyError,
    reject_target_changing_postgres_environment,
)

PORTFOLIO_DATABASE_NAME = "roa_portfolio"
NEON_MANAGED_ADMIN_ROLE = "cloud_admin"
PORTFOLIO_MIGRATOR_ROLE = "roa_migrator"
PORTFOLIO_OWNER_ROLE = "roa_owner"
PORTFOLIO_RUNTIME_ROLE = PRODUCTION_RUNTIME_DATABASE_ROLE
PROVISION_CONFIRMATION = "PROVISION_NORDIC_HEARTH_DEMO_ADMIN"
DEACTIVATE_CONFIRMATION = "DEACTIVATE_NORDIC_HEARTH_DEMO_ADMIN"
RESET_RUNTIME_CONFIRMATION = "RESET_NORDIC_HEARTH_PORTFOLIO_RUNTIME"
PLAN_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
HOST_LABEL_PATTERN = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]

PortfolioAction = Literal[
    "verify-state",
    "provision",
    "deactivate",
    "reset-runtime",
]


class PortfolioDeploymentError(Exception):
    """Represent one operator failure with a stable public message."""

    public_message: ClassVar[str] = "Portfolio deployment operation failed."

    def __init__(self) -> None:
        """Initialize without accepting sensitive context."""
        super().__init__(self.public_message)


class PortfolioDeploymentConfigurationError(PortfolioDeploymentError):
    """Report rejected operator input or local release state."""

    public_message = "Portfolio deployment configuration rejected."


class PortfolioDeploymentPlanError(PortfolioDeploymentError):
    """Report a non-canonical or unexpectedly hashed portfolio plan."""

    public_message = "Portfolio deployment plan rejected."


class PortfolioDeploymentTargetError(PortfolioDeploymentError):
    """Report an unexpected database, role, or session target."""

    public_message = "Portfolio deployment target rejected."


class PortfolioDeploymentStateError(PortfolioDeploymentError):
    """Report drifted portfolio rows or demo-administrator identity."""

    public_message = "Portfolio deployment state rejected."


class PortfolioDeploymentExecutionError(PortfolioDeploymentError):
    """Report a sanitized database, process, or cleanup failure."""

    public_message = "Portfolio deployment operation failed."


class _SecretFreeArgumentParser(argparse.ArgumentParser):
    """Replace argparse diagnostics with one redacted failure."""

    def error(self, message: str) -> None:
        del message
        raise PortfolioDeploymentConfigurationError()


@dataclass(frozen=True, slots=True)
class PortfolioDeploymentResult:
    """Summarize verified portfolio counts and the demo-admin outcome."""

    action: PortfolioAction
    portfolio: PortfolioSeedResult | None
    demo_admin: DemoAdminResult
    runtime_reset: PortfolioRuntimeResetResult | None = None


def _run_portfolio_operation(
    action: PortfolioAction,
    *,
    database_url: PostgresDsn,
    expected_endpoint_host: str,
    plan: PortfolioSeedPlan | None,
) -> PortfolioDeploymentResult:
    """Run one verified portfolio operation against an approved hidden URL.

    Args:
        action: Verification, account control, or guarded runtime-data reset.
        database_url: URL obtained by the CLI through a hidden interactive prompt.
        expected_endpoint_host: Independently copied exact Neon pooler hostname.
        plan: Independently pinned canonical plan, omitted only for deactivation.

    Returns:
        Exact aggregate counts and demo-administrator operation state.

    Raises:
        PortfolioDeploymentError: If any target, state, or execution check fails.
    """
    engine: Engine | None = None
    result: PortfolioDeploymentResult | None = None
    failure: PortfolioDeploymentError | None = None
    try:
        _require_action(action)
        reject_target_changing_postgres_environment()
        validated_url = _validate_runtime_database_url(
            database_url,
            expected_endpoint_host=expected_endpoint_host,
        )
        engine = _create_engine(validated_url)
        result = _run_with_engine(engine, action=action, plan=plan)
    except PortfolioDeploymentError as exc:
        failure = exc
    except SeedSafetyError:
        failure = PortfolioDeploymentConfigurationError()
    except (SQLAlchemyError, ValueError, ValidationError):
        failure = PortfolioDeploymentExecutionError()
    except Exception:
        # Final redaction boundary for driver and platform integrations.
        failure = PortfolioDeploymentExecutionError()
    finally:
        if engine is not None:
            try:
                engine.dispose()
            except SQLAlchemyError:
                if failure is None:
                    failure = PortfolioDeploymentExecutionError()

    if failure is not None:
        raise failure
    if result is None:  # pragma: no cover - defensive invariant
        raise PortfolioDeploymentExecutionError()
    return result


def main(argv: Sequence[str] | None = None) -> int:
    """Run one hidden-credential portfolio deployment operator action."""
    parser = _build_parser()
    try:
        arguments = parser.parse_args(argv)
        action: PortfolioAction = arguments.action
        _require_confirmation(action, arguments.confirmation)
        expected_release_sha = _validate_release_sha(arguments.expected_release_sha)
        _require_exact_checkout(expected_release_sha)
        reject_target_changing_postgres_environment()
        plan: PortfolioSeedPlan | None = None
        if action == "deactivate":
            if (
                arguments.portfolio_reference_end is not None
                or arguments.expected_plan_sha256 is not None
            ):
                raise PortfolioDeploymentConfigurationError()
        else:
            if (
                arguments.portfolio_reference_end is None
                or arguments.expected_plan_sha256 is None
            ):
                raise PortfolioDeploymentConfigurationError()
            plan = _generate_expected_plan(
                arguments.portfolio_reference_end,
                arguments.expected_plan_sha256,
            )
        raw_url = getpass.getpass(
            "Neon pooled roa_runtime URL for roa_portfolio (hidden): "
        )
        database_url = _parse_runtime_database_url(
            raw_url,
            expected_endpoint_host=arguments.expected_endpoint_host,
        )
        result = _run_portfolio_operation(
            action,
            database_url=database_url,
            expected_endpoint_host=arguments.expected_endpoint_host,
            plan=plan,
        )
    except (EOFError, ValidationError, SeedSafetyError):
        print(PortfolioDeploymentConfigurationError.public_message, file=sys.stderr)
        return 1
    except PortfolioDatasetError:
        print(PortfolioDeploymentPlanError.public_message, file=sys.stderr)
        return 1
    except PortfolioDeploymentError as exc:
        print(exc.public_message, file=sys.stderr)
        return 1
    except Exception:
        # Never render raw process, validation, or driver failures.
        print(PortfolioDeploymentExecutionError.public_message, file=sys.stderr)
        return 1

    print(_success_message(result))
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = _SecretFreeArgumentParser(
        description=(
            "Verify portfolio deployment state, control the reserved demo "
            "administrator, or reset validated portfolio-runtime rows without "
            "accepting a database URL on the command line."
        ),
        allow_abbrev=False,
    )
    parser.add_argument(
        "action",
        choices=("verify-state", "provision", "deactivate", "reset-runtime"),
    )
    parser.add_argument("--expected-endpoint-host", required=True)
    parser.add_argument("--portfolio-reference-end")
    parser.add_argument("--expected-plan-sha256")
    parser.add_argument("--expected-release-sha", required=True)
    parser.add_argument("--confirmation")
    return parser


def _require_confirmation(action: PortfolioAction, confirmation: str | None) -> None:
    expected = {
        "verify-state": None,
        "provision": PROVISION_CONFIRMATION,
        "deactivate": DEACTIVATE_CONFIRMATION,
        "reset-runtime": RESET_RUNTIME_CONFIRMATION,
    }[action]
    if confirmation != expected:
        raise PortfolioDeploymentConfigurationError()


def _require_action(action: object) -> PortfolioAction:
    if action not in (
        "verify-state",
        "provision",
        "deactivate",
        "reset-runtime",
    ):
        raise PortfolioDeploymentConfigurationError()
    return action  # type: ignore[return-value]


def _validate_release_sha(value: str) -> str:
    if GIT_SHA_PATTERN.fullmatch(value) is None:
        raise PortfolioDeploymentConfigurationError()
    return value


def _require_exact_checkout(expected_release_sha: str) -> None:
    head: str | None = None
    clean = False
    failed = False
    try:
        head_result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            check=False,
            shell=False,
        )
        status_result = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            check=False,
            shell=False,
        )
        if head_result.returncode == 0 and status_result.returncode == 0:
            head = head_result.stdout.strip()
            clean = status_result.stdout == ""
        else:
            failed = True
    except (OSError, subprocess.SubprocessError):
        failed = True
    if failed or head != expected_release_sha or not clean:
        raise PortfolioDeploymentConfigurationError()


def _generate_expected_plan(
    reference_end_value: str,
    expected_plan_sha256: str,
) -> PortfolioSeedPlan:
    if PLAN_SHA256_PATTERN.fullmatch(expected_plan_sha256) is None:
        raise PortfolioDeploymentConfigurationError()
    normalized = reference_end_value.strip()
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
        raise PortfolioDeploymentPlanError()
    plan: PortfolioSeedPlan | None = None
    try:
        plan = generate_portfolio_dataset(reference_end)
    except PortfolioDatasetError:
        pass
    if plan is None or plan.canonical_sha256 != expected_plan_sha256:
        raise PortfolioDeploymentPlanError()
    return plan


def _parse_runtime_database_url(
    raw_url: str,
    *,
    expected_endpoint_host: str,
) -> PostgresDsn:
    parsed: PostgresDsn | None = None
    try:
        normalized = normalize_database_url(raw_url)
        parsed = TypeAdapter(PostgresDsn).validate_python(normalized)
        _validate_runtime_database_url(
            parsed,
            expected_endpoint_host=expected_endpoint_host,
        )
    except (TypeError, ValueError, ValidationError):
        pass
    if parsed is None:
        raise PortfolioDeploymentConfigurationError()
    return parsed


def _validate_runtime_database_url(
    database_url: PostgresDsn,
    *,
    expected_endpoint_host: str,
) -> PostgresDsn:
    if not _is_exact_neon_pooler_host(expected_endpoint_host):
        raise PortfolioDeploymentConfigurationError()
    try:
        validate_neon_database_url(
            database_url,
            purpose="runtime",
            expected_username=PORTFOLIO_RUNTIME_ROLE,
        )
        parsed = make_url(str(database_url))
    except (TypeError, ValueError):
        raise PortfolioDeploymentConfigurationError() from None
    if (
        parsed.host != expected_endpoint_host
        or parsed.database != PORTFOLIO_DATABASE_NAME
    ):
        raise PortfolioDeploymentConfigurationError()
    return database_url


def _is_exact_neon_pooler_host(host: str) -> bool:
    if host != host.strip() or host != host.lower() or len(host) > 253:
        return False
    labels = host.split(".")
    return (
        len(labels) >= 3
        and labels[0].startswith("ep-")
        and labels[0].endswith("-pooler")
        and host.endswith(".neon.tech")
        and all(HOST_LABEL_PATTERN.fullmatch(label) is not None for label in labels)
    )


def _create_engine(database_url: PostgresDsn) -> Engine:
    return create_engine(
        str(database_url),
        pool_pre_ping=True,
        poolclass=NullPool,
        hide_parameters=True,
    )


def _run_with_engine(
    engine: Engine,
    *,
    action: PortfolioAction,
    plan: PortfolioSeedPlan | None,
    expected_database_name: str = PORTFOLIO_DATABASE_NAME,
    expected_login_role: str = PORTFOLIO_RUNTIME_ROLE,
    verify_roles: bool = True,
) -> PortfolioDeploymentResult:
    _require_action(action)
    if (action == "deactivate") != (plan is None):
        raise PortfolioDeploymentConfigurationError()
    result: PortfolioDeploymentResult | None = None
    failure: PortfolioDeploymentError | None = None
    try:
        with engine.connect() as connection:
            with connection.begin():
                read_only = action == "verify-state"
                if read_only:
                    connection.exec_driver_sql("SET TRANSACTION READ ONLY")
                _require_target_identity(
                    connection,
                    expected_database_name=expected_database_name,
                    expected_login_role=expected_login_role,
                    read_only=read_only,
                )
                _pin_public_search_path(connection)
                if verify_roles:
                    _require_role_contract(connection)
                factory = sessionmaker(
                    bind=connection,
                    expire_on_commit=False,
                    join_transaction_mode="rollback_only",
                )
                portfolio_result: PortfolioSeedResult | None
                if action == "deactivate":
                    verify_portfolio_schema(factory)
                    portfolio_result = None
                    demo_result = deactivate_demo_admin(factory)
                else:
                    assert plan is not None  # enforced by the action/plan guard
                    portfolio_result = verify_portfolio_data(factory, plan)
                runtime_reset: PortfolioRuntimeResetResult | None = None
                if action == "verify-state":
                    demo_result = inspect_demo_admin(factory)
                elif action == "provision":
                    demo_result = provision_demo_admin(factory)
                elif action == "reset-runtime":
                    with factory() as reset_session:
                        runtime_reset = reset_portfolio_runtime_data(reset_session)
                    assert plan is not None
                    portfolio_result = verify_portfolio_data(factory, plan)
                    demo_result = inspect_demo_admin(factory)
                result = PortfolioDeploymentResult(
                    action=action,
                    portfolio=portfolio_result,
                    demo_admin=demo_result,
                    runtime_reset=runtime_reset,
                )
    except PortfolioDeploymentError as exc:
        failure = exc
    except PortfolioSeedPlanError:
        failure = PortfolioDeploymentPlanError()
    except PortfolioSeedSchemaError:
        failure = PortfolioDeploymentStateError()
    except (
        PortfolioSeedConflictError,
        DemoAdminConflictError,
        PortfolioRuntimeResetConflictError,
    ):
        failure = PortfolioDeploymentStateError()
    except (
        PortfolioSeedDatabaseError,
        DemoAdminDatabaseError,
        PortfolioRuntimeResetDatabaseError,
        SQLAlchemyError,
    ):
        failure = PortfolioDeploymentExecutionError()

    if failure is not None:
        raise failure
    if result is None:  # pragma: no cover - defensive invariant
        raise PortfolioDeploymentExecutionError()
    return result


def _require_target_identity(
    connection: Connection,
    *,
    expected_database_name: str,
    expected_login_role: str,
    read_only: bool,
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
    expected_mode = "on" if read_only else "off"
    if (
        query_failed
        or identity is None
        or tuple(identity)
        != (
            expected_login_role,
            expected_login_role,
            expected_database_name,
            expected_mode,
        )
    ):
        raise PortfolioDeploymentTargetError()


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
        raise PortfolioDeploymentTargetError()


def _require_role_contract(connection: Connection) -> None:
    role_rows: object | None = None
    membership_rows: object | None = None
    capabilities: object | None = None
    effective_members: object | None = None
    query_failed = False
    try:
        role_rows = connection.execute(
            text(
                "SELECT rolname, rolcanlogin, rolinherit "
                "FROM pg_catalog.pg_roles "
                "WHERE rolname IN ('roa_migrator', 'roa_owner', 'roa_runtime') "
                "ORDER BY rolname"
            )
        ).all()
        membership_rows = connection.execute(
            text(
                "SELECT member_role.rolname, membership.set_option "
                "FROM pg_catalog.pg_auth_members AS membership "
                "JOIN pg_catalog.pg_roles AS granted_role "
                "ON granted_role.oid = membership.roleid "
                "JOIN pg_catalog.pg_roles AS member_role "
                "ON member_role.oid = membership.member "
                "WHERE granted_role.rolname = 'roa_owner' "
                "AND membership.set_option "
                "ORDER BY member_role.rolname"
            )
        ).all()
        capabilities = connection.execute(
            text(
                "SELECT pg_has_role('roa_migrator', 'roa_owner', 'SET'), "
                "pg_has_role('roa_runtime', 'roa_owner', 'SET')"
            )
        ).one()
        effective_members = (
            connection.execute(
                text(
                    "SELECT candidate.rolname "
                    "FROM pg_catalog.pg_roles AS candidate "
                    "WHERE candidate.rolname <> 'roa_owner' "
                    "AND pg_has_role(candidate.oid, 'roa_owner', 'SET') "
                    "ORDER BY candidate.rolname"
                )
            )
            .scalars()
            .all()
        )
    except SQLAlchemyError:
        query_failed = True
    normalized_roles = tuple(tuple(row) for row in role_rows or ())
    normalized_memberships = tuple(tuple(row) for row in membership_rows or ())
    if any(len(row) != 3 for row in normalized_roles):
        raise PortfolioDeploymentTargetError()
    roles_by_name = {
        str(role_name): (can_login, inherits)
        for role_name, can_login, inherits in normalized_roles
    }
    if (
        query_failed
        or set(roles_by_name)
        != {
            PORTFOLIO_MIGRATOR_ROLE,
            PORTFOLIO_OWNER_ROLE,
            PORTFOLIO_RUNTIME_ROLE,
        }
        or roles_by_name[PORTFOLIO_MIGRATOR_ROLE] != (True, False)
        or roles_by_name[PORTFOLIO_RUNTIME_ROLE] != (True, False)
        or normalized_memberships != ((PORTFOLIO_MIGRATOR_ROLE, True),)
        or capabilities is None
        or tuple(capabilities) != (True, False)
        or tuple(effective_members or ())
        != (NEON_MANAGED_ADMIN_ROLE, PORTFOLIO_MIGRATOR_ROLE)
    ):
        raise PortfolioDeploymentTargetError()


def _success_message(result: PortfolioDeploymentResult) -> str:
    if result.runtime_reset is not None:
        reset = result.runtime_reset
        if reset.already_empty:
            deleted = "runtime data already empty; 0 rows deleted"
        else:
            deleted = (
                f"{reset.orders_deleted} runtime orders, "
                f"{reset.order_items_deleted} items, "
                f"{reset.status_history_deleted} history rows, and "
                f"{reset.payments_deleted} payments deleted"
            )
        return (
            f"Portfolio deployment {result.action} completed: {deleted}; "
            f"canonical seed verified; demo administrator "
            f"{result.demo_admin.status}."
        )
    if result.portfolio is None:
        return (
            f"Portfolio deployment {result.action} completed: exact schema verified; "
            f"demo administrator {result.demo_admin.status}."
        )
    counts = (
        f"{result.portfolio.categories_processed} categories, "
        f"{result.portfolio.menu_items_processed} menu items, "
        f"{result.portfolio.tables_processed} tables, "
        f"{result.portfolio.orders_processed} orders, "
        f"{result.portfolio.order_items_processed} items, "
        f"{result.portfolio.status_history_processed} history rows, and "
        f"{result.portfolio.payments_processed} payments"
    )
    return (
        f"Portfolio deployment {result.action} completed: {counts}; "
        f"demo administrator {result.demo_admin.status}."
    )


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "DEACTIVATE_CONFIRMATION",
    "NEON_MANAGED_ADMIN_ROLE",
    "PORTFOLIO_DATABASE_NAME",
    "PORTFOLIO_MIGRATOR_ROLE",
    "PORTFOLIO_OWNER_ROLE",
    "PORTFOLIO_RUNTIME_ROLE",
    "PROVISION_CONFIRMATION",
    "RESET_RUNTIME_CONFIRMATION",
    "PortfolioDeploymentConfigurationError",
    "PortfolioDeploymentError",
    "PortfolioDeploymentExecutionError",
    "PortfolioDeploymentPlanError",
    "PortfolioDeploymentResult",
    "PortfolioDeploymentStateError",
    "PortfolioDeploymentTargetError",
    "main",
]
