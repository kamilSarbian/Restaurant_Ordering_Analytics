"""Offline tests for the immutable Render release controller contract."""

from __future__ import annotations

import copy
import importlib.util
import sys
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request

import pytest
import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
RELEASE_HELPER_PATH = REPOSITORY_ROOT / ".github" / "scripts" / "render_release.py"
RENDER_BLUEPRINT_PATH = REPOSITORY_ROOT / "render.yaml"
RELEASE_WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "release.yml"
MODULE_NAME = "stage20_render_release"


def _load_release_helper() -> ModuleType:
    """Load the repository helper from its non-package GitHub scripts path."""
    specification = importlib.util.spec_from_file_location(
        MODULE_NAME,
        RELEASE_HELPER_PATH,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Render release helper could not be loaded")
    module = importlib.util.module_from_spec(specification)
    sys.modules[MODULE_NAME] = module
    specification.loader.exec_module(module)
    return module


render_release = _load_release_helper()

VALID_RELEASE_SHA = "a" * 40
VALID_DIGEST = f"sha256:{'b' * 64}"
VALID_IMAGE_REF = f"{render_release.GHCR_REPOSITORY}@{VALID_DIGEST}"
BACKEND_SERVICE_ID = f"srv-{'b' * 20}"
MIGRATOR_SERVICE_ID = f"crn-{'m' * 20}"
FRONTEND_SERVICE_ID = f"srv-{'f' * 20}"
API_SECRET_MARKER = "render-api-secret-marker"
REMOTE_SECRET_MARKER = "remote-response-secret-marker"


@dataclass
class FakeRenderClient:
    """Serve fixed GET responses and record any attempted mutation surface."""

    responses: dict[str, object]
    get_calls: list[str] = field(default_factory=list)
    mutation_calls: list[tuple[str, str]] = field(default_factory=list)

    def get_json(self, path: str) -> object:
        """Return the configured response for one exact GET path."""
        self.get_calls.append(path)
        if path not in self.responses:
            raise AssertionError(f"Unexpected Render GET path: {path}")
        return self.responses[path]

    def post_json(self, path: str, payload: object) -> object:
        """Record an unsafe POST attempt so every test can reject it."""
        del payload
        self.mutation_calls.append(("POST", path))
        raise AssertionError("Render mutation was attempted")

    def patch_json(self, path: str, payload: object) -> object:
        """Record an unsafe PATCH attempt so every test can reject it."""
        del payload
        self.mutation_calls.append(("PATCH", path))
        raise AssertionError("Render mutation was attempted")


@dataclass
class FakeHttpResponse:
    """Provide a bounded context-managed response to the urllib client."""

    body: bytes
    status: int = 200
    content_type: str = "application/json; charset=utf-8"
    read_sizes: list[int] = field(default_factory=list)

    @property
    def headers(self) -> dict[str, str]:
        """Return the configured content type as response headers."""
        return {"Content-Type": self.content_type}

    def read(self, size: int) -> bytes:
        """Return at most the requested number of response bytes."""
        self.read_sizes.append(size)
        return self.body[:size]

    def __enter__(self) -> FakeHttpResponse:
        """Enter the fake response context."""
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: Any,
    ) -> bool:
        """Propagate any exception from response processing."""
        del exception_type, exception, traceback
        return False


@dataclass
class FakeUrlOpener:
    """Capture one urllib request without touching the network."""

    response: FakeHttpResponse | None = None
    error: BaseException | None = None
    requests: list[tuple[Request, float]] = field(default_factory=list)

    def open(self, request: Request, timeout: float) -> FakeHttpResponse:
        """Return the fake response or raise the configured transport error."""
        self.requests.append((request, timeout))
        if self.error is not None:
            raise self.error
        if self.response is None:
            raise AssertionError("Fake opener has no response")
        return self.response


@pytest.fixture
def service_ids() -> Any:
    """Return canonical synthetic service identifiers."""
    return render_release.RenderServiceIds(
        backend=BACKEND_SERVICE_ID,
        migrator=MIGRATOR_SERVICE_ID,
        frontend=FRONTEND_SERVICE_ID,
    )


@pytest.fixture
def release_inputs() -> Any:
    """Return one valid immutable release identity."""
    return render_release.ReleaseInputs(
        release_sha=VALID_RELEASE_SHA,
        image_ref=VALID_IMAGE_REF,
        expected_head=render_release.EXPECTED_ALEMBIC_HEAD,
    )


@pytest.fixture
def render_environment(service_ids: Any) -> Any:
    """Return a validated synthetic Render environment."""
    return render_release.RenderEnvironment(
        api_key=API_SECRET_MARKER,
        services=service_ids,
    )


def _service_payload(
    service_id: str,
    service_type: str,
    runtime: str,
    *,
    image_path: str | None = None,
    repository: str | None = None,
    branch: str | None = None,
    auto_deploy: str = "no",
) -> dict[str, object]:
    """Build the exact non-secret Render service shape consumed by preflight."""
    payload: dict[str, object] = {
        "id": service_id,
        "type": service_type,
        "autoDeploy": auto_deploy,
        "suspended": "not_suspended",
        "serviceDetails": {"runtime": runtime},
    }
    if image_path is not None:
        payload["imagePath"] = image_path
    if repository is not None:
        payload["repo"] = repository
    if branch is not None:
        payload["branch"] = branch
    return payload


