"""Unit tests for seed data, safety, transaction boundaries, and CLI behavior."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy.engine import URL
from sqlalchemy.exc import SQLAlchemyError

import app.seed.__main__ as seed_cli
import app.seed.runner as seed_runner
from app.seed.data import CATEGORY_SEEDS, MENU_ITEM_SEEDS
from app.seed.runner import SeedConflictError, SeedResult, seed_menu_data
from app.seed.safety import SeedSafetyError, validate_local_seed_database_url

APPROVED_DATABASE = "restaurant_ordering_analytics_dev"
SAFE_PASSWORD = "unit-test-password"
ALLERGEN_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")


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


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost"])
def test_local_seed_database_url_accepts_approved_hosts(host: str) -> None:
    """Accept both exact local host representations without connecting."""
    parsed = validate_local_seed_database_url(_database_url(host=host))
    assert parsed.host == host
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
import app.seed.runner
import app.seed.safety
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
    assert engine_options == {"pool_pre_ping": True}
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
