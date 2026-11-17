from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
AUDIT_HELPER = REPOSITORY_ROOT / ".github" / "scripts" / "browser-e2e-log-audit.sh"
ADMIN_DEMO_PHASE = "ADMIN_DEMO_CUSTOMER_DISABLED"
SYNTHETIC_PROTECTED_VALUE = "synthetic-protected-value"


def _bash_executable() -> str:
    if os.name == "nt":
        git_bash = Path("C:/Program Files/Git/bin/bash.exe")
        if git_bash.is_file():
            return str(git_bash)
    bash = shutil.which("bash")
    if bash is None:
        raise RuntimeError("Bash is required for the Browser E2E log-audit tests")
    return bash


def _run_audit(
    log_file: Path,
    *,
    phase: str = ADMIN_DEMO_PHASE,
    protected_values: tuple[str, ...] = (SYNTHETIC_PROTECTED_VALUE,),
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            _bash_executable(),
            "-c",
            'source "$1"; shift; browser_e2e_audit_log_file "$@"',
            "browser-e2e-log-audit-test",
            AUDIT_HELPER.as_posix(),
            phase,
            log_file.resolve().as_posix(),
            *protected_values,
        ],
        capture_output=True,
        check=False,
        encoding="utf-8",
    )


@pytest.mark.parametrize(
    ("rule", "synthetic_log", "legacy_marker", "protected_values"),
    [
        (
            "PROTECTED_VALUE",
            SYNTHETIC_PROTECTED_VALUE,
            "E2E_LOG_VALUE_LEAK_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
        (
            "POSTGRESQL_URL",
            "database=postgresql+psycopg://example.invalid/synthetic",
            "E2E_LOG_SECURITY_PATTERN_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
        (
            "BEARER_CREDENTIAL",
            "Authorization: Bearer synthetic-credential",
            "E2E_LOG_SECURITY_PATTERN_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
        (
            "JWT_COMPACT",
            "token=eyJsynthetic.payload.signature",
            "E2E_LOG_SECURITY_PATTERN_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
        (
            "STRIPE_WEBHOOK_SECRET_PREFIX",
            "webhook=whsec_synthetic",
            "E2E_LOG_SECURITY_PATTERN_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
        (
            "STRIPE_SECRET_KEY_PREFIX",
            "key=sk_test_synthetic",
            "E2E_LOG_SECURITY_PATTERN_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
        (
            "STRIPE_SIGNATURE",
            "Stripe-Signature: synthetic",
            "E2E_LOG_SECURITY_PATTERN_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
        (
            "ORDER_ACCESS_HEADER",
            "X-Order-Access-Token: synthetic",
            "E2E_LOG_SECURITY_PATTERN_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
        (
            "ORDER_ACCESS_TOKEN_OR_CAPABILITY_TEXT",
            "order access capability was supplied",
            "E2E_LOG_SECURITY_PATTERN_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
        (
            "STRIPE_URL",
            "upstream=https://api.stripe.com/v1/synthetic",
            "E2E_LOG_SECURITY_PATTERN_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
        (
            "TRACEBACK",
            "Traceback (most recent call last):",
            "E2E_LOG_SECURITY_PATTERN_DETECTED",
            (SYNTHETIC_PROTECTED_VALUE,),
        ),
    ],
)
def test_reports_only_closed_rule_and_phase_identifiers(
    tmp_path: Path,
    rule: str,
    synthetic_log: str,
    legacy_marker: str,
    protected_values: tuple[str, ...],
) -> None:
    log_file = tmp_path / "compose.log"
    log_file.write_text(synthetic_log, encoding="utf-8")

    result = _run_audit(log_file, protected_values=protected_values)

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr.splitlines() == [
        f"E2E_LOG_AUDIT_MATCH phase={ADMIN_DEMO_PHASE} rule={rule}",
        legacy_marker,
    ]
    assert synthetic_log not in result.stderr


@pytest.mark.parametrize(
    ("service_prefix", "request_target", "status", "service", "route"),
    [
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/api/v1/admin/analytics/overview?start=synthetic&end=synthetic",
            500,
            "BACKEND",
            "ADMIN_ANALYTICS",
        ),
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/api/v1/admin/orders?limit=50&offset=0",
            503,
            "BACKEND",
            "ADMIN_ORDERS",
        ),
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/api/v1/admin/menu/items",
            503,
            "BACKEND",
            "ADMIN_MENU",
        ),
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/api/v1/admin/exports/orders.csv?start=synthetic&end=synthetic",
            503,
            "BACKEND",
            "ADMIN_EXPORTS",
        ),
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/api/v1/admin/exchange-rates?credential=synthetic-private-material",
            503,
            "BACKEND",
            "EXCHANGE_RATES",
        ),
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/api/v1/auth/demo-session",
            599,
            "BACKEND",
            "AUTH",
        ),
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/ready",
            503,
            "BACKEND",
            "READINESS",
        ),
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/api/v1/menu",
            503,
            "BACKEND",
            "PUBLIC_MENU",
        ),
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/api/v1/orders/quote",
            503,
            "BACKEND",
            "ORDER_QUOTE",
        ),
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/api/v1/orders/ROA-SYNTHETIC/checkout-session",
            503,
            "BACKEND",
            "CHECKOUT",
        ),
        (
            "roa-stage18-e2e-synthetic-backend-1",
            "/api/v1/orders/ROA-SYNTHETIC",
            503,
            "BACKEND",
            "ORDERS",
        ),
        (
            "roa-stage18-e2e-synthetic-frontend-1",
            "/assets/index-synthetic.js",
            503,
            "FRONTEND",
            "STATIC_ASSET",
        ),
        (
            "roa-stage18-e2e-synthetic-postgres-1",
            "/synthetic-database-probe",
            503,
            "POSTGRESQL",
            "UNKNOWN_ROUTE",
        ),
        (
            "roa-stage18-e2e-synthetic-migrate-1",
            "/synthetic-migration-probe",
            503,
            "MIGRATIONS",
            "UNKNOWN_ROUTE",
        ),
        (
            "roa-stage18-e2e-synthetic-worker-1",
            "/api/v1/private/synthetic?token=synthetic-private-material",
            503,
            "UNKNOWN_SERVICE",
            "UNKNOWN_ROUTE",
        ),
    ],
)
def test_http_5xx_reports_only_closed_service_and_route_identifiers(
    tmp_path: Path,
    service_prefix: str,
    request_target: str,
    status: int,
    service: str,
    route: str,
) -> None:
    log_file = tmp_path / "compose.log"
    synthetic_log = (
        f'{service_prefix} | INFO: synthetic - "GET {request_target} HTTP/1.1" '
        f"{status} synthetic\n"
    )
    log_file.write_text(synthetic_log, encoding="utf-8")

    result = _run_audit(log_file)

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr.splitlines() == [
        "E2E_LOG_AUDIT_MATCH "
        f"phase={ADMIN_DEMO_PHASE} rule=HTTP_5XX service={service} route={route}",
        "E2E_LOG_SECURITY_PATTERN_DETECTED",
    ]
    assert request_target not in result.stderr
    assert "synthetic-private-material" not in result.stderr


