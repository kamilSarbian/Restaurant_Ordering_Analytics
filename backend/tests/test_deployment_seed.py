"""Unit tests for the operator-gated deployment demo seed boundary."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool

from app.seed import deployment
from app.seed.portfolio import EXPECTED_SCHEMA_REVISION, PortfolioSeedResult

REFERENCE_END = datetime(2026, 9, 23, tzinfo=ZoneInfo("Europe/Oslo"))
PLAN_SHA256 = "716200cc31feebe72a1dc237175e5c5780075bffa055a7086430dedb823bb9f3"
RELEASE_SHA = "d69d8d11587e1e0971e40d3a9442c231ee29ec02"
DATABASE_NAME = "nordic_hearth_demo"
DATABASE_SECRET = "synthetic-deployment-secret"
NEON_HOST = "ep-nordic-hearth-pooler.eu-central-1.aws.neon.tech"
NEON_URL = (
    f"postgresql://roa_runtime:{DATABASE_SECRET}@{NEON_HOST}/{DATABASE_NAME}"
    "?sslmode=require&channel_binding=require"
)
RAW_DATABASE_SECRET = "raw-database-secret-must-not-survive"


class _FailingConnection:
    def execute(self, *args: object, **kwargs: object) -> None:
        raise SQLAlchemyError(RAW_DATABASE_SECRET)

    def exec_driver_sql(self, *args: object, **kwargs: object) -> None:
        raise SQLAlchemyError(RAW_DATABASE_SECRET)


class _FailingEngine:
    def connect(self) -> None:
        raise SQLAlchemyError(RAW_DATABASE_SECRET)

    def dispose(self) -> None:
        return None


def _settings(**overrides: object) -> deployment.DeploymentSeedSettings:
    values: dict[str, object] = {
        "app_environment": "production",
        "portfolio_demo_mode": True,
        "payment_provider": "demo",
        "deployment_seed_database_url": NEON_URL,
        "deployment_seed_expected_database_name": DATABASE_NAME,
        "expected_alembic_head": EXPECTED_SCHEMA_REVISION,
        "release_sha": RELEASE_SHA,
    }
    values.update(overrides)
    return deployment.DeploymentSeedSettings(_env_file=None, **values)


def _result(*, inserted: bool = True) -> PortfolioSeedResult:
    return PortfolioSeedResult(
        inserted=inserted,
        categories_processed=5,
        menu_items_processed=15,
        tables_processed=12,
        orders_processed=500,
        order_items_processed=1_211,
        status_history_processed=2_326,
        payments_processed=484,
    )


def _assert_error_is_detached(error: BaseException) -> None:
    assert error.__cause__ is None
    assert error.__context__ is None
    assert RAW_DATABASE_SECRET not in str(error)


def test_settings_accept_only_exact_production_demo_target_and_hide_secret() -> None:
    """Accept the exact boundary while keeping connection data out of repr."""
    settings = _settings()

    parsed_url = make_url(str(settings.deployment_seed_database_url))
    assert parsed_url.drivername == "postgresql+psycopg"
    assert parsed_url.username == "roa_runtime"
    assert parsed_url.database == DATABASE_NAME
    assert DATABASE_SECRET not in repr(settings)
    assert NEON_HOST not in repr(settings)


@pytest.mark.parametrize(
    "overrides",
    (
        {"app_environment": "development"},
        {"portfolio_demo_mode": False},
        {"payment_provider": "stripe_test"},
        {"expected_alembic_head": "0008_wrong"},
        {"deployment_seed_expected_database_name": "postgres"},
        {"deployment_seed_expected_database_name": "other_demo"},
        {
            "deployment_seed_database_url": (
                "postgresql://wrong_role:synthetic@"
                f"{NEON_HOST}/{DATABASE_NAME}"
                "?sslmode=require&channel_binding=require"
            )
        },
        {
            "deployment_seed_database_url": (
                "postgresql://roa_runtime:synthetic@"
                "ep-nordic-hearth.eu-central-1.aws.neon.tech/"
                f"{DATABASE_NAME}?sslmode=require&channel_binding=require"
            )
        },
        {
            "deployment_seed_database_url": (
                "postgresql://roa_runtime:synthetic@127.0.0.1:5433/"
                f"{DATABASE_NAME}?sslmode=require&channel_binding=require"
            )
        },
    ),
)
def test_settings_reject_non_exact_runtime_without_exposing_connection(
    overrides: dict[str, object],
) -> None:
    """Reject every target or runtime variant without echoing connection data."""
    with pytest.raises(ValidationError) as raised:
        _settings(**overrides)

    message = str(raised.value)
    assert DATABASE_SECRET not in message
    assert NEON_HOST not in message


def test_run_rejects_plan_hash_before_engine_creation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify the approved plan digest before constructing a database engine."""

    def unexpected_engine(database_url: object) -> None:
        raise AssertionError("engine must not be created")

    monkeypatch.setattr(deployment, "_create_deployment_seed_engine", unexpected_engine)

    with pytest.raises(deployment.DeploymentSeedPlanError):
        deployment.run_deployment_seed(
            _settings(),
            reference_end=REFERENCE_END,
            expected_plan_sha256="0" * 64,
        )