def _active_jobs_path(service_id: str) -> str:
    """Return the exact active-jobs query expected from preflight."""
    statuses = ",".join(render_release.ACTIVE_JOB_STATUSES)
    return (
        f"/services/{service_id}/jobs?"
        f"{urlencode({'status': statuses, 'limit': 100})}"
    )


def _active_deploys_path(service_id: str) -> str:
    """Return the exact active-deploys query expected from preflight."""
    query_items = [
        ("status", status) for status in render_release.ACTIVE_DEPLOY_STATUSES
    ]
    query_items.append(("limit", "100"))
    return f"/services/{service_id}/deploys?{urlencode(query_items)}"


def _valid_preflight_responses(service_ids: Any) -> dict[str, object]:
    """Build all successful GET responses for one preflight."""
    return {
        f"/services/{service_ids.backend}": _service_payload(
            service_ids.backend,
            "private_service",
            "image",
            image_path=render_release.BOOTSTRAP_IMAGE,
            auto_deploy="yes",
        ),
        f"/services/{service_ids.migrator}": _service_payload(
            service_ids.migrator,
            "cron_job",
            "image",
            image_path=VALID_IMAGE_REF,
            auto_deploy="yes",
        ),
        f"/services/{service_ids.frontend}": _service_payload(
            service_ids.frontend,
            "web_service",
            "docker",
            repository=f"{render_release.GITHUB_REPOSITORY}.git/",
            branch="main",
        ),
        _active_jobs_path(service_ids.migrator): [],
        _active_deploys_path(service_ids.backend): [],
        _active_deploys_path(service_ids.migrator): [],
        _active_deploys_path(service_ids.frontend): [],
    }


def _load_yaml_mapping(path: Path) -> dict[str, object]:
    """Load YAML while preserving GitHub's literal ``on`` mapping key."""
    value = yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise AssertionError(f"Expected a string-keyed YAML mapping: {path.name}")
    return value


def _mapping(value: object) -> dict[str, object]:
    """Narrow a copied YAML value to a mutable string-keyed mapping."""
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise AssertionError("Expected a string-keyed mapping")
    return value


def _list(value: object) -> list[object]:
    """Narrow a copied YAML value to a mutable list."""
    if not isinstance(value, list):
        raise AssertionError("Expected a list")
    return value


def _replace_string_values(value: object, old: str, new: str) -> object:
    """Replace one contract string recursively in a copied YAML document."""
    if isinstance(value, dict):
        return {
            key: _replace_string_values(child, old, new) for key, child in value.items()
        }
    if isinstance(value, list):
        return [_replace_string_values(child, old, new) for child in value]
    if isinstance(value, str):
        return value.replace(old, new)
    return value


