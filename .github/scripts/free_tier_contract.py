"""Validate the repository-only free-tier deployment contract offline."""

from __future__ import annotations

import ast
import hashlib
import json
import re
import sys
from collections.abc import Mapping
from pathlib import Path

import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
EXPECTED_GITHUB_REPOSITORY = "kamilSarbian/Restaurant_Ordering_Analytics"
EXPECTED_REPOSITORY_URL = (
    "https://github.com/kamilSarbian/Restaurant_Ordering_Analytics"
)
EXPECTED_ALEMBIC_HEAD = "0009_add_portfolio_demo_origin_and_payment_provider"
EXPECTED_CONFIRMATION = "MIGRATE_NEON_PRODUCTION"
REQUIRED_CHECK_NAMES = ("Backend", "Migrations", "Frontend", "Browser E2E")
EXPECTED_MIGRATION_STEP_NAMES = (
    "Validate request against remote main",
    "Check out the immutable migration commit",
    "Verify checked-out source and environment boundary",
    "Set up Python",
    "Install hash-locked runtime dependencies",
    "Validate checked-in free-tier repository contract",
    "Download required check-run evidence",
    "Require successful checks for the exact SHA",
    "Run the exact Neon migration",
)
EXPECTED_MIGRATION_RUN_SHA256 = (
    "8e0fb75635b1c67fbd765c81aa47ef9bd2f4919cd41a7996eff600ca91530328",
    "2f8ebb7aabec80bc7959110a447045ae553ddf1559c7051f1f741d1f85a750f3",
    "95eb09655ca43f133decf0fd5ef72b86a60d9ff131c43ab1428c94eb25bacc89",
    "40b66eee5dbbdd21fe10743662afdfb8b12905eb107c9e6ad4c8c46c91c9f285",
    "ccf1465db6942e57ad7cddf1ebc409b469a4669b50ddf3e8d17a7c9343fb6939",
    "fac286fd466c51027ac7a1283fc0b0d9533e52eda0e339417dbc0bcb940a4785",
    "7fffeef272679ee0f2f700a92b23d084e38ddeaba686f8eae21238931eb77fe0",
)

GIT_SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
ALEMBIC_HEAD_PATTERN = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*")
FULL_ACTION_PIN_PATTERN = re.compile(r"[^@\s]+@[0-9a-f]{40}")
SERVICE_NAME_PATTERN = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")

CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
SETUP_PYTHON_ACTION = "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97"

RENDER_PATH = REPOSITORY_ROOT / "render.yaml"
MIGRATION_WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "migrate-neon.yml"
CI_WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "ci.yml"
ALEMBIC_VERSIONS_PATH = REPOSITORY_ROOT / "backend" / "alembic" / "versions"


class FreeTierContractError(Exception):
    """Represent one static-contract failure without exposing input values."""

    def __init__(self) -> None:
        """Create a stable, secret-free validation error."""
        super().__init__("Free-tier repository contract validation failed.")


def load_yaml_mapping(path: Path) -> Mapping[str, object]:
    """Load one YAML document while preserving GitHub's literal ``on`` key."""
    try:
        document = yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    except (OSError, UnicodeError, yaml.YAMLError) as error:
        raise FreeTierContractError from error
    return _mapping(document)


def load_render_mapping(path: Path) -> Mapping[str, object]:
    """Load Render YAML with provider-relevant scalar types preserved."""
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError) as error:
        raise FreeTierContractError from error
    return _mapping(document)


def validate_repository_contract(
    render_config: Mapping[str, object],
    migration_workflow: Mapping[str, object],
    ci_workflow: Mapping[str, object],
    *,
    versions_directory: Path = ALEMBIC_VERSIONS_PATH,
) -> None:
    """Validate the checked-in free-tier Blueprint, workflows, and graph head."""
    _validate_render_blueprint(render_config)
    _validate_migration_workflow(migration_workflow)
    _validate_ci_workflow(ci_workflow)
    if find_alembic_heads(versions_directory) != (EXPECTED_ALEMBIC_HEAD,):
        raise FreeTierContractError


def validate_migration_request(
    *,
    repository: str,
    git_ref: str,
    migration_sha: str,
    confirmation: str,
    remote_main_sha: str,
) -> None:
    """Validate immutable manual-migration inputs without contacting GitHub."""
    if (
        repository != EXPECTED_GITHUB_REPOSITORY
        or git_ref != "refs/heads/main"
        or GIT_SHA_PATTERN.fullmatch(migration_sha) is None
        or confirmation != EXPECTED_CONFIRMATION
        or remote_main_sha != migration_sha
    ):
        raise FreeTierContractError