def test_run_rejects_target_changing_postgres_environment_before_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject ambient libpq target controls before opening a connection."""
    monkeypatch.setenv("PGHOST", "unapproved.example")

    def unexpected_engine(database_url: object) -> None:
        raise AssertionError("engine must not be created")

    monkeypatch.setattr(deployment, "_create_deployment_seed_engine", unexpected_engine)

    with pytest.raises(deployment.DeploymentSeedConfigurationError):
        deployment.run_deployment_seed(
            _settings(),
            reference_end=REFERENCE_END,
            expected_plan_sha256=PLAN_SHA256,
        )


def test_engine_uses_one_secret_redacting_non_pooled_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Create a NullPool engine with SQL parameter redaction enabled."""
    sentinel = object()
    captured: dict[str, object] = {}

    def fake_create_engine(url: str, **kwargs: object) -> object:
        captured["url"] = url
        captured.update(kwargs)
        return sentinel

    monkeypatch.setattr(deployment, "create_engine", fake_create_engine)

    engine = deployment._create_deployment_seed_engine(
        _settings().deployment_seed_database_url
    )

    assert engine is sentinel
    assert make_url(str(captured["url"])).database == DATABASE_NAME
    assert captured["poolclass"] is NullPool
    assert captured["pool_pre_ping"] is True
    assert captured["hide_parameters"] is True