def _replace_first_action_pin(value: object) -> bool:
    """Replace the first action SHA with a mutable tag in copied workflow data."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "uses" and isinstance(child, str):
                value[key] = child.split("@", maxsplit=1)[0] + "@main"
                return True
            if _replace_first_action_pin(child):
                return True
    elif isinstance(value, list):
        for child in value:
            if _replace_first_action_pin(child):
                return True
    return False


@pytest.mark.parametrize(
    "release_sha",
    [
        "",
        "a" * 39,
        "a" * 41,
        "A" * 40,
        f"{'a' * 39}g",
        f" {'a' * 40}",
        f"{'a' * 40}\n",
    ],
)
def test_release_inputs_reject_malformed_commit_sha(release_sha: str) -> None:
    """Reject every commit identity that is not an exact lowercase full SHA."""
    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.ReleaseInputs(
            release_sha=release_sha,
            image_ref=VALID_IMAGE_REF,
            expected_head=render_release.EXPECTED_ALEMBIC_HEAD,
        )


@pytest.mark.parametrize(
    "image_ref",
    [
        "",
        f"{render_release.GHCR_REPOSITORY}:latest",
        f"{render_release.GHCR_REPOSITORY}:stage20-bootstrap",
        f"{render_release.GHCR_REPOSITORY}@sha256:{'b' * 63}",
        f"{render_release.GHCR_REPOSITORY}@sha256:{'B' * 64}",
        f"{render_release.GHCR_REPOSITORY}@sha512:{'b' * 64}",
        f"ghcr.io/attacker/repository@{VALID_DIGEST}",
        f"{render_release.GHCR_REPOSITORY}.evil@{VALID_DIGEST}",
        f"{render_release.GHCR_REPOSITORY}@{VALID_DIGEST}\n",
    ],
)
def test_release_inputs_reject_nonimmutable_image_reference(image_ref: str) -> None:
    """Require the canonical GHCR repository and one exact SHA-256 digest."""
    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.ReleaseInputs(
            release_sha=VALID_RELEASE_SHA,
            image_ref=image_ref,
            expected_head=render_release.EXPECTED_ALEMBIC_HEAD,
        )


@pytest.mark.parametrize(
    "expected_head",
    [
        "",
        "HEAD",
        "0008/add",
        "0008 add",
        "0008;upgrade",
        "_leading",
        "0007_previous_safe",
    ],
)
def test_release_inputs_reject_unsafe_alembic_head(expected_head: str) -> None:
    """Reject empty or syntactically unsafe Alembic revision identities."""
    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.ReleaseInputs(
            release_sha=VALID_RELEASE_SHA,
            image_ref=VALID_IMAGE_REF,
            expected_head=expected_head,
        )


def test_release_inputs_expose_only_the_validated_digest(release_inputs: Any) -> None:
    """Return the digest without weakening the full immutable image identity."""
    assert release_inputs.release_sha == VALID_RELEASE_SHA
    assert release_inputs.image_ref == VALID_IMAGE_REF
    assert release_inputs.digest == VALID_DIGEST
    assert release_inputs.expected_head == render_release.EXPECTED_ALEMBIC_HEAD


@pytest.mark.parametrize(
    "environment",
    [
        {},
        {
            "RENDER_BACKEND_SERVICE_ID": BACKEND_SERVICE_ID,
            "RENDER_MIGRATOR_SERVICE_ID": MIGRATOR_SERVICE_ID,
            "RENDER_FRONTEND_SERVICE_ID": FRONTEND_SERVICE_ID,
        },
        {
            "RENDER_API_KEY": "   ",
            "RENDER_BACKEND_SERVICE_ID": BACKEND_SERVICE_ID,
            "RENDER_MIGRATOR_SERVICE_ID": MIGRATOR_SERVICE_ID,
            "RENDER_FRONTEND_SERVICE_ID": FRONTEND_SERVICE_ID,
        },
        {
            "RENDER_API_KEY": f"unsafe\n{API_SECRET_MARKER}",
            "RENDER_BACKEND_SERVICE_ID": BACKEND_SERVICE_ID,
            "RENDER_MIGRATOR_SERVICE_ID": MIGRATOR_SERVICE_ID,
            "RENDER_FRONTEND_SERVICE_ID": FRONTEND_SERVICE_ID,
        },
        {
            "RENDER_API_KEY": API_SECRET_MARKER,
            "RENDER_BACKEND_SERVICE_ID": "srv-short",
            "RENDER_MIGRATOR_SERVICE_ID": MIGRATOR_SERVICE_ID,
            "RENDER_FRONTEND_SERVICE_ID": FRONTEND_SERVICE_ID,
        },
        {
            "RENDER_API_KEY": API_SECRET_MARKER,
            "RENDER_BACKEND_SERVICE_ID": BACKEND_SERVICE_ID,
            "RENDER_MIGRATOR_SERVICE_ID": f"srv-{'m' * 20}",
            "RENDER_FRONTEND_SERVICE_ID": FRONTEND_SERVICE_ID,
        },
        {
            "RENDER_API_KEY": API_SECRET_MARKER,
            "RENDER_BACKEND_SERVICE_ID": BACKEND_SERVICE_ID,
            "RENDER_MIGRATOR_SERVICE_ID": MIGRATOR_SERVICE_ID,
            "RENDER_FRONTEND_SERVICE_ID": BACKEND_SERVICE_ID,
        },
    ],
)
def test_render_environment_rejects_missing_or_wrong_values(
    environment: dict[str, str],
) -> None:
    """Fail closed on missing credentials, wrong ID types, and duplicate IDs."""
    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.RenderEnvironment.from_environment(environment)


@pytest.mark.parametrize(
    "api_key",
    [
        "x" * 513,
        f"unsafe{chr(127)}key",
        "non-ascii-å",
    ],
)
def test_render_environment_rejects_unsafe_api_key_characters(
    api_key: str,
) -> None:
    """Reject oversized, control-bearing, and non-ASCII API credentials."""
    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.RenderEnvironment.from_environment(
            {
                "RENDER_API_KEY": api_key,
                "RENDER_BACKEND_SERVICE_ID": BACKEND_SERVICE_ID,
                "RENDER_MIGRATOR_SERVICE_ID": MIGRATOR_SERVICE_ID,
                "RENDER_FRONTEND_SERVICE_ID": FRONTEND_SERVICE_ID,
            }
        )


def test_render_environment_hides_api_key_from_representations(
    service_ids: Any,
) -> None:
    """Keep the Render API key out of dataclass string representations."""
    environment = render_release.RenderEnvironment.from_environment(
        {
            "RENDER_API_KEY": API_SECRET_MARKER,
            "RENDER_BACKEND_SERVICE_ID": service_ids.backend,
            "RENDER_MIGRATOR_SERVICE_ID": service_ids.migrator,
            "RENDER_FRONTEND_SERVICE_ID": service_ids.frontend,
        }
    )

    assert API_SECRET_MARKER not in repr(environment)
    assert API_SECRET_MARKER not in str(environment)


def test_release_plan_has_one_exact_order_and_identity(
    release_inputs: Any,
    service_ids: Any,
) -> None:
    """Pin migration-before-backend-before-frontend ordering and identities."""
    plan = render_release.build_release_plan(release_inputs, service_ids)

    assert [step.name for step in plan.steps] == [
        "promote_migrator_artifact",
        "run_migrations",
        "promote_backend",
        "verify_backend",
        "deploy_frontend",
    ]
    assert [step.service_id for step in plan.steps] == [
        service_ids.migrator,
        service_ids.migrator,
        service_ids.backend,
        service_ids.backend,
        service_ids.frontend,
    ]
    assert [step.identity for step in plan.steps] == [
        VALID_IMAGE_REF,
        render_release.MIGRATION_COMMAND,
        VALID_IMAGE_REF,
        VALID_IMAGE_REF,
        VALID_RELEASE_SHA,
    ]
    assert {plan.steps[index].identity for index in (0, 2, 3)} == {VALID_IMAGE_REF}
    assert plan.steps[2].environment_updates == (("RELEASE_SHA", VALID_RELEASE_SHA),)
    assert all(
        step.environment_updates == ()
        for index, step in enumerate(plan.steps)
        if index != 2
    )


def _successful_check_payloads() -> dict[str, object]:
    """Build one exact successful GitHub Actions check per required CI gate."""
    return {
        check_name: {
            "total_count": 1,
            "check_runs": [
                {
                    "name": check_name,
                    "head_sha": VALID_RELEASE_SHA,
                    "status": "completed",
                    "conclusion": "success",
                    "app": {"slug": "github-actions"},
                }
            ],
        }
        for check_name in render_release.REQUIRED_CHECK_NAMES
    }


def test_required_check_runs_accept_one_exact_success_per_gate() -> None:
    """Accept only the complete four-check success matrix for the release SHA."""
    render_release.validate_required_check_runs(
        _successful_check_payloads(),
        VALID_RELEASE_SHA,
    )


@pytest.mark.parametrize(
    "mutation",
    [
        "missing_gate",
        "extra_result",
        "wrong_count",
        "wrong_name",
        "wrong_sha",
        "pending",
        "failure",
        "wrong_app",
        "malformed_app",
    ],
)
def test_required_check_runs_reject_ambiguous_or_failed_matrix(
    mutation: str,
) -> None:
    """Reject missing, ambiguous, nonterminal, failed, and foreign check-runs."""
    payloads = _successful_check_payloads()
    check_name = render_release.REQUIRED_CHECK_NAMES[0]
    payload = _mapping(payloads[check_name])
    check_runs = _list(payload["check_runs"])
    check_run = _mapping(check_runs[0])

    if mutation == "missing_gate":
        payloads.pop(check_name)
    elif mutation == "extra_result":
        check_runs.append(copy.deepcopy(check_run))
        payload["total_count"] = 2
    elif mutation == "wrong_count":
        payload["total_count"] = 2
    elif mutation == "wrong_name":
        check_run["name"] = "Backend CI"
    elif mutation == "wrong_sha":
        check_run["head_sha"] = "c" * 40
    elif mutation == "pending":
        check_run["status"] = "in_progress"
        check_run["conclusion"] = None
    elif mutation == "failure":
        check_run["conclusion"] = "failure"
    elif mutation == "wrong_app":
        _mapping(check_run["app"])["slug"] = "third-party-ci"
    elif mutation == "malformed_app":
        check_run["app"] = None
    else:
        raise AssertionError(f"Unhandled mutation: {mutation}")

    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.validate_required_check_runs(
            payloads,
            VALID_RELEASE_SHA,
        )


@pytest.mark.parametrize(
    "status",
    ["", "pending", "running", "failed", "canceled", "live", "SUCCEEDED"],
)
def test_migration_status_gate_accepts_only_exact_success(status: str) -> None:
    """Block backend promotion for every non-success migration status."""
    with pytest.raises(render_release.ReleasePreflightError):
        render_release.require_successful_migration(status)


def test_migration_status_gate_accepts_succeeded() -> None:
    """Allow the exact terminal migration success status."""
    render_release.require_successful_migration("succeeded")


@pytest.mark.parametrize(
    "status",
    [
        "",
        "created",
        "queued",
        "build_in_progress",
        "update_in_progress",
        "failed",
        "canceled",
        "LIVE",
    ],
)
def test_deploy_status_gate_accepts_only_exact_live(status: str) -> None:
    """Block the next release phase until the deploy is exactly live."""
    with pytest.raises(render_release.ReleasePreflightError):
        render_release.require_live_deploy(status)


def test_deploy_status_gate_accepts_live() -> None:
    """Allow the exact terminal live deploy status."""
    render_release.require_live_deploy("live")


def test_repository_has_one_exact_alembic_head() -> None:
    """Prove the checked-in migration graph has the release contract head."""
    heads = render_release.find_alembic_heads(
        REPOSITORY_ROOT / "backend" / "alembic" / "versions"
    )

    assert heads == (render_release.EXPECTED_ALEMBIC_HEAD,)


def test_alembic_head_detection_handles_branches_deterministically(
    tmp_path: Path,
) -> None:
    """Return every graph head in stable sorted order without importing code."""
    (tmp_path / "0001_base.py").write_text(
        "revision = '0001_base'\ndown_revision = None\n",
        encoding="utf-8",
    )
    (tmp_path / "0002_left.py").write_text(
        "revision = '0002_left'\ndown_revision = '0001_base'\n",
        encoding="utf-8",
    )
    (tmp_path / "0002_right.py").write_text(
        "revision = '0002_right'\ndown_revision = '0001_base'\n",
        encoding="utf-8",
    )

    assert render_release.find_alembic_heads(tmp_path) == (
        "0002_left",
        "0002_right",
    )


@pytest.mark.parametrize(
    ("filename", "source"),
    [
        ("invalid.py", "revision =\n"),
        ("missing_parent.py", "revision = '0001_base'\n"),
        (
            "dynamic.py",
            "revision = ''.join(['0001', '_base'])\ndown_revision = None\n",
        ),
        (
            "invalid_parent.py",
            "revision = '0001_base'\ndown_revision = 123\n",
        ),
    ],
)
def test_alembic_head_detection_rejects_unsafe_metadata(
    tmp_path: Path,
    filename: str,
    source: str,
) -> None:
    """Reject malformed, incomplete, dynamic, or non-string metadata."""
    (tmp_path / filename).write_text(source, encoding="utf-8")

    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.find_alembic_heads(tmp_path)


def test_alembic_head_detection_rejects_duplicate_and_dangling_revisions(
    tmp_path: Path,
) -> None:
    """Reject duplicate revision IDs and parents absent from the graph."""
    duplicate_directory = tmp_path / "duplicate"
    duplicate_directory.mkdir()
    (duplicate_directory / "first.py").write_text(
        "revision = '0001_base'\ndown_revision = None\n",
        encoding="utf-8",
    )
    (duplicate_directory / "second.py").write_text(
        "revision = '0001_base'\ndown_revision = None\n",
        encoding="utf-8",
    )
    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.find_alembic_heads(duplicate_directory)

    dangling_directory = tmp_path / "dangling"
    dangling_directory.mkdir()
    (dangling_directory / "revision.py").write_text(
        "revision = '0002_child'\ndown_revision = '0001_missing'\n",
        encoding="utf-8",
    )
    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.find_alembic_heads(dangling_directory)


@pytest.mark.parametrize("directory_name", ["missing", "empty"])
def test_alembic_head_detection_rejects_missing_or_empty_directory(
    tmp_path: Path,
    directory_name: str,
) -> None:
    """Reject a missing versions directory and a directory with no revisions."""
    versions_directory = tmp_path / directory_name
    if directory_name == "empty":
        versions_directory.mkdir()

    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.find_alembic_heads(versions_directory)


def test_checked_in_blueprint_and_workflow_pass_static_contract() -> None:
    """Validate the exact checked-in Blueprint and manual release workflow."""
    render_release.validate_repository_contract(
        _load_yaml_mapping(RENDER_BLUEPRINT_PATH),
        _load_yaml_mapping(RELEASE_WORKFLOW_PATH),
    )


@pytest.mark.parametrize(
    "mutation",
    [
        "database_plan",
        "database_version",
        "database_public_ingress",
        "database_connection_pool",
        "database_storage_autoscaling",
        "preview_generation",
        "latest_image",
        "runtime_database_from_database",
        "backend_gets_migration_url",
        "migrator_gets_runtime_url",
        "migrator_gets_stripe_secret",
        "hardcoded_backend_secret",
        "wrong_upstream",
        "backend_auto_deploy_field",
    ],
)
def test_blueprint_static_contract_rejects_boundary_drift(mutation: str) -> None:
    """Reject plan, network, image, role, secret, and topology drift."""
    config = copy.deepcopy(_load_yaml_mapping(RENDER_BLUEPRINT_PATH))
    previews = _mapping(config["previews"])
    database = _mapping(_list(config["databases"])[0])
    services = {
        _mapping(item)["name"]: _mapping(item) for item in _list(config["services"])
    }
    backend = services["roa-production-backend"]
    migrator = services["roa-production-migrator"]
    frontend = services["roa-production-frontend"]

    if mutation == "database_plan":
        database["plan"] = "free"
    elif mutation == "database_version":
        database["postgresMajorVersion"] = "18"
    elif mutation == "database_public_ingress":
        database["ipAllowList"] = [{"source": "0.0.0.0/0"}]
    elif mutation == "database_connection_pool":
        database["connectionPool"] = "pgbouncer"
    elif mutation == "database_storage_autoscaling":
        database["storageAutoscalingEnabled"] = "true"
    elif mutation == "preview_generation":
        previews["generation"] = "automatic"
    elif mutation == "latest_image":
        _mapping(backend["image"])["url"] = f"{render_release.GHCR_REPOSITORY}:latest"
    elif mutation == "runtime_database_from_database":
        for raw_entry in _list(backend["envVars"]):
            entry = _mapping(raw_entry)
            if entry.get("key") == "DATABASE_URL":
                entry.pop("sync")
                entry["fromDatabase"] = {
                    "name": "roa-production-db",
                    "property": "connectionString",
                }
    elif mutation == "backend_gets_migration_url":
        _list(backend["envVars"]).append(
            {"key": "MIGRATION_DATABASE_URL", "sync": "false"}
        )
    elif mutation == "migrator_gets_runtime_url":
        _list(migrator["envVars"]).append({"key": "DATABASE_URL", "sync": "false"})
    elif mutation == "migrator_gets_stripe_secret":
        _list(migrator["envVars"]).append({"key": "STRIPE_SECRET_KEY", "sync": "false"})
    elif mutation == "hardcoded_backend_secret":
        for raw_entry in _list(backend["envVars"]):
            entry = _mapping(raw_entry)
            if entry.get("key") == "AUTH_JWT_SECRET":
                entry.pop("sync")
                entry["value"] = REMOTE_SECRET_MARKER
    elif mutation == "wrong_upstream":
        entry = _mapping(_list(frontend["envVars"])[0])
        _mapping(entry["fromService"])["name"] = "attacker-backend"
    elif mutation == "backend_auto_deploy_field":
        backend["autoDeployTrigger"] = "off"
    else:
        raise AssertionError(f"Unhandled mutation: {mutation}")

    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.validate_repository_contract(
            config,
            _load_yaml_mapping(RELEASE_WORKFLOW_PATH),
        )


@pytest.mark.parametrize(
    "mutation",
    [
        "push_trigger",
        "pull_request_target",
        "missing_input",
        "optional_confirmation",
        "excess_permission",
        "mutable_action",
        "latest_reference",
        "missing_required_check",
        "weak_confirmation",
        "semantic_check_bypass",
        "build_arg",
    ],
)
def test_workflow_static_contract_rejects_unsafe_drift(mutation: str) -> None:
    """Reject automatic triggers, excess authority, mutable actions, and weak gates."""
    workflow = copy.deepcopy(_load_yaml_mapping(RELEASE_WORKFLOW_PATH))
    triggers = _mapping(workflow["on"])
    permissions = _mapping(workflow["permissions"])
    dispatch = _mapping(triggers["workflow_dispatch"])
    inputs = _mapping(dispatch["inputs"])

    if mutation == "push_trigger":
        triggers["push"] = {"branches": ["main"]}
    elif mutation == "pull_request_target":
        triggers["pull_request_target"] = {}
    elif mutation == "missing_input":
        inputs.pop("confirm")
    elif mutation == "optional_confirmation":
        _mapping(inputs["confirm"])["required"] = "false"
    elif mutation == "excess_permission":
        permissions["id-token"] = "write"
    elif mutation == "mutable_action":
        assert _replace_first_action_pin(workflow)
    elif mutation == "latest_reference":
        workflow["unsafe-test-value"] = f"{render_release.GHCR_REPOSITORY}:latest"
    elif mutation == "missing_required_check":
        replaced = _replace_string_values(
            workflow,
            "Browser E2E",
            "Browser Acceptance",
        )
        workflow = _mapping(replaced)
    elif mutation == "weak_confirmation":
        replaced = _replace_string_values(
            workflow,
            'if [[ "${CONFIRM}" != "DEPLOY_STAGE20" ]]; then',
            'if [[ "DEPLOY_STAGE20" != "DEPLOY_STAGE20" ]]; then',
        )
        workflow = _mapping(replaced)
    elif mutation == "semantic_check_bypass":
        replaced = _replace_string_values(
            workflow,
            "validate_required_check_runs",
            "disabled_check_validator",
        )
        workflow = _mapping(replaced)
    elif mutation == "build_arg":
        release_job = _mapping(_mapping(workflow["jobs"])["release"])
        for raw_step in _list(release_job["steps"]):
            step = _mapping(raw_step)
            run = step.get("run")
            if isinstance(run, str) and "docker buildx build" in run:
                step["run"] = f"{run}\n--build-arg UNSAFE=value"
                break
    else:
        raise AssertionError(f"Unhandled mutation: {mutation}")

    with pytest.raises(render_release.ReleaseConfigurationError):
        render_release.validate_repository_contract(
            _load_yaml_mapping(RENDER_BLUEPRINT_PATH),
            workflow,
        )


def test_preflight_is_get_only_and_returns_the_exact_plan(
    render_environment: Any,
    release_inputs: Any,
) -> None:
    """Read all three services and idle gates without exposing a mutation path."""
    responses = _valid_preflight_responses(render_environment.services)
    client = FakeRenderClient(responses)

    report = render_release.perform_preflight(
        client,
        render_environment,
        release_inputs,
    )

    assert client.get_calls == [
        f"/services/{render_environment.services.backend}",
        f"/services/{render_environment.services.migrator}",
        f"/services/{render_environment.services.frontend}",
        _active_jobs_path(render_environment.services.migrator),
        _active_deploys_path(render_environment.services.backend),
        _active_deploys_path(render_environment.services.migrator),
        _active_deploys_path(render_environment.services.frontend),
    ]
    assert client.mutation_calls == []
    assert report.plan == render_release.build_release_plan(
        release_inputs,
        render_environment.services,
    )
    assert report.backend.image_path == render_release.BOOTSTRAP_IMAGE
    assert report.migrator.image_path == VALID_IMAGE_REF
    assert report.frontend.branch == "main"


@pytest.mark.parametrize(
    "mutation",
    [
        "backend_id",
        "backend_type",
        "backend_runtime",
        "frontend_auto_deploy",
        "backend_suspended",
        "backend_repository",
        "backend_mutable_tag",
        "backend_unknown_auto_deploy",
        "backend_missing_auto_deploy",
        "migrator_type",
        "migrator_runtime",
        "migrator_repository",
        "frontend_type",
        "frontend_runtime",
        "frontend_repository",
        "frontend_branch",
    ],
)
def test_preflight_rejects_wrong_service_identity_or_source(
    render_environment: Any,
    release_inputs: Any,
    mutation: str,
) -> None:
    """Fail closed on wrong service types, runtimes, states, images, and repos."""
    services = render_environment.services
    responses = _valid_preflight_responses(services)
    backend = _mapping(responses[f"/services/{services.backend}"])
    migrator = _mapping(responses[f"/services/{services.migrator}"])
    frontend = _mapping(responses[f"/services/{services.frontend}"])

    if mutation == "backend_id":
        backend["id"] = FRONTEND_SERVICE_ID
    elif mutation == "backend_type":
        backend["type"] = "web_service"
    elif mutation == "backend_runtime":
        _mapping(backend["serviceDetails"])["runtime"] = "docker"
    elif mutation == "frontend_auto_deploy":
        frontend["autoDeploy"] = "yes"
    elif mutation == "backend_suspended":
        backend["suspended"] = "suspended"
    elif mutation == "backend_repository":
        backend["imagePath"] = f"ghcr.io/attacker/backend@{VALID_DIGEST}"
    elif mutation == "backend_mutable_tag":
        backend["imagePath"] = f"{render_release.GHCR_REPOSITORY}:latest"
    elif mutation == "backend_unknown_auto_deploy":
        backend["autoDeploy"] = "sometimes"
    elif mutation == "backend_missing_auto_deploy":
        backend.pop("autoDeploy")
    elif mutation == "migrator_type":
        migrator["type"] = "background_worker"
    elif mutation == "migrator_runtime":
        _mapping(migrator["serviceDetails"])["runtime"] = "docker"
    elif mutation == "migrator_repository":
        migrator["imagePath"] = f"{render_release.GHCR_REPOSITORY}.evil@{VALID_DIGEST}"
    elif mutation == "frontend_type":
        frontend["type"] = "private_service"
    elif mutation == "frontend_runtime":
        _mapping(frontend["serviceDetails"])["runtime"] = "image"
    elif mutation == "frontend_repository":
        frontend["repo"] = f"{render_release.GITHUB_REPOSITORY}-attacker"
    elif mutation == "frontend_branch":
        frontend["branch"] = "develop"
    else:
        raise AssertionError(f"Unhandled mutation: {mutation}")

    client = FakeRenderClient(responses)
    with pytest.raises(render_release.ReleasePreflightError) as caught:
        render_release.perform_preflight(
            client,
            render_environment,
            release_inputs,
        )

    assert str(caught.value) == "Render release preflight failed."
    assert REMOTE_SECRET_MARKER not in str(caught.value)
    assert client.mutation_calls == []


@pytest.mark.parametrize(
    ("gate", "payload"),
    [
        ("jobs", [{"job": {"status": "pending"}}]),
        ("jobs", [{"job": {"status": "succeeded"}}]),
        ("jobs", [{"status": "running"}]),
        ("jobs", {"job": {"status": "running"}}),
        ("deploys", [{"deploy": {"status": "queued"}}]),
        ("deploys", [{"deploy": {"status": "live"}}]),
        ("deploys", [{"status": "created"}]),
        ("deploys", {"deploy": {"status": "created"}}),
    ],
)
def test_preflight_rejects_active_unknown_or_malformed_idle_gate(
    render_environment: Any,
    release_inputs: Any,
    gate: str,
    payload: object,
) -> None:
    """Require empty, correctly shaped active-job and active-deploy queries."""
    responses = _valid_preflight_responses(render_environment.services)
    path = (
        _active_jobs_path(render_environment.services.migrator)
        if gate == "jobs"
        else _active_deploys_path(render_environment.services.migrator)
    )
    responses[path] = payload
    client = FakeRenderClient(responses)

    with pytest.raises(render_release.ReleasePreflightError):
        render_release.perform_preflight(
            client,
            render_environment,
            release_inputs,
        )

    assert client.mutation_calls == []


def test_api_client_issues_one_bounded_authenticated_get() -> None:
    """Use one exact GET with a timeout and bounded JSON response read."""
    response = FakeHttpResponse(body=b'{"id":"srv-safe"}')
    opener = FakeUrlOpener(response=response)
    client = render_release.RenderApiClient(
        api_key=API_SECRET_MARKER,
        timeout_seconds=7.5,
        opener=opener,
    )

    payload = client.get_json("/services/srv-safe")

    assert payload == {"id": "srv-safe"}
    assert len(opener.requests) == 1
    request, timeout = opener.requests[0]
    assert request.get_method() == "GET"
    assert request.full_url == (
        f"{render_release.RENDER_API_BASE_URL}/services/srv-safe"
    )
    assert request.get_header("Authorization") == f"Bearer {API_SECRET_MARKER}"
    assert request.get_header("Accept") == "application/json"
    assert timeout == 7.5
    assert response.read_sizes == [render_release.MAX_API_RESPONSE_BYTES + 1]
    assert API_SECRET_MARKER not in repr(client)


@pytest.mark.parametrize(
    "path",
    [
        "",
        "services/srv-safe",
        "//attacker.example/path",
        "/services/../secrets",
        "/services/srv-safe#fragment",
        "/services/srv-safe:443",
        "/services/srv-safe path",
        f"/services/srv-safe\n{REMOTE_SECRET_MARKER}",
    ],
)
def test_api_client_rejects_unsafe_paths_before_open(path: str) -> None:
    """Reject paths that could escape the fixed Render API origin."""
    opener = FakeUrlOpener(response=FakeHttpResponse(body=b"{}"))
    client = render_release.RenderApiClient(
        api_key=API_SECRET_MARKER,
        opener=opener,
    )

    with pytest.raises(render_release.RenderApiError):
        client.get_json(path)

    assert opener.requests == []


@pytest.mark.parametrize(
    "response",
    [
        FakeHttpResponse(body=b"{}", status=201),
        FakeHttpResponse(body=b"{}", content_type="text/html"),
        FakeHttpResponse(body=b"not-json"),
        FakeHttpResponse(body=b"\xff"),
        FakeHttpResponse(body=b"x" * (render_release.MAX_API_RESPONSE_BYTES + 1)),
    ],
)
def test_api_client_sanitizes_invalid_responses(response: FakeHttpResponse) -> None:
    """Reject status, media type, encoding, JSON, and size failures generically."""
    opener = FakeUrlOpener(response=response)
    client = render_release.RenderApiClient(
        api_key=API_SECRET_MARKER,
        opener=opener,
    )

    with pytest.raises(render_release.RenderApiError) as caught:
        client.get_json("/services/srv-safe")

    assert str(caught.value) == "Render API request failed."
    assert API_SECRET_MARKER not in str(caught.value)
    assert REMOTE_SECRET_MARKER not in str(caught.value)


def test_api_client_sanitizes_transport_error() -> None:
    """Wrap transport details without copying their secret-bearing reason."""
    opener = FakeUrlOpener(
        error=URLError(f"transport-{API_SECRET_MARKER}-{REMOTE_SECRET_MARKER}")
    )
    client = render_release.RenderApiClient(
        api_key=API_SECRET_MARKER,
        opener=opener,
    )

    with pytest.raises(render_release.RenderApiError) as caught:
        client.get_json("/services/srv-safe")

    assert str(caught.value) == "Render API request failed."
    assert API_SECRET_MARKER not in str(caught.value)
    assert REMOTE_SECRET_MARKER not in str(caught.value)


def _set_valid_cli_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Install only the synthetic values consumed by the release CLI."""
    monkeypatch.setenv("RENDER_API_KEY", API_SECRET_MARKER)
    monkeypatch.setenv("RENDER_BACKEND_SERVICE_ID", BACKEND_SERVICE_ID)
    monkeypatch.setenv("RENDER_MIGRATOR_SERVICE_ID", MIGRATOR_SERVICE_ID)
    monkeypatch.setenv("RENDER_FRONTEND_SERVICE_ID", FRONTEND_SERVICE_ID)