def validate_required_check_runs(
    payloads: Mapping[str, object],
    migration_sha: str,
) -> None:
    """Require one exact successful GitHub Actions run for every CI gate."""
    if GIT_SHA_PATTERN.fullmatch(migration_sha) is None or set(payloads) != set(
        REQUIRED_CHECK_NAMES
    ):
        raise FreeTierContractError

    for check_name in REQUIRED_CHECK_NAMES:
        payload = _mapping(payloads[check_name])
        check_runs = _list(payload.get("check_runs"))
        total_count = payload.get("total_count")
        if type(total_count) is not int or total_count != 1 or len(check_runs) != 1:
            raise FreeTierContractError
        check_run = _mapping(check_runs[0])
        app = _mapping(check_run.get("app"))
        if (
            check_run.get("name") != check_name
            or check_run.get("head_sha") != migration_sha
            or check_run.get("status") != "completed"
            or check_run.get("conclusion") != "success"
            or app.get("slug") != "github-actions"
        ):
            raise FreeTierContractError


def find_alembic_heads(versions_directory: Path) -> tuple[str, ...]:
    """Read literal revision metadata and return deterministic graph heads."""
    if not versions_directory.is_dir():
        raise FreeTierContractError

    revisions: set[str] = set()
    parents: set[str] = set()
    for migration_path in sorted(versions_directory.glob("*.py")):
        if migration_path.name == "__init__.py":
            continue
        try:
            tree = ast.parse(migration_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, SyntaxError) as error:
            raise FreeTierContractError from error
        metadata = _read_revision_metadata(tree)
        revision = metadata.get("revision")
        down_revision = metadata.get("down_revision")
        if (
            not isinstance(revision, str)
            or ALEMBIC_HEAD_PATTERN.fullmatch(revision) is None
            or revision in revisions
        ):
            raise FreeTierContractError
        revisions.add(revision)
        parents.update(_normalize_down_revisions(down_revision))

    if not revisions or not parents.issubset(revisions):
        raise FreeTierContractError
    return tuple(sorted(revisions - parents))


def main() -> int:
    """Validate the checked-in contract without network access or mutation."""
    try:
        validate_repository_contract(
            load_render_mapping(RENDER_PATH),
            load_yaml_mapping(MIGRATION_WORKFLOW_PATH),
            load_yaml_mapping(CI_WORKFLOW_PATH),
        )
    except FreeTierContractError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("Free-tier repository contract validated.")
    return 0


def _validate_render_blueprint(config: Mapping[str, object]) -> None:
    if set(config) != {"previews", "services"} or _mapping(config.get("previews")) != {
        "generation": "off"
    }:
        raise FreeTierContractError
    services = [_mapping(service) for service in _list(config.get("services"))]
    if len(services) != 2:
        raise FreeTierContractError

    names = [service.get("name") for service in services]
    if (
        any(
            not isinstance(name, str) or SERVICE_NAME_PATTERN.fullmatch(name) is None
            for name in names
        )
        or len(set(names)) != 2
    ):
        raise FreeTierContractError

    docker_services = [
        service for service in services if service.get("runtime") == "docker"
    ]
    static_services = [
        service for service in services if service.get("runtime") == "static"
    ]
    if len(docker_services) != 1 or len(static_services) != 1:
        raise FreeTierContractError
    backend = docker_services[0]
    frontend = static_services[0]

    forbidden_keys = {"disk", "image", "numInstances", "schedule", "dockerCommand"}
    if any(forbidden_keys.intersection(service) for service in services):
        raise FreeTierContractError

    _validate_backend_service(backend, str(frontend["name"]))
    _validate_frontend_service(frontend, str(backend["name"]))

    serialized = json.dumps(config, sort_keys=True).lower()
    forbidden_fragments = (
        "ghcr.io",
        "stage20-bootstrap",
        '"type": "pserv"',
        '"type": "cron"',
        '"runtime": "image"',
        "render_api_key",
    )
    if any(fragment in serialized for fragment in forbidden_fragments):
        raise FreeTierContractError


