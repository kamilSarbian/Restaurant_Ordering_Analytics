"""Test the offline free-tier deployment repository contract."""

from __future__ import annotations

import copy
import importlib.util
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
HELPER_PATH = REPOSITORY_ROOT / ".github" / "scripts" / "free_tier_contract.py"

SPEC = importlib.util.spec_from_file_location("free_tier_contract", HELPER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Free-tier helper could not be imported")
free_tier_contract = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = free_tier_contract
SPEC.loader.exec_module(free_tier_contract)

VALID_SHA = "a" * 40
SENSITIVE_MARKER = "postgresql://user:sensitive-marker@example.invalid/database"
RUNTIME_SECRET_EXPRESSION = "$" + "{{ secrets.RUNTIME_URL }}"
MIGRATION_SECRET_EXPRESSION = "$" + "{{ secrets.NEON_MIGRATION_DATABASE_URL }}"


def _load_yaml(path: Path) -> dict[str, Any]:
    document = yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    assert isinstance(document, dict)
    return document


def _render_config() -> dict[str, Any]:
    document = yaml.safe_load(
        (REPOSITORY_ROOT / "render.yaml").read_text(encoding="utf-8")
    )
    assert isinstance(document, dict)
    return document


def _migration_workflow() -> dict[str, Any]:
    return _load_yaml(REPOSITORY_ROOT / ".github" / "workflows" / "migrate-neon.yml")


def _ci_workflow() -> dict[str, Any]:
    return _load_yaml(REPOSITORY_ROOT / ".github" / "workflows" / "ci.yml")


def _mapping(value: object) -> dict[str, Any]:
    assert isinstance(value, dict)
    return value


def _list(value: object) -> list[Any]:
    assert isinstance(value, list)
    return value


def _services(config: Mapping[str, object]) -> list[dict[str, Any]]:
    return [_mapping(service) for service in _list(config["services"])]


def _service(config: Mapping[str, object], runtime: str) -> dict[str, Any]:
    return next(
        service for service in _services(config) if service["runtime"] == runtime
    )


def _environment(service: Mapping[str, object]) -> dict[str, dict[str, Any]]:
    return {
        str(entry["key"]): entry
        for entry in (_mapping(item) for item in _list(service["envVars"]))
    }


def _migration_job(workflow: Mapping[str, object]) -> dict[str, Any]:
    return _mapping(_mapping(workflow["jobs"])["migrate"])


def _steps(workflow: Mapping[str, object]) -> list[dict[str, Any]]:
    return [_mapping(step) for step in _list(_migration_job(workflow)["steps"])]


def _successful_check_payloads() -> dict[str, object]:
    return {
        name: {
            "total_count": 1,
            "check_runs": [
                {
                    "name": name,
                    "head_sha": VALID_SHA,
                    "status": "completed",
                    "conclusion": "success",
                    "app": {"slug": "github-actions"},
                }
            ],
        }
        for name in free_tier_contract.REQUIRED_CHECK_NAMES
    }


def test_checked_in_repository_contract_passes() -> None:
    """Accept the complete checked-in free-tier repository contract."""
    free_tier_contract.validate_repository_contract(
        _render_config(),
        _migration_workflow(),
        _ci_workflow(),
    )


@pytest.mark.parametrize(
    "mutation",
    [
        "database",
        "extra_service",
        "cron",
        "private_service",
        "image_runtime",
        "ghcr",
        "paid_plan",
        "nonfree_plan",
        "ready_health",
        "auto_deploy",
        "backend_predeploy",
        "frontend_predeploy",
        "static_docker",
    ],
)
def test_blueprint_rejects_paid_or_non_free_tier_boundaries(mutation: str) -> None:
    """Reject every paid, image-based, private, cron, or auto-deploy drift."""
    config = _render_config()
    backend = _service(config, "docker")
    frontend = _service(config, "static")
    if mutation == "database":
        config["databases"] = [{"name": "paid-database"}]
    elif mutation == "extra_service":
        _list(config["services"]).append(copy.deepcopy(backend))
    elif mutation == "cron":
        backend["type"] = "cron"
    elif mutation == "private_service":
        backend["type"] = "pserv"
    elif mutation == "image_runtime":
        backend["runtime"] = "image"
    elif mutation == "ghcr":
        backend["image"] = {"url": "ghcr.io/example/image:latest"}
    elif mutation == "paid_plan":
        backend["plan"] = "starter"
    elif mutation == "nonfree_plan":
        backend["plan"] = "free-tier"
    elif mutation == "ready_health":
        backend["healthCheckPath"] = "/ready"
    elif mutation == "auto_deploy":
        backend["autoDeployTrigger"] = "commit"
    elif mutation == "backend_predeploy":
        backend["preDeployCommand"] = "python -m alembic upgrade head"
    elif mutation == "frontend_predeploy":
        frontend["preDeployCommand"] = "python -m alembic upgrade head"
    elif mutation == "static_docker":
        frontend["runtime"] = "docker"
    else:
        raise AssertionError(f"Unhandled mutation: {mutation}")

    with pytest.raises(free_tier_contract.FreeTierContractError):
        free_tier_contract.validate_repository_contract(
            config,
            _migration_workflow(),
            _ci_workflow(),
        )


@pytest.mark.parametrize(
    "mutation",
    [
        "missing_spa",
        "api_rewrite",
        "missing_dynamic_api",
        "hardcoded_api",
        "missing_public_app",
        "missing_public_api",
        "missing_release_sha",
        "missing_timeout",
        "e2e_mode",
        "stripe_variable",
        "plaintext_database",
        "plaintext_jwt",
        "wildcard_csp",
        "broad_csp",
        "global_cache_no_store",
        "global_cache_other",
        "missing_asset_cache",
        "weak_cache",
        "missing_index_cache",
        "wrong_index_cache",
        "duplicate_asset_cache",
        "overlapping_asset_cache",
    ],
)
def test_blueprint_rejects_frontend_wiring_secret_and_header_drift(
    mutation: str,
) -> None:
    """Reject unsafe routes, origins, secrets, modes, caching, and CSP values."""
    config = _render_config()
    backend = _service(config, "docker")
    frontend = _service(config, "static")
    backend_environment = _environment(backend)
    frontend_environment = _environment(frontend)
    if mutation == "missing_spa":
        frontend["routes"] = []
    elif mutation == "api_rewrite":
        _list(frontend["routes"]).append(
            {"type": "rewrite", "source": "/api/*", "destination": "https://api"}
        )
    elif mutation == "missing_dynamic_api":
        frontend_environment["VITE_API_BASE_URL"].pop("fromService")
    elif mutation == "hardcoded_api":
        frontend_environment["VITE_API_BASE_URL"].pop("fromService")
        frontend_environment["VITE_API_BASE_URL"][
            "value"
        ] = "https://guessed.onrender.com"
    elif mutation == "missing_public_app":
        backend_environment["PUBLIC_APP_ORIGIN"].pop("fromService")
    elif mutation == "missing_public_api":
        backend_environment["PUBLIC_API_ORIGIN"].pop("fromService")
    elif mutation == "missing_release_sha":
        backend_environment["RELEASE_SHA"].pop("fromService")
    elif mutation == "missing_timeout":
        _list(frontend["envVars"]).remove(frontend_environment["VITE_API_TIMEOUT_MS"])
    elif mutation == "e2e_mode":
        _list(frontend["envVars"]).append({"key": "VITE_BUILD_MODE", "value": "e2e"})
    elif mutation == "stripe_variable":
        _list(backend["envVars"]).append({"key": "STRIPE_SECRET_KEY", "sync": "false"})
    elif mutation == "plaintext_database":
        backend_environment["DATABASE_URL"].pop("sync")
        backend_environment["DATABASE_URL"]["value"] = SENSITIVE_MARKER
    elif mutation == "plaintext_jwt":
        backend_environment["AUTH_JWT_SECRET"].pop("generateValue")
        backend_environment["AUTH_JWT_SECRET"]["value"] = "synthetic-secret"
    elif mutation in {"wildcard_csp", "broad_csp"}:
        _list(frontend["headers"]).append(
            {
                "path": "/*",
                "name": "Content-Security-Policy",
                "value": (
                    "default-src *"
                    if mutation == "wildcard_csp"
                    else "connect-src https:"
                ),
            }
        )
    elif mutation in {"global_cache_no_store", "global_cache_other"}:
        _list(frontend["headers"]).append(
            {
                "path": "/*",
                "name": "Cache-Control",
                "value": (
                    "no-store"
                    if mutation == "global_cache_no_store"
                    else "public, max-age=60"
                ),
            }
        )
    elif mutation == "missing_asset_cache":
        headers = _list(frontend["headers"])
        headers.remove(
            next(
                header
                for header in (_mapping(item) for item in headers)
                if header["name"] == "Cache-Control" and header["path"] == "/assets/*"
            )
        )
    elif mutation == "weak_cache":
        cache_header = next(
            header
            for header in (_mapping(item) for item in _list(frontend["headers"]))
            if header["name"] == "Cache-Control" and header["path"] == "/assets/*"
        )
        cache_header["value"] = "public, max-age=60"
    elif mutation == "missing_index_cache":
        headers = _list(frontend["headers"])
        headers.remove(
            next(
                header
                for header in (_mapping(item) for item in headers)
                if header["name"] == "Cache-Control" and header["path"] == "/index.html"
            )
        )
    elif mutation == "wrong_index_cache":
        cache_header = next(
            header
            for header in (_mapping(item) for item in _list(frontend["headers"]))
            if header["name"] == "Cache-Control" and header["path"] == "/index.html"
        )
        cache_header["value"] = "public, max-age=60"
    elif mutation == "duplicate_asset_cache":
        _list(frontend["headers"]).append(
            {
                "path": "/assets/*",
                "name": "Cache-Control",
                "value": "no-store",
            }
        )
    elif mutation == "overlapping_asset_cache":
        _list(frontend["headers"]).append(
            {
                "path": "/assets/*.js",
                "name": "Cache-Control",
                "value": "no-store",
            }
        )
    else:
        raise AssertionError(f"Unhandled mutation: {mutation}")

    with pytest.raises(free_tier_contract.FreeTierContractError):
        free_tier_contract.validate_repository_contract(
            config,
            _migration_workflow(),
            _ci_workflow(),
        )


@pytest.mark.parametrize(
    "mutation",
    [
        "push_trigger",
        "schedule_trigger",
        "wrong_confirmation",
        "confirmation_default",
        "missing_sha_validation",
        "wrong_environment",
        "broad_permissions",
        "packages_write",
        "job_packages_write",
        "job_deployments_write",
        "job_write_all",
        "top_level_environment",
        "cancel_in_progress",
        "unpinned_action",
        "extra_step",
        "continue_on_error",
        "migration_if_always",
        "confirmation_bypass",
        "main_sha_bypass",
        "missing_final_reconfirmation",
        "only_early_main_check",
        "migration_before_final_recheck",
        "wrong_final_sha_comparison",
        "nonfatal_final_mismatch",
        "work_between_final_check_and_runner",
        "branch_only_final_check",
        "noop_guard_failures",
        "missing_check",
        "render_api",
        "ghcr",
        "seed",
        "deploy",
        "runtime_database",
        "secret_at_job_scope",
        "wrong_login_role",
        "wrong_owner_role",
    ],
)
def test_migration_workflow_rejects_trigger_permission_and_command_drift(
    mutation: str,
) -> None:
    """Reject any path around the manual, checked, direct migration boundary."""
    workflow = _migration_workflow()
    triggers = _mapping(workflow["on"])
    job = _migration_job(workflow)
    steps = _steps(workflow)
    scripts = [step for step in steps if isinstance(step.get("run"), str)]
    migration_step = next(
        step for step in scripts if step.get("name") == "Run the exact Neon migration"
    )
    migration_run = str(migration_step["run"])
    final_comparison = (
        'if [[ "${remote_main_sha}" != "${MIGRATION_SHA}" ]]; then\n'
        '  echo "Migration SHA is not the current remote main SHA." >&2\n'
        "  exit 1\n"
        "fi\n"
    )
    if mutation == "push_trigger":
        triggers["push"] = {"branches": ["main"]}
    elif mutation == "schedule_trigger":
        triggers["schedule"] = [{"cron": "0 0 * * *"}]
    elif mutation == "wrong_confirmation":
        scripts[0]["run"] = str(scripts[0]["run"]).replace(
            "MIGRATE_NEON_PRODUCTION", "MIGRATE"
        )
    elif mutation == "confirmation_default":
        _mapping(_mapping(triggers["workflow_dispatch"])["inputs"])["confirmation"][
            "default"
        ] = "MIGRATE_NEON_PRODUCTION"
    elif mutation == "missing_sha_validation":
        scripts[0]["run"] = str(scripts[0]["run"]).replace("^[0-9a-f]{40}$", "nonempty")
    elif mutation == "wrong_environment":
        job["environment"] = "development"
    elif mutation == "broad_permissions":
        workflow["permissions"] = "write-all"
    elif mutation == "packages_write":
        _mapping(workflow["permissions"])["packages"] = "write"
    elif mutation == "job_packages_write":
        job["permissions"] = {"packages": "write"}
    elif mutation == "job_deployments_write":
        job["permissions"] = {"deployments": "write"}
    elif mutation == "job_write_all":
        job["permissions"] = "write-all"
    elif mutation == "top_level_environment":
        workflow["env"] = {"NEON_URL": "${{ secrets['NEON_MIGRATION_DATABASE_URL'] }}"}
    elif mutation == "cancel_in_progress":
        _mapping(workflow["concurrency"])["cancel-in-progress"] = "true"
    elif mutation == "unpinned_action":
        next(step for step in steps if "uses" in step)["uses"] = "actions/checkout@main"
    elif mutation == "extra_step":
        _list(job["steps"]).append(
            {"name": "Unexpected command", "run": "echo unexpected"}
        )
    elif mutation == "continue_on_error":
        scripts[-2]["continue-on-error"] = "true"
    elif mutation == "migration_if_always":
        migration_step["if"] = "always()"
    elif mutation == "confirmation_bypass":
        scripts[0]["run"] = str(scripts[0]["run"]).replace(
            'if [[ "${CONFIRMATION}" != "MIGRATE_NEON_PRODUCTION" ]]; then',
            "if false; then",
        )
    elif mutation == "main_sha_bypass":
        scripts[0]["run"] = str(scripts[0]["run"]).replace(
            'if [[ "${remote_main_sha}" != "${MIGRATION_SHA}" ]]; then',
            "if false; then",
        )
    elif mutation == "missing_final_reconfirmation":
        migration_step["run"] = migration_run.replace(final_comparison, "")
    elif mutation == "only_early_main_check":
        migration_step["run"] = "exec python -m app.database.migration_runner"
    elif mutation == "migration_before_final_recheck":
        migration_step["run"] = (
            "exec python -m app.database.migration_runner\n" + migration_run
        )
    elif mutation == "wrong_final_sha_comparison":
        migration_step["run"] = migration_run.replace(
            'if [[ "${remote_main_sha}" != "${MIGRATION_SHA}" ]]; then',
            f'if [[ "${{remote_main_sha}}" != "{VALID_SHA}" ]]; then',
        )
    elif mutation == "nonfatal_final_mismatch":
        migration_step["run"] = migration_run.replace(
            final_comparison,
            final_comparison.replace("  exit 1\n", "  :\n"),
        )
    elif mutation == "work_between_final_check_and_runner":
        migration_step["run"] = migration_run.replace(
            "fi\nexec python -m app.database.migration_runner",
            "fi\nsleep 1\nexec python -m app.database.migration_runner",
        )
    elif mutation == "branch_only_final_check":
        migration_step["run"] = migration_run.replace(
            'if [[ "${remote_main_sha}" != "${MIGRATION_SHA}" ]]; then',
            'if [[ "${GITHUB_REF}" != "refs/heads/main" ]]; then',
        )
    elif mutation == "noop_guard_failures":
        scripts[0]["run"] = str(scripts[0]["run"]).replace("exit 1", ":")
    elif mutation == "missing_check":
        check_step = next(step for step in scripts if "required_checks=" in step["run"])
        check_step["run"] = str(check_step["run"]).replace(' "Browser E2E"', "")
    elif mutation == "render_api":
        _list(job["steps"]).append(
            {
                "name": "Unsafe Render mutation",
                "run": "curl https://api.render.com/v1/services",
            }
        )
    elif mutation == "ghcr":
        _list(job["steps"]).append(
            {
                "name": "Unsafe registry call",
                "run": "docker pull ghcr.io/example/backend:latest",
            }
        )
    elif mutation == "seed":
        _list(job["steps"]).append(
            {"name": "Unsafe seed", "run": "python -m app.database.seed_data"}
        )
    elif mutation == "deploy":
        _list(job["steps"]).append({"name": "Unsafe deploy", "run": "render deploy"})
    elif mutation == "runtime_database":
        _mapping(migration_step["env"])["DATABASE_URL"] = RUNTIME_SECRET_EXPRESSION
    elif mutation == "secret_at_job_scope":
        job["env"] = {"MIGRATION_DATABASE_URL": MIGRATION_SECRET_EXPRESSION}
    elif mutation == "wrong_login_role":
        _mapping(migration_step["env"])["MIGRATION_EXPECTED_LOGIN_ROLE"] = "postgres"
    elif mutation == "wrong_owner_role":
        _mapping(migration_step["env"])["MIGRATION_OWNER_ROLE"] = "postgres"
    else:
        raise AssertionError(f"Unhandled mutation: {mutation}")

    with pytest.raises(free_tier_contract.FreeTierContractError):
        free_tier_contract.validate_repository_contract(
            _render_config(),
            workflow,
            _ci_workflow(),
        )


def test_migration_request_accepts_only_current_main_and_exact_confirmation() -> None:
    """Bind a manual request to the exact repository, main ref, and remote SHA."""
    free_tier_contract.validate_migration_request(
        repository=free_tier_contract.EXPECTED_GITHUB_REPOSITORY,
        git_ref="refs/heads/main",
        migration_sha=VALID_SHA,
        confirmation=free_tier_contract.EXPECTED_CONFIRMATION,
        remote_main_sha=VALID_SHA,
    )

    invalid_values = (
        {"repository": "attacker/repository"},
        {"git_ref": "refs/heads/feature"},
        {"migration_sha": "A" * 40},
        {"confirmation": "MIGRATE"},
        {"remote_main_sha": "b" * 40},
    )
    defaults = {
        "repository": free_tier_contract.EXPECTED_GITHUB_REPOSITORY,
        "git_ref": "refs/heads/main",
        "migration_sha": VALID_SHA,
        "confirmation": free_tier_contract.EXPECTED_CONFIRMATION,
        "remote_main_sha": VALID_SHA,
    }
    for override in invalid_values:
        with pytest.raises(free_tier_contract.FreeTierContractError):
            free_tier_contract.validate_migration_request(**(defaults | override))


def test_required_checks_accept_one_exact_github_actions_success_per_gate() -> None:
    """Accept only the exact four-check success matrix for the migration SHA."""
    free_tier_contract.validate_required_check_runs(
        _successful_check_payloads(), VALID_SHA
    )


@pytest.mark.parametrize(
    "mutation",
    [
        "missing",
        "extra",
        "wrong_count",
        "boolean_count",
        "wrong_name",
        "wrong_sha",
        "pending",
        "failure",
        "wrong_app",
    ],
)
def test_required_checks_reject_incomplete_or_foreign_evidence(mutation: str) -> None:
    """Reject missing, ambiguous, nonterminal, failed, and foreign check runs."""
    payloads = _successful_check_payloads()
    name = free_tier_contract.REQUIRED_CHECK_NAMES[0]
    payload = _mapping(payloads[name])
    runs = _list(payload["check_runs"])
    run = _mapping(runs[0])
    if mutation == "missing":
        payloads.pop(name)
    elif mutation == "extra":
        runs.append(copy.deepcopy(run))
        payload["total_count"] = 2
    elif mutation == "wrong_count":
        payload["total_count"] = 2
    elif mutation == "boolean_count":
        payload["total_count"] = True
    elif mutation == "wrong_name":
        run["name"] = "Backend CI"
    elif mutation == "wrong_sha":
        run["head_sha"] = "b" * 40
    elif mutation == "pending":
        run["status"] = "in_progress"
    elif mutation == "failure":
        run["conclusion"] = "failure"
    elif mutation == "wrong_app":
        _mapping(run["app"])["slug"] = "third-party"
    else:
        raise AssertionError(f"Unhandled mutation: {mutation}")

    with pytest.raises(free_tier_contract.FreeTierContractError):
        free_tier_contract.validate_required_check_runs(payloads, VALID_SHA)


def test_repository_has_one_exact_alembic_head() -> None:
    """Keep static migration authorization bound to the executable graph head."""
    assert free_tier_contract.find_alembic_heads(
        REPOSITORY_ROOT / "backend" / "alembic" / "versions"
    ) == (free_tier_contract.EXPECTED_ALEMBIC_HEAD,)


def test_contract_errors_never_echo_secret_like_values() -> None:
    """Return one generic failure without rendering malformed secret material."""
    config = _render_config()
    database_entry = _environment(_service(config, "docker"))["DATABASE_URL"]
    database_entry.pop("sync")
    database_entry["value"] = SENSITIVE_MARKER

    with pytest.raises(free_tier_contract.FreeTierContractError) as caught:
        free_tier_contract.validate_repository_contract(
            config,
            _migration_workflow(),
            _ci_workflow(),
        )

    assert SENSITIVE_MARKER not in str(caught.value)
    assert str(caught.value) == "Free-tier repository contract validation failed."


def test_helper_failure_output_never_echoes_secret_like_values(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Keep the command-line failure boundary generic and secret-free."""
    config = _render_config()
    database_entry = _environment(_service(config, "docker"))["DATABASE_URL"]
    database_entry.pop("sync")
    database_entry["value"] = SENSITIVE_MARKER
    render_path = tmp_path / "render.yaml"
    render_path.write_text(yaml.safe_dump(config), encoding="utf-8")
    monkeypatch.setattr(free_tier_contract, "RENDER_PATH", render_path)

    assert free_tier_contract.main() == 1
    captured = capsys.readouterr()
    assert SENSITIVE_MARKER not in captured.out
    assert SENSITIVE_MARKER not in captured.err
    assert captured.err.strip() == "Free-tier repository contract validation failed."


def test_ci_contract_rejects_old_paid_release_references() -> None:
    """Keep CI independent from the deleted Stage 20 release controller."""
    workflow = _ci_workflow()
    migrations = _mapping(_mapping(workflow["jobs"])["migrations"])
    _list(migrations["steps"])[0][
        "run"
    ] = "python .github/scripts/render_release.py && cat .github/workflows/release.yml"

    with pytest.raises(free_tier_contract.FreeTierContractError):
        free_tier_contract.validate_repository_contract(
            _render_config(),
            _migration_workflow(),
            workflow,
        )