def _cli_arguments(*, execute: bool = False) -> list[str]:
    """Return canonical command-line arguments for one offline release."""
    arguments = [
        "--release-sha",
        VALID_RELEASE_SHA,
        "--image-ref",
        VALID_IMAGE_REF,
        "--expected-head",
        render_release.EXPECTED_ALEMBIC_HEAD,
    ]
    if execute:
        arguments.append("--execute")
    return arguments


def test_main_dry_run_performs_only_preflight_gets(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    service_ids: Any,
) -> None:
    """Complete dry-run with an explicit zero-mutation result."""
    _set_valid_cli_environment(monkeypatch)
    client = FakeRenderClient(_valid_preflight_responses(service_ids))
    monkeypatch.setattr(
        render_release,
        "RenderApiClient",
        lambda api_key: client,
    )

    result = render_release.main(_cli_arguments())
    captured = capsys.readouterr()

    assert result == 0
    assert "Render release preflight passed." in captured.out
    assert f"Release SHA: {VALID_RELEASE_SHA}" in captured.out
    assert f"Image digest: {VALID_DIGEST}" in captured.out
    assert "Planned steps: 5" in captured.out
    assert "DRY-RUN: Render mutation count is zero." in captured.out
    assert captured.err == ""
    assert API_SECRET_MARKER not in captured.out
    assert client.mutation_calls == []
    assert all(path.startswith("/services/") for path in client.get_calls)