def _validate_backend_service(
    service: Mapping[str, object], frontend_name: str
) -> None:
    expected = {
        "type": "web",
        "runtime": "docker",
        "repo": EXPECTED_REPOSITORY_URL,
        "branch": "main",
        "region": "frankfurt",
        "plan": "free",
        "dockerfilePath": "./backend/Dockerfile",
        "dockerContext": "./backend",
        "autoDeployTrigger": "off",
        "healthCheckPath": "/health",
    }
    if any(service.get(key) != value for key, value in expected.items()):
        raise FreeTierContractError
    if set(service) != set(expected) | {"name", "envVars"}:
        raise FreeTierContractError

    entries = _environment_entries(service)
    literal_values = {
        "APP_ENVIRONMENT": "production",
        "APP_DEBUG": "false",
        "PORTFOLIO_DEMO_MODE": "true",
        "PAYMENT_PROVIDER": "demo",
        "TRUSTED_PROXY_MODE": "direct",
        "AUTH_ACCESS_TOKEN_EXPIRE_MINUTES": "30",
        "EXPECTED_ALEMBIC_HEAD": EXPECTED_ALEMBIC_HEAD,
        "LOG_LEVEL": "INFO",
    }
    expected_keys = set(literal_values) | {
        "DATABASE_URL",
        "AUTH_JWT_SECRET",
        "PUBLIC_APP_ORIGIN",
        "PUBLIC_API_ORIGIN",
        "RELEASE_SHA",
    }
    if set(entries) != expected_keys:
        raise FreeTierContractError
    for key, value in literal_values.items():
        if entries[key] != {"key": key, "value": value}:
            raise FreeTierContractError
    if entries["DATABASE_URL"] != {"key": "DATABASE_URL", "sync": False}:
        raise FreeTierContractError
    if entries["AUTH_JWT_SECRET"] != {
        "key": "AUTH_JWT_SECRET",
        "generateValue": True,
    }:
        raise FreeTierContractError
    _require_service_environment_reference(
        entries["PUBLIC_APP_ORIGIN"], frontend_name, "RENDER_EXTERNAL_URL"
    )
    backend_name = str(service["name"])
    _require_service_environment_reference(
        entries["PUBLIC_API_ORIGIN"], backend_name, "RENDER_EXTERNAL_URL"
    )
    _require_service_environment_reference(
        entries["RELEASE_SHA"], backend_name, "RENDER_GIT_COMMIT"
    )
    if any(key.startswith("STRIPE_") for key in entries):
        raise FreeTierContractError


def _validate_frontend_service(
    service: Mapping[str, object], backend_name: str
) -> None:
    expected = {
        "type": "web",
        "runtime": "static",
        "repo": EXPECTED_REPOSITORY_URL,
        "branch": "main",
        "rootDir": "frontend",
        "buildCommand": "npm ci --ignore-scripts --no-audit --no-fund && npm run build",
        "staticPublishPath": "./dist",
        "autoDeployTrigger": "off",
    }
    if any(service.get(key) != value for key, value in expected.items()):
        raise FreeTierContractError
    if set(service) != set(expected) | {"name", "envVars", "routes", "headers"}:
        raise FreeTierContractError

    entries = _environment_entries(service)
    if set(entries) != {"VITE_API_BASE_URL", "VITE_API_TIMEOUT_MS"}:
        raise FreeTierContractError
    _require_service_environment_reference(
        entries["VITE_API_BASE_URL"], backend_name, "RENDER_EXTERNAL_URL"
    )
    if entries["VITE_API_TIMEOUT_MS"] != {
        "key": "VITE_API_TIMEOUT_MS",
        "value": "90000",
    }:
        raise FreeTierContractError

    routes = [_mapping(route) for route in _list(service.get("routes"))]
    if routes != [{"type": "rewrite", "source": "/*", "destination": "/index.html"}]:
        raise FreeTierContractError

    headers = [_mapping(header) for header in _list(service.get("headers"))]
    actual_headers: dict[tuple[str, str], str] = {}
    for header in headers:
        path = header.get("path")
        name = header.get("name")
        value = header.get("value")
        if not all(isinstance(item, str) for item in (path, name, value)):
            raise FreeTierContractError
        identity = (str(path), str(name).lower())
        if identity in actual_headers:
            raise FreeTierContractError
        actual_headers[identity] = str(value)

    required_headers = {
        ("/*", "x-frame-options"): "DENY",
        ("/*", "cross-origin-opener-policy"): "same-origin",
        ("/*", "cross-origin-resource-policy"): "same-origin",
        ("/*", "permissions-policy"): (
            "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
        ),
        ("/*", "referrer-policy"): "no-referrer",
        ("/*", "x-content-type-options"): "nosniff",
        ("/*", "x-permitted-cross-domain-policies"): "none",
        ("/*", "x-xss-protection"): "0",
        ("/index.html", "cache-control"): "no-store",
        ("/assets/*", "cache-control"): "public, max-age=31536000, immutable",
    }
    cache_rules = [
        (path, value)
        for (path, name), value in actual_headers.items()
        if name == "cache-control"
    ]
    asset_probe_path = "/assets/app-abcdef.js"
    matching_asset_cache_rules = [
        (path, value)
        for path, value in cache_rules
        if _render_header_path_matches(path, asset_probe_path)
    ]
    if matching_asset_cache_rules != [
        ("/assets/*", "public, max-age=31536000, immutable")
    ]:
        raise FreeTierContractError
    matching_index_cache_rules = [
        (path, value)
        for path, value in cache_rules
        if _render_header_path_matches(path, "/index.html")
    ]
    if matching_index_cache_rules != [("/index.html", "no-store")]:
        raise FreeTierContractError
    if actual_headers != required_headers:
        raise FreeTierContractError
    if any(name == "content-security-policy" for _, name in actual_headers):
        raise FreeTierContractError