def test_http_5xx_without_a_compose_service_prefix_is_unknown(tmp_path: Path) -> None:
    log_file = tmp_path / "compose.log"
    log_file.write_text(
        'INFO: backend-looking-path - "GET /backend/ready HTTP/1.1" 503 synthetic\n',
        encoding="utf-8",
    )

    result = _run_audit(log_file)

    assert result.returncode == 1
    assert result.stderr.splitlines() == [
        "E2E_LOG_AUDIT_MATCH "
        f"phase={ADMIN_DEMO_PHASE} rule=HTTP_5XX "
        "service=UNKNOWN_SERVICE route=UNKNOWN_ROUTE",
        "E2E_LOG_SECURITY_PATTERN_DETECTED",
    ]


def test_http_5xx_reports_the_first_match_without_echoing_later_lines(
    tmp_path: Path,
) -> None:
    log_file = tmp_path / "compose.log"
    log_file.write_text(
        "\n".join(
            [
                'synthetic-backend-1 | "GET /api/v1/admin/orders HTTP/1.1" 503 first',
                'synthetic-frontend-1 | "GET /assets/private.js HTTP/1.1" 500 second',
            ]
        ),
        encoding="utf-8",
    )

    result = _run_audit(log_file)

    assert result.returncode == 1
    assert result.stderr.splitlines() == [
        "E2E_LOG_AUDIT_MATCH "
        f"phase={ADMIN_DEMO_PHASE} rule=HTTP_5XX "
        "service=BACKEND route=ADMIN_ORDERS",
        "E2E_LOG_SECURITY_PATTERN_DETECTED",
    ]
    assert "private.js" not in result.stderr