def test_main_execute_stops_at_exact_pending_proof_without_mutation(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    service_ids: Any,
) -> None:
    """Return the dedicated pending code after GET-only preflight and no writes."""
    _set_valid_cli_environment(monkeypatch)
    client = FakeRenderClient(_valid_preflight_responses(service_ids))
    monkeypatch.setattr(
        render_release,
        "RenderApiClient",
        lambda api_key: client,
    )

    result = render_release.main(_cli_arguments(execute=True))
    captured = capsys.readouterr()

    assert result == 3
    assert "Render release preflight passed." in captured.out
    assert "DRY-RUN" not in captured.out
    assert captured.err == (f"{render_release.MIGRATOR_ARTIFACT_PROOF_PENDING}\n")
    assert client.mutation_calls == []
    assert client.get_calls == [
        f"/services/{service_ids.backend}",
        f"/services/{service_ids.migrator}",
        f"/services/{service_ids.frontend}",
        _active_jobs_path(service_ids.migrator),
        _active_deploys_path(service_ids.backend),
        _active_deploys_path(service_ids.migrator),
        _active_deploys_path(service_ids.frontend),
    ]
    assert API_SECRET_MARKER not in captured.out
    assert API_SECRET_MARKER not in captured.err


def test_main_rejects_repository_head_mismatch_before_client(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Reject migration-graph drift before constructing a network client."""
    _set_valid_cli_environment(monkeypatch)
    client_created = False

    def forbidden_client(api_key: str) -> None:
        """Fail if graph drift reaches the network boundary."""
        del api_key
        nonlocal client_created
        client_created = True

    monkeypatch.setattr(
        render_release,
        "find_alembic_heads",
        lambda versions_directory: ("0007_previous_safe",),
    )
    monkeypatch.setattr(render_release, "RenderApiClient", forbidden_client)

    result = render_release.main(_cli_arguments())
    captured = capsys.readouterr()

    assert result == 2
    assert captured.out == ""
    assert captured.err == "Release configuration invalid.\n"
    assert client_created is False


def test_main_failure_output_never_echoes_invalid_input_or_secret(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Return one generic configuration error before constructing a client."""
    _set_valid_cli_environment(monkeypatch)
    client_created = False

    def forbidden_client(api_key: str) -> None:
        """Fail if malformed immutable input reaches the network boundary."""
        del api_key
        nonlocal client_created
        client_created = True

    monkeypatch.setattr(render_release, "RenderApiClient", forbidden_client)
    malicious_sha = f"{REMOTE_SECRET_MARKER};{'a' * 40}"
    arguments = _cli_arguments()
    arguments[1] = malicious_sha

    result = render_release.main(arguments)
    captured = capsys.readouterr()

    assert result == 2
    assert captured.out == ""
    assert captured.err == "Release configuration invalid.\n"
    assert malicious_sha not in captured.err
    assert API_SECRET_MARKER not in captured.err
    assert client_created is False