def _validate_migration_workflow(workflow: Mapping[str, object]) -> None:
    if set(workflow) != {"name", "on", "permissions", "concurrency", "jobs"}:
        raise FreeTierContractError
    triggers = _mapping(workflow.get("on"))
    if set(triggers) != {"workflow_dispatch"}:
        raise FreeTierContractError
    dispatch = _mapping(triggers["workflow_dispatch"])
    inputs = _mapping(dispatch.get("inputs"))
    expected_inputs = {
        "migration_sha": {
            "description": "Full lowercase SHA of the current remote main commit",
            "required": "true",
            "type": "string",
        },
        "confirmation": {
            "description": "Type MIGRATE_NEON_PRODUCTION to authorize the migration",
            "required": "true",
            "type": "string",
        },
    }
    if inputs != expected_inputs:
        raise FreeTierContractError

    if workflow.get("permissions") != {"contents": "read", "checks": "read"}:
        raise FreeTierContractError
    concurrency = _mapping(workflow.get("concurrency"))
    if (
        concurrency.get("group") != "production-neon-migration"
        or concurrency.get("cancel-in-progress") != "false"
    ):
        raise FreeTierContractError

    jobs = _mapping(workflow.get("jobs"))
    if set(jobs) != {"migrate"}:
        raise FreeTierContractError
    job = _mapping(jobs["migrate"])
    if (
        set(job)
        != {
            "name",
            "runs-on",
            "timeout-minutes",
            "environment",
            "steps",
        }
        or job.get("name") != "Migrate Neon production database"
        or job.get("runs-on") != "ubuntu-24.04"
        or job.get("environment") != "production-neon"
        or job.get("timeout-minutes") not in {"15", "20"}
    ):
        raise FreeTierContractError

    steps = [_mapping(step) for step in _list(job.get("steps"))]
    if tuple(step.get("name") for step in steps) != EXPECTED_MIGRATION_STEP_NAMES:
        raise FreeTierContractError
    expected_step_keys = (
        frozenset({"name", "shell", "env", "run"}),
        frozenset({"name", "uses", "with"}),
        frozenset({"name", "shell", "env", "run"}),
        frozenset({"name", "uses", "with"}),
        frozenset({"name", "shell", "run"}),
        frozenset({"name", "shell", "run"}),
        frozenset({"name", "shell", "env", "run"}),
        frozenset({"name", "shell", "env", "run"}),
        frozenset({"name", "shell", "working-directory", "env", "run"}),
    )
    if tuple(frozenset(step) for step in steps) != expected_step_keys:
        raise FreeTierContractError
    if any(step.get("shell") != "bash" for step in steps if "run" in step):
        raise FreeTierContractError
    run_hashes = tuple(
        hashlib.sha256(str(step["run"]).encode("utf-8")).hexdigest()
        for step in steps
        if "run" in step
    )
    if run_hashes != EXPECTED_MIGRATION_RUN_SHA256:
        raise FreeTierContractError

    expected_step_environments = {
        0: {
            "GH_TOKEN": "${{ github.token }}",
            "MIGRATION_SHA": "${{ inputs.migration_sha }}",
            "CONFIRMATION": "${{ inputs.confirmation }}",
        },
        2: {"MIGRATION_SHA": "${{ inputs.migration_sha }}"},
        6: {
            "GH_TOKEN": "${{ github.token }}",
            "MIGRATION_SHA": "${{ inputs.migration_sha }}",
        },
        7: {"MIGRATION_SHA": "${{ inputs.migration_sha }}"},
    }
    if any(
        _mapping(steps[index].get("env")) != expected_environment
        for index, expected_environment in expected_step_environments.items()
    ):
        raise FreeTierContractError
    pins = [step.get("uses") for step in steps if "uses" in step]
    if pins != [CHECKOUT_ACTION, SETUP_PYTHON_ACTION] or any(
        not isinstance(pin, str) or FULL_ACTION_PIN_PATTERN.fullmatch(pin) is None
        for pin in pins
    ):
        raise FreeTierContractError

    checkout = next(step for step in steps if step.get("uses") == CHECKOUT_ACTION)
    if _mapping(checkout.get("with")) != {
        "ref": "${{ inputs.migration_sha }}",
        "fetch-depth": "1",
        "persist-credentials": "false",
    }:
        raise FreeTierContractError
    setup_python = next(
        step for step in steps if step.get("uses") == SETUP_PYTHON_ACTION
    )
    if _mapping(setup_python.get("with")) != {
        "python-version": "3.12.14",
        "check-latest": "false",
        "cache": "pip",
        "cache-dependency-path": "backend/requirements.lock",
    }:
        raise FreeTierContractError

    migration_steps = [
        step for step in steps if step.get("name") == "Run the exact Neon migration"
    ]
    if len(migration_steps) != 1:
        raise FreeTierContractError
    migration_step = migration_steps[0]
    migration_run = migration_step.get("run")
    if not isinstance(migration_run, str):
        raise FreeTierContractError
    if migration_step.get("working-directory") != "backend":
        raise FreeTierContractError
    if _mapping(migration_step.get("env")) != {
        "GH_TOKEN": "${{ github.token }}",
        "MIGRATION_SHA": "${{ inputs.migration_sha }}",
        "APP_ENVIRONMENT": "production",
        "MIGRATION_DATABASE_URL": "${{ secrets.NEON_MIGRATION_DATABASE_URL }}",
        "EXPECTED_ALEMBIC_HEAD": EXPECTED_ALEMBIC_HEAD,
        "MIGRATION_EXPECTED_LOGIN_ROLE": "roa_migrator",
        "MIGRATION_OWNER_ROLE": "roa_owner",
    }:
        raise FreeTierContractError

    final_reconfirmation_fragments = (
        'remote_main_sha="$(',
        "gh api",
        '"repos/${GITHUB_REPOSITORY}/git/ref/heads/main"',
        'if [[ ! "${remote_main_sha}" =~ ^[0-9a-f]{40}$ ]]; then',
        'if [[ "${remote_main_sha}" != "${MIGRATION_SHA}" ]]; then',
    )
    if any(
        migration_run.count(fragment) != 1
        for fragment in final_reconfirmation_fragments
    ):
        raise FreeTierContractError
    runner_command = "python -m app.database.migration_runner"
    if migration_run.count(runner_command) != 1:
        raise FreeTierContractError
    expected_final_tail = (
        'if [[ "${remote_main_sha}" != "${MIGRATION_SHA}" ]]; then\n'
        '  echo "Migration SHA is not the current remote main SHA." >&2\n'
        "  exit 1\n"
        "fi\n"
        f"exec {runner_command}"
    )
    if not migration_run.rstrip().endswith(expected_final_tail):
        raise FreeTierContractError

    serialized = json.dumps(workflow, sort_keys=True)
    if serialized.count("NEON_MIGRATION_DATABASE_URL") != 1:
        raise FreeTierContractError
    run_scripts = "\n".join(
        str(step.get("run")) for step in steps if isinstance(step.get("run"), str)
    )
    required_fragments = (
        'if [[ "${GITHUB_REPOSITORY}" != "kamilSarbian/Restaurant_Ordering_Analytics" ]]; then',
        'if [[ "${GITHUB_REF}" != "refs/heads/main" ]]; then',
        'if [[ "${CONFIRMATION}" != "MIGRATE_NEON_PRODUCTION" ]]; then',
        'if [[ ! "${MIGRATION_SHA}" =~ ^[0-9a-f]{40}$ ]]; then',
        '"repos/${GITHUB_REPOSITORY}/git/ref/heads/main"',
        'if [[ ! "${remote_main_sha}" =~ ^[0-9a-f]{40}$ ]]; then',
        'if [[ "${remote_main_sha}" != "${MIGRATION_SHA}" ]]; then',
        "gh api",
        "check-runs",
        "filter=latest",
        'if [[ "$(git rev-parse HEAD)" != "${MIGRATION_SHA}" ]]; then',
        "test ! -e .env",
        "test ! -e backend/.env",
        "--require-hashes -r backend/requirements.lock",
        ".github/scripts/free_tier_contract.py",
        "validate_required_check_runs",
        *REQUIRED_CHECK_NAMES,
    )
    if any(fragment not in run_scripts for fragment in required_fragments):
        raise FreeTierContractError

    lowered = serialized.lower()
    forbidden_fragments = (
        "packages: write",
        "id-token",
        "render_api",
        "api.render.com",
        "ghcr.io",
        "docker build",
        "seed_data",
        "seed-demo",
        "deployments: write",
    )
    if any(fragment in lowered for fragment in forbidden_fragments):
        raise FreeTierContractError
    if re.search(r"\b(?:deploy|seed)\b", run_scripts, flags=re.IGNORECASE):
        raise FreeTierContractError
    if "DATABASE_URL" in serialized.replace("MIGRATION_DATABASE_URL", ""):
        raise FreeTierContractError