@pytest.mark.parametrize(
    "phase",
    [
        "NORMAL_RUNTIME",
        "ADMIN_DEMO_CUSTOMER_DISABLED",
        "CUSTOMER_DEMO_ENABLED_FINAL",
    ],
)
def test_reports_each_allowlisted_phase_without_log_content(
    tmp_path: Path,
    phase: str,
) -> None:
    log_file = tmp_path / "compose.log"
    log_file.write_text("Traceback from a synthetic fixture", encoding="utf-8")

    result = _run_audit(log_file, phase=phase)

    assert result.returncode == 1
    assert result.stderr.splitlines() == [
        f"E2E_LOG_AUDIT_MATCH phase={phase} rule=TRACEBACK",
        "E2E_LOG_SECURITY_PATTERN_DETECTED",
    ]
    assert "synthetic fixture" not in result.stderr


def test_accepts_a_safe_log(tmp_path: Path) -> None:
    log_file = tmp_path / "compose.log"
    log_file.write_text(
        'frontend | "GET /healthz HTTP/1.1" 200 3\n',
        encoding="utf-8",
    )

    result = _run_audit(log_file)

    assert result.returncode == 0
    assert result.stdout == ""
    assert result.stderr == ""


def test_accepts_a_non_5xx_http_response(tmp_path: Path) -> None:
    log_file = tmp_path / "compose.log"
    log_file.write_text(
        'backend | "POST /api/v1/auth/customer-demo-session HTTP/1.1" 404 0\n',
        encoding="utf-8",
    )

    result = _run_audit(log_file)

    assert result.returncode == 0
    assert result.stdout == ""
    assert result.stderr == ""


def test_rejects_multiple_matches_with_the_first_closed_rule(tmp_path: Path) -> None:
    log_file = tmp_path / "compose.log"
    log_file.write_text(
        "Traceback\npostgresql://example.invalid/synthetic\n",
        encoding="utf-8",
    )

    result = _run_audit(log_file)

    assert result.returncode == 1
    assert result.stderr.splitlines() == [
        f"E2E_LOG_AUDIT_MATCH phase={ADMIN_DEMO_PHASE} rule=POSTGRESQL_URL",
        "E2E_LOG_SECURITY_PATTERN_DETECTED",
    ]


def test_rejects_an_unknown_phase_without_echoing_it(tmp_path: Path) -> None:
    log_file = tmp_path / "compose.log"
    log_file.write_text("safe synthetic line", encoding="utf-8")

    result = _run_audit(log_file, phase="untrusted-phase-value")

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == "E2E_LOG_AUDIT_SCAN_FAILED phase=UNKNOWN rule=PHASE\n"
    assert "untrusted-phase-value" not in result.stderr


def test_rejects_a_missing_log_file_with_a_closed_error(tmp_path: Path) -> None:
    result = _run_audit(tmp_path / "missing.log")

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == (
        f"E2E_LOG_AUDIT_SCAN_FAILED phase={ADMIN_DEMO_PHASE} rule=INPUT\n"
    )


def test_rejects_an_empty_protected_value_without_scanning(tmp_path: Path) -> None:
    log_file = tmp_path / "compose.log"
    log_file.write_text("safe synthetic line", encoding="utf-8")

    result = _run_audit(log_file, protected_values=("",))

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == (
        "E2E_LOG_AUDIT_SCAN_FAILED "
        f"phase={ADMIN_DEMO_PHASE} rule=PROTECTED_VALUE_INPUT\n"
    )