def test_database_translation_detaches_raw_errors_and_cli_redacts_them(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Discard raw database exceptions before exposing domain or CLI failures."""
    settings = _settings()
    monkeypatch.setattr(
        deployment,
        "_create_deployment_seed_engine",
        lambda database_url: _FailingEngine(),
    )

    with pytest.raises(deployment.DeploymentSeedExecutionError) as raised:
        deployment.run_deployment_seed(
            settings,
            reference_end=REFERENCE_END,
            expected_plan_sha256=PLAN_SHA256,
        )
    _assert_error_is_detached(raised.value)

    monkeypatch.setattr(deployment, "DeploymentSeedSettings", lambda: settings)
    assert (
        deployment.main(
            [
                "--confirmation",
                deployment.DEPLOYMENT_SEED_CONFIRMATION,
                "--portfolio-reference-end",
                REFERENCE_END.isoformat(),
                "--expected-plan-sha256",
                PLAN_SHA256,
                "--expected-release-sha",
                RELEASE_SHA,
            ]
        )
        == 1
    )
    captured = capsys.readouterr()
    assert captured.out == ""
    assert (
        captured.err.strip() == deployment.DeploymentSeedExecutionError.public_message
    )
    assert RAW_DATABASE_SECRET not in captured.err


def test_database_preflight_helpers_detach_raw_errors() -> None:
    """Keep target, search-path, and lock failures free of database context."""
    connection = _FailingConnection()
    checks = (
        (
            lambda: deployment._require_target_identity(
                connection,  # type: ignore[arg-type]
                expected_database_name=DATABASE_NAME,
                expected_login_role="roa_runtime",
            ),
            deployment.DeploymentSeedTargetError,
        ),
        (
            lambda: deployment._pin_public_search_path(  # type: ignore[arg-type]
                connection
            ),
            deployment.DeploymentSeedTargetError,
        ),
        (
            lambda: deployment._acquire_seed_lock(connection),  # type: ignore[arg-type]
            deployment.DeploymentSeedExecutionError,
        ),
    )

    for check, expected_error in checks:
        with pytest.raises(expected_error) as raised:
            check()
        _assert_error_is_detached(raised.value)


@pytest.mark.parametrize(
    ("arguments", "expected_message"),
    (
        (
            [
                "--confirmation",
                "WRONG",
                "--portfolio-reference-end",
                REFERENCE_END.isoformat(),
                "--expected-plan-sha256",
                PLAN_SHA256,
                "--expected-release-sha",
                RELEASE_SHA,
            ],
            deployment.DeploymentSeedConfigurationError.public_message,
        ),
        (
            [
                "--confirmation",
                deployment.DEPLOYMENT_SEED_CONFIRMATION,
                "--portfolio-reference-end",
                "2026-09-23T00:00:00",
                "--expected-plan-sha256",
                PLAN_SHA256,
                "--expected-release-sha",
                RELEASE_SHA,
            ],
            deployment.DeploymentSeedPlanError.public_message,
        ),
        (
            [
                "--confirmation",
                deployment.DEPLOYMENT_SEED_CONFIRMATION,
                "--portfolio-reference-end",
                REFERENCE_END.isoformat(),
                "--expected-plan-sha256",
                "not-a-sha",
                "--expected-release-sha",
                RELEASE_SHA,
            ],
            deployment.DeploymentSeedConfigurationError.public_message,
        ),
    ),
)
def test_main_rejects_operator_input_before_loading_settings(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    arguments: list[str],
    expected_message: str,
) -> None:
    """Fail closed on invalid operator input before reading deployment settings."""

    def unexpected_settings() -> None:
        raise AssertionError("settings must not be loaded")

    monkeypatch.setattr(deployment, "DeploymentSeedSettings", unexpected_settings)

    assert deployment.main(arguments) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.strip() == expected_message


def test_main_redacts_unknown_argument_and_its_secret_like_value(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Do not let argparse echo an accidental connection secret."""
    accidental_secret = "postgresql://user:do-not-render@example.invalid/database"

    assert (
        deployment.main(
            [
                "--unapproved-database-url",
                accidental_secret,
            ]
        )
        == 1
    )

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.strip() == (
        deployment.DeploymentSeedConfigurationError.public_message
    )
    assert accidental_secret not in captured.err


def test_main_requires_release_identity_and_prints_only_safe_counts(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Bind the operator release SHA and expose only non-sensitive counts."""
    settings = _settings()
    mismatched_settings = _settings(release_sha="a" * 40)
    calls: list[tuple[datetime, str]] = []
    monkeypatch.setattr(deployment, "DeploymentSeedSettings", lambda: settings)

    def fake_run(
        supplied_settings: deployment.DeploymentSeedSettings,
        *,
        reference_end: datetime,
        expected_plan_sha256: str,
    ) -> PortfolioSeedResult:
        assert supplied_settings is settings
        calls.append((reference_end, expected_plan_sha256))
        return _result()

    monkeypatch.setattr(deployment, "run_deployment_seed", fake_run)

    arguments = [
        "--confirmation",
        deployment.DEPLOYMENT_SEED_CONFIRMATION,
        "--portfolio-reference-end",
        REFERENCE_END.isoformat(),
        "--expected-plan-sha256",
        PLAN_SHA256,
        "--expected-release-sha",
        RELEASE_SHA,
    ]
    assert deployment.main(arguments) == 0

    captured = capsys.readouterr()
    assert calls == [(REFERENCE_END, PLAN_SHA256)]
    assert captured.err == ""
    assert captured.out.strip() == (
        "Deployment demo seed completed: 500 orders and 484 payments inserted."
    )
    assert DATABASE_SECRET not in captured.out
    assert NEON_HOST not in captured.out

    monkeypatch.setattr(
        deployment, "DeploymentSeedSettings", lambda: mismatched_settings
    )
    assert deployment.main(arguments) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.strip() == (
        deployment.DeploymentSeedConfigurationError.public_message
    )


def test_main_redacts_expected_and_unexpected_failures(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Never render a DSN or raw third-party failure at the CLI boundary."""
    settings = _settings()
    monkeypatch.setattr(deployment, "DeploymentSeedSettings", lambda: settings)
    arguments = [
        "--confirmation",
        deployment.DEPLOYMENT_SEED_CONFIRMATION,
        "--portfolio-reference-end",
        REFERENCE_END.isoformat(),
        "--expected-plan-sha256",
        PLAN_SHA256,
        "--expected-release-sha",
        RELEASE_SHA,
    ]

    monkeypatch.setattr(
        deployment,
        "run_deployment_seed",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            deployment.DeploymentSeedTargetError()
        ),
    )
    assert deployment.main(arguments) == 1
    captured = capsys.readouterr()
    assert captured.err.strip() == deployment.DeploymentSeedTargetError.public_message

    monkeypatch.setattr(
        deployment,
        "run_deployment_seed",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            RuntimeError(f"connection failed: {NEON_URL}")
        ),
    )
    assert deployment.main(arguments) == 1
    captured = capsys.readouterr()
    assert (
        captured.err.strip() == deployment.DeploymentSeedExecutionError.public_message
    )
    assert DATABASE_SECRET not in captured.err
    assert NEON_HOST not in captured.err