def _validate_ci_workflow(workflow: Mapping[str, object]) -> None:
    jobs = _mapping(workflow.get("jobs"))
    if set(jobs) != {"backend", "migrations", "frontend", "e2e"}:
        raise FreeTierContractError
    names = tuple(_mapping(jobs[key]).get("name") for key in jobs)
    if set(names) != set(REQUIRED_CHECK_NAMES):
        raise FreeTierContractError

    serialized = json.dumps(workflow, sort_keys=True)
    if (
        ".github/scripts/free_tier_contract.py" not in serialized
        or ".github/workflows/migrate-neon.yml" not in serialized
        or "render.yaml" not in serialized
        or "render_release.py" in serialized
        or ".github/workflows/release.yml" in serialized
    ):
        raise FreeTierContractError


def _environment_entries(
    service: Mapping[str, object],
) -> dict[str, Mapping[str, object]]:
    entries: dict[str, Mapping[str, object]] = {}
    for raw_entry in _list(service.get("envVars")):
        entry = _mapping(raw_entry)
        key = entry.get("key")
        if not isinstance(key, str) or not key or key in entries:
            raise FreeTierContractError
        entries[key] = entry
    return entries


def _require_service_environment_reference(
    entry: Mapping[str, object], service_name: str, env_var_key: str
) -> None:
    key = entry.get("key")
    if not isinstance(key, str):
        raise FreeTierContractError
    if entry != {
        "key": key,
        "fromService": {
            "type": "web",
            "name": service_name,
            "envVarKey": env_var_key,
        },
    }:
        raise FreeTierContractError


def _render_header_path_matches(pattern: str, request_path: str) -> bool:
    """Match one supported Render header wildcard against an absolute path."""
    if not pattern.startswith("/") or not request_path.startswith("/"):
        raise FreeTierContractError
    expression = re.escape(pattern).replace(r"\*", ".*")
    return re.fullmatch(expression, request_path) is not None


def _read_revision_metadata(tree: ast.Module) -> dict[str, object]:
    metadata: dict[str, object] = {}
    for node in tree.body:
        name: str | None = None
        value: ast.expr | None = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name):
                name = target.id
                value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            name = node.target.id
            value = node.value
        if name not in {"revision", "down_revision"} or value is None:
            continue
        try:
            metadata[name] = ast.literal_eval(value)
        except (ValueError, TypeError) as error:
            raise FreeTierContractError from error
    if set(metadata) != {"revision", "down_revision"}:
        raise FreeTierContractError
    return metadata


def _normalize_down_revisions(value: object) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, str) and ALEMBIC_HEAD_PATTERN.fullmatch(value) is not None:
        return {value}
    if (
        isinstance(value, (tuple, list))
        and value
        and all(
            isinstance(item, str) and ALEMBIC_HEAD_PATTERN.fullmatch(item) is not None
            for item in value
        )
    ):
        return set(value)
    raise FreeTierContractError


def _mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise FreeTierContractError
    return value


def _list(value: object) -> list[object]:
    if not isinstance(value, list):
        raise FreeTierContractError
    return value


if __name__ == "__main__":
    raise SystemExit(main())
