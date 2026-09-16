"""Validate the immutable Render release contract without unsafe promotion."""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, Self
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

RENDER_API_BASE_URL = "https://api.render.com/v1"
GHCR_REPOSITORY = "ghcr.io/kamilsarbian/restaurant-ordering-analytics-backend"
BOOTSTRAP_IMAGE = f"{GHCR_REPOSITORY}:stage20-bootstrap"
GITHUB_REPOSITORY = "https://github.com/kamilSarbian/Restaurant_Ordering_Analytics"
EXPECTED_ALEMBIC_HEAD = "0008_add_order_ownership"
MIGRATION_COMMAND = "/usr/local/bin/run-migrations"
MIGRATOR_ARTIFACT_PROOF_PENDING = "MIGRATOR ARTIFACT PROMOTION NEEDS LIVE RUNTIME PROOF"

GIT_SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
ALEMBIC_HEAD_PATTERN = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*")
SERVER_ID_PATTERN = re.compile(r"srv-[0-9a-z]{20}")
CRON_ID_PATTERN = re.compile(r"crn-[0-9a-z]{20}")
SAFE_API_PATH_PATTERN = re.compile(r"/[a-z0-9A-F_?&=,./%-]+")
FULL_ACTION_PIN_PATTERN = re.compile(r"[^@\s]+@[0-9a-f]{40}")
MAX_API_RESPONSE_BYTES = 1_048_576
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]

ACTIVE_DEPLOY_STATUSES = (
    "created",
    "queued",
    "build_in_progress",
    "pre_deploy_in_progress",
    "update_in_progress",
)
ACTIVE_JOB_STATUSES = ("pending", "running")
REQUIRED_CHECK_NAMES = ("Backend", "Migrations", "Frontend", "Browser E2E")


class ReleaseError(Exception):
    """Represent a release failure with a secret-free public message."""


class ReleaseConfigurationError(ReleaseError):
    """Report invalid local inputs or environment configuration."""

    def __init__(self) -> None:
        """Initialize a stable configuration error."""
        super().__init__("Release configuration invalid.")


class ReleasePreflightError(ReleaseError):
    """Report an unexpected or unsafe Render state."""

    def __init__(self) -> None:
        """Initialize a stable preflight error."""
        super().__init__("Render release preflight failed.")


class RenderApiError(ReleaseError):
    """Report a sanitized Render API transport or response failure."""

    def __init__(self) -> None:
        """Initialize a stable API error."""
        super().__init__("Render API request failed.")


class ArtifactProofPendingError(ReleaseError):
    """Stop mutation while cron one-off artifact identity remains unproved."""

    def __init__(self) -> None:
        """Initialize the mandatory runtime-proof stop gate."""
        super().__init__(MIGRATOR_ARTIFACT_PROOF_PENDING)


@dataclass(frozen=True)
class ReleaseInputs:
    """Hold validated immutable identities for one release."""

    release_sha: str
    image_ref: str
    expected_head: str

    def __post_init__(self) -> None:
        """Reject mutable or malformed release identities."""
        if GIT_SHA_PATTERN.fullmatch(self.release_sha) is None:
            raise ReleaseConfigurationError
        if (
            ALEMBIC_HEAD_PATTERN.fullmatch(self.expected_head) is None
            or self.expected_head != EXPECTED_ALEMBIC_HEAD
        ):
            raise ReleaseConfigurationError
        expected_prefix = f"{GHCR_REPOSITORY}@"
        if not self.image_ref.startswith(expected_prefix):
            raise ReleaseConfigurationError
        if (
            DIGEST_PATTERN.fullmatch(self.image_ref.removeprefix(expected_prefix))
            is None
        ):
            raise ReleaseConfigurationError

    @property
    def digest(self) -> str:
        """Return the validated registry digest."""
        return self.image_ref.split("@", maxsplit=1)[1]


@dataclass(frozen=True)
class RenderServiceIds:
    """Identify the three pre-provisioned Render services."""

    backend: str
    migrator: str
    frontend: str

    @classmethod
    def from_environment(cls, environment: Mapping[str, str]) -> Self:
        """Load and validate service IDs from repository variables."""
        backend = environment.get("RENDER_BACKEND_SERVICE_ID", "")
        migrator = environment.get("RENDER_MIGRATOR_SERVICE_ID", "")
        frontend = environment.get("RENDER_FRONTEND_SERVICE_ID", "")
        if (
            SERVER_ID_PATTERN.fullmatch(backend) is None
            or CRON_ID_PATTERN.fullmatch(migrator) is None
            or SERVER_ID_PATTERN.fullmatch(frontend) is None
            or len({backend, migrator, frontend}) != 3
        ):
            raise ReleaseConfigurationError
        return cls(backend=backend, migrator=migrator, frontend=frontend)


@dataclass(frozen=True)
class RenderEnvironment:
    """Hold Render authentication and service references without exposing secrets."""

    api_key: str = field(repr=False)
    services: RenderServiceIds

    @classmethod
    def from_environment(cls, environment: Mapping[str, str]) -> Self:
        """Load required Render values without accepting blank credentials."""
        api_key = environment.get("RENDER_API_KEY", "")
        if (
            not api_key
            or len(api_key) > 512
            or any(ord(character) < 33 or ord(character) > 126 for character in api_key)
        ):
            raise ReleaseConfigurationError
        return cls(
            api_key=api_key,
            services=RenderServiceIds.from_environment(environment),
        )


@dataclass(frozen=True)
class ReleaseStep:
    """Describe one ordered future promotion step without executing it."""

    name: str
    service_id: str
    identity: str
    environment_updates: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class ReleasePlan:
    """Describe the only allowed migrator-to-frontend release order."""

    steps: tuple[ReleaseStep, ...]


@dataclass(frozen=True)
class ServiceSnapshot:
    """Capture the non-secret Render service fields required by preflight."""

    service_id: str
    service_type: str
    runtime: str
    auto_deploy: str
    suspended: str
    image_path: str | None = None
    repository: str | None = None
    branch: str | None = None


@dataclass(frozen=True)
class PreflightReport:
    """Record successful read-only validation of all release services."""

    backend: ServiceSnapshot
    migrator: ServiceSnapshot
    frontend: ServiceSnapshot
    plan: ReleasePlan


class RenderReadClient(Protocol):
    """Define the GET-only Render API surface used before runtime proof."""

    def get_json(self, path: str) -> object:
        """Return decoded JSON for one safe Render API path."""
        ...


class UrlOpener(Protocol):
    """Define the urllib opener surface used by the API client."""

    def open(self, request: Request, timeout: float) -> object:
        """Open one HTTP request."""
        ...


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(
        self,
        request: Request,
        file_pointer: object,
        code: int,
        message: str,
        headers: object,
        new_url: str,
    ) -> Request | None:
        del request, file_pointer, code, message, headers, new_url
        return None


@dataclass(frozen=True)
class RenderApiClient:
    """Read non-secret Render service state with sanitized failure handling."""

    api_key: str = field(repr=False)
    timeout_seconds: float = 15.0
    opener: UrlOpener | None = field(default=None, repr=False, compare=False)

    def get_json(self, path: str) -> object:
        """Fetch one JSON response without following redirects or logging bodies."""
        if (
            SAFE_API_PATH_PATTERN.fullmatch(path) is None
            or ".." in path
            or path.startswith("//")
        ):
            raise RenderApiError

        try:
            request = Request(
                f"{RENDER_API_BASE_URL}{path}",
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                    "User-Agent": "roa-render-release/1",
                },
                method="GET",
            )
            opener = self.opener or build_opener(_NoRedirectHandler())
            with opener.open(request, timeout=self.timeout_seconds) as response:
                status = getattr(response, "status", None)
                headers = getattr(response, "headers", None)
                content_type = ""
                if headers is not None:
                    content_type = headers.get("Content-Type", "")
                if status != 200 or "application/json" not in content_type.lower():
                    raise RenderApiError
                body = response.read(MAX_API_RESPONSE_BYTES + 1)
        except (HTTPError, URLError, TimeoutError, OSError, ValueError):
            raise RenderApiError from None

        if len(body) > MAX_API_RESPONSE_BYTES:
            raise RenderApiError
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
            raise RenderApiError from None


def build_release_plan(
    inputs: ReleaseInputs,
    services: RenderServiceIds,
) -> ReleasePlan:
    """Build the immutable promotion order without performing network mutation."""
    return ReleasePlan(
        steps=(
            ReleaseStep(
                name="promote_migrator_artifact",
                service_id=services.migrator,
                identity=inputs.image_ref,
            ),
            ReleaseStep(
                name="run_migrations",
                service_id=services.migrator,
                identity=MIGRATION_COMMAND,
            ),
            ReleaseStep(
                name="promote_backend",
                service_id=services.backend,
                identity=inputs.image_ref,
                environment_updates=(("RELEASE_SHA", inputs.release_sha),),
            ),
            ReleaseStep(
                name="verify_backend",
                service_id=services.backend,
                identity=inputs.image_ref,
            ),
            ReleaseStep(
                name="deploy_frontend",
                service_id=services.frontend,
                identity=inputs.release_sha,
            ),
        )
    )


def require_successful_migration(status: str) -> None:
    """Allow backend promotion only after an exact successful job status."""
    if status != "succeeded":
        raise ReleasePreflightError


def require_live_deploy(status: str) -> None:
    """Allow the next promotion step only after an exact live deploy status."""
    if status != "live":
        raise ReleasePreflightError


def validate_required_check_runs(
    payloads: Mapping[str, object],
    release_sha: str,
) -> None:
    """Require one exact successful GitHub Actions check for every CI gate."""
    if GIT_SHA_PATTERN.fullmatch(release_sha) is None or set(payloads) != set(
        REQUIRED_CHECK_NAMES
    ):
        raise ReleaseConfigurationError

    for check_name in REQUIRED_CHECK_NAMES:
        payload = _config_mapping(payloads[check_name])
        check_runs = _config_list(payload.get("check_runs"))
        if payload.get("total_count") not in {1, "1"} or len(check_runs) != 1:
            raise ReleaseConfigurationError
        check_run = _config_mapping(check_runs[0])
        app = _config_mapping(check_run.get("app"))
        if (
            check_run.get("name") != check_name
            or check_run.get("head_sha") != release_sha
            or check_run.get("status") != "completed"
            or check_run.get("conclusion") != "success"
            or app.get("slug") != "github-actions"
        ):
            raise ReleaseConfigurationError


def find_alembic_heads(versions_directory: Path) -> tuple[str, ...]:
    """Read revision metadata with the standard library and return graph heads."""
    if not versions_directory.is_dir():
        raise ReleaseConfigurationError

    revisions: set[str] = set()
    parents: set[str] = set()
    for migration_path in sorted(versions_directory.glob("*.py")):
        if migration_path.name == "__init__.py":
            continue
        try:
            tree = ast.parse(migration_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, SyntaxError) as error:
            raise ReleaseConfigurationError from error
        metadata = _read_revision_metadata(tree)
        revision = metadata.get("revision")
        down_revision = metadata.get("down_revision")
        if not isinstance(revision, str) or not revision:
            raise ReleaseConfigurationError
        if revision in revisions:
            raise ReleaseConfigurationError
        revisions.add(revision)
        parents.update(_normalize_down_revisions(down_revision))

    if not revisions or not parents.issubset(revisions):
        raise ReleaseConfigurationError
    return tuple(sorted(revisions - parents))


def perform_preflight(
    client: RenderReadClient,
    environment: RenderEnvironment,
    inputs: ReleaseInputs,
) -> PreflightReport:
    """Validate service identity, image boundaries, and idle migrator state."""
    backend = _load_service(
        client,
        environment.services.backend,
        expected_type="private_service",
        expected_runtime="image",
        expected_auto_deploy=None,
    )
    migrator = _load_service(
        client,
        environment.services.migrator,
        expected_type="cron_job",
        expected_runtime="image",
        expected_auto_deploy=None,
    )
    frontend = _load_service(
        client,
        environment.services.frontend,
        expected_type="web_service",
        expected_runtime="docker",
        expected_auto_deploy="no",
    )
    if (
        _image_repository(backend.image_path) != GHCR_REPOSITORY
        or _image_repository(migrator.image_path) != GHCR_REPOSITORY
        or _normalize_git_repository(frontend.repository) != GITHUB_REPOSITORY.lower()
        or frontend.branch != "main"
    ):
        raise ReleasePreflightError

    _require_no_active_jobs(client, environment.services.migrator)
    for service_id in (
        environment.services.backend,
        environment.services.migrator,
        environment.services.frontend,
    ):
        _require_no_active_deploys(client, service_id)
    return PreflightReport(
        backend=backend,
        migrator=migrator,
        frontend=frontend,
        plan=build_release_plan(inputs, environment.services),
    )


def validate_repository_contract(
    render_config: Mapping[str, object],
    release_workflow: Mapping[str, object],
) -> None:
    """Validate the non-secret Blueprint and release-workflow security contract."""
    _validate_blueprint(render_config)
    _validate_release_workflow(release_workflow)


def parse_arguments(arguments: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse explicit immutable release inputs and the optional execute flag."""
    parser = argparse.ArgumentParser(
        description="Validate the fail-closed Render release contract."
    )
    parser.add_argument("--release-sha", required=True)
    parser.add_argument("--image-ref", required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Request mutation after every safety gate (currently runtime-gated).",
    )
    return parser.parse_args(arguments)


def main(arguments: Sequence[str] | None = None) -> int:
    """Run read-only preflight and stop execution at the runtime-proof gate."""
    namespace = parse_arguments(arguments)
    try:
        inputs = ReleaseInputs(
            release_sha=namespace.release_sha,
            image_ref=namespace.image_ref,
            expected_head=namespace.expected_head,
        )
        heads = find_alembic_heads(REPOSITORY_ROOT / "backend" / "alembic" / "versions")
        if heads != (inputs.expected_head,):
            raise ReleaseConfigurationError
        environment = RenderEnvironment.from_environment(os.environ)
        client = RenderApiClient(api_key=environment.api_key)
        report = perform_preflight(client, environment, inputs)
        print("Render release preflight passed.")
        print(f"Release SHA: {inputs.release_sha}")
        print(f"Image digest: {inputs.digest}")
        print(f"Expected Alembic head: {inputs.expected_head}")
        print(f"Planned steps: {len(report.plan.steps)}")
        if namespace.execute:
            raise ArtifactProofPendingError
        print("DRY-RUN: Render mutation count is zero.")
        return 0
    except ArtifactProofPendingError as error:
        print(str(error), file=sys.stderr)
        return 3
    except ReleaseError as error:
        print(str(error), file=sys.stderr)
        return 2


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
            raise ReleaseConfigurationError from error
    if set(metadata) != {"revision", "down_revision"}:
        raise ReleaseConfigurationError
    return metadata


def _normalize_down_revisions(value: object) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, str) and value:
        return {value}
    if (
        isinstance(value, (tuple, list))
        and value
        and all(isinstance(item, str) and item for item in value)
    ):
        return set(value)
    raise ReleaseConfigurationError


def _load_service(
    client: RenderReadClient,
    service_id: str,
    *,
    expected_type: str,
    expected_runtime: str,
    expected_auto_deploy: str | None,
) -> ServiceSnapshot:
    payload = _require_mapping(client.get_json(f"/services/{service_id}"))
    details = _require_mapping(payload.get("serviceDetails"))
    auto_deploy = payload.get("autoDeploy")
    if (
        payload.get("id") != service_id
        or payload.get("type") != expected_type
        or details.get("runtime") != expected_runtime
        or payload.get("suspended") != "not_suspended"
        or not isinstance(auto_deploy, str)
        or auto_deploy not in {"yes", "no"}
        or (expected_auto_deploy is not None and auto_deploy != expected_auto_deploy)
    ):
        raise ReleasePreflightError
    image_path = payload.get("imagePath")
    repository = payload.get("repo")
    branch = payload.get("branch")
    if image_path is not None and not isinstance(image_path, str):
        raise ReleasePreflightError
    if repository is not None and not isinstance(repository, str):
        raise ReleasePreflightError
    if branch is not None and not isinstance(branch, str):
        raise ReleasePreflightError
    return ServiceSnapshot(
        service_id=service_id,
        service_type=expected_type,
        runtime=expected_runtime,
        auto_deploy=auto_deploy,
        suspended="not_suspended",
        image_path=image_path,
        repository=repository,
        branch=branch,
    )


def _require_no_active_jobs(client: RenderReadClient, service_id: str) -> None:
    statuses = ",".join(ACTIVE_JOB_STATUSES)
    path = (
        f"/services/{service_id}/jobs?{urlencode({'status': statuses, 'limit': 100})}"
    )
    payload = _require_list(client.get_json(path))
    for item in payload:
        wrapper = _require_mapping(item)
        job = _require_mapping(wrapper.get("job"))
        if job.get("status") not in ACTIVE_JOB_STATUSES:
            raise ReleasePreflightError
    if payload:
        raise ReleasePreflightError


def _require_no_active_deploys(client: RenderReadClient, service_id: str) -> None:
    query_items = [("status", status) for status in ACTIVE_DEPLOY_STATUSES]
    query_items.append(("limit", "100"))
    path = f"/services/{service_id}/deploys?{urlencode(query_items)}"
    payload = _require_list(client.get_json(path))
    for item in payload:
        wrapper = _require_mapping(item)
        deploy = _require_mapping(wrapper.get("deploy"))
        if deploy.get("status") not in ACTIVE_DEPLOY_STATUSES:
            raise ReleasePreflightError
    if payload:
        raise ReleasePreflightError


def _require_mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise ReleasePreflightError
    return value


def _require_list(value: object) -> list[object]:
    if not isinstance(value, list):
        raise ReleasePreflightError
    return value


def _image_repository(image_path: str | None) -> str | None:
    if image_path is None:
        return None
    if image_path == BOOTSTRAP_IMAGE:
        return GHCR_REPOSITORY
    if image_path.startswith(f"{GHCR_REPOSITORY}@"):
        suffix = image_path.removeprefix(f"{GHCR_REPOSITORY}@")
        return GHCR_REPOSITORY if DIGEST_PATTERN.fullmatch(suffix) else None
    return None


def _normalize_git_repository(repository: str | None) -> str | None:
    if repository is None:
        return None
    return repository.rstrip("/").removesuffix(".git").lower()


def _validate_blueprint(config: Mapping[str, object]) -> None:
    previews = _config_mapping(config.get("previews"))
    databases = _config_list(config.get("databases"))
    services = _config_list(config.get("services"))
    if previews != {"generation": "off"} or len(databases) != 1 or len(services) != 3:
        raise ReleaseConfigurationError
    database = _config_mapping(databases[0])
    if (
        database.get("name") != "roa-production-db"
        or database.get("plan") != "basic-256mb"
        or database.get("region") != "frankfurt"
        or database.get("postgresMajorVersion") != "17"
        or database.get("ipAllowList") != []
        or database.get("connectionPool") != "none"
        or database.get("storageAutoscalingEnabled") not in {False, "false"}
    ):
        raise ReleaseConfigurationError

    by_name: dict[str, Mapping[str, object]] = {}
    for raw_service in services:
        service = _config_mapping(raw_service)
        name = service.get("name")
        if not isinstance(name, str) or name in by_name:
            raise ReleaseConfigurationError
        by_name[name] = service
    if set(by_name) != {
        "roa-production-frontend",
        "roa-production-backend",
        "roa-production-migrator",
    }:
        raise ReleaseConfigurationError

    _validate_frontend_blueprint(by_name["roa-production-frontend"])
    _validate_backend_blueprint(by_name["roa-production-backend"])
    _validate_migrator_blueprint(by_name["roa-production-migrator"])

    serialized = json.dumps(config, sort_keys=True).lower()
    if (
        "fromdatabase" in serialized
        or "connectionstring" in serialized
        or ":latest" in serialized
    ):
        raise ReleaseConfigurationError


def _validate_frontend_blueprint(service: Mapping[str, object]) -> None:
    if (
        service.get("type") != "web"
        or service.get("runtime") != "docker"
        or service.get("repo") != GITHUB_REPOSITORY
        or service.get("branch") != "main"
        or service.get("region") != "frankfurt"
        or service.get("plan") != "starter"
        or service.get("numInstances") not in {1, "1"}
        or service.get("dockerfilePath") != "./frontend/Dockerfile"
        or service.get("dockerContext") != "./frontend"
        or service.get("autoDeployTrigger") != "off"
        or service.get("healthCheckPath") != "/healthz"
    ):
        raise ReleaseConfigurationError
    env = _environment_entries(service)
    if set(env) != {"BACKEND_UPSTREAM"}:
        raise ReleaseConfigurationError
    upstream = _config_mapping(env["BACKEND_UPSTREAM"].get("fromService"))
    if upstream != {
        "type": "pserv",
        "name": "roa-production-backend",
        "property": "hostport",
    }:
        raise ReleaseConfigurationError


def _validate_backend_blueprint(service: Mapping[str, object]) -> None:
    if (
        service.get("type") != "pserv"
        or service.get("runtime") != "image"
        or service.get("region") != "frankfurt"
        or service.get("plan") != "starter"
        or service.get("numInstances") not in {1, "1"}
        or "autoDeployTrigger" in service
        or _blueprint_image_url(service) != BOOTSTRAP_IMAGE
    ):
        raise ReleaseConfigurationError
    expected_values = {
        "APP_ENVIRONMENT": "production",
        "APP_DEBUG": "false",
        "TRUSTED_PROXY_MODE": "direct",
        "AUTH_ACCESS_TOKEN_EXPIRE_MINUTES": "30",
        "STRIPE_EXPECTED_LIVEMODE": "false",
        "EXPECTED_ALEMBIC_HEAD": EXPECTED_ALEMBIC_HEAD,
        "LOG_LEVEL": "INFO",
    }
    secret_keys = {
        "DATABASE_URL",
        "AUTH_JWT_SECRET",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "PUBLIC_APP_ORIGIN",
        "TRUSTED_HOSTS",
        "STRIPE_SUCCESS_URL",
        "STRIPE_CANCEL_URL",
        "RELEASE_SHA",
    }
    env = _environment_entries(service)
    if set(env) != set(expected_values) | secret_keys:
        raise ReleaseConfigurationError
    _require_environment_values(env, expected_values, secret_keys)


def _validate_migrator_blueprint(service: Mapping[str, object]) -> None:
    if (
        service.get("type") != "cron"
        or service.get("runtime") != "image"
        or service.get("region") != "frankfurt"
        or service.get("plan") != "starter"
        or "autoDeployTrigger" in service
        or service.get("schedule") != "0 0 1 1 *"
        or service.get("dockerCommand") != "/bin/sh -c 'exit 0'"
        or _blueprint_image_url(service) != BOOTSTRAP_IMAGE
    ):
        raise ReleaseConfigurationError
    expected_values = {
        "APP_ENVIRONMENT": "production",
        "EXPECTED_ALEMBIC_HEAD": EXPECTED_ALEMBIC_HEAD,
        "MIGRATION_EXPECTED_LOGIN_ROLE": "roa_migrator",
        "MIGRATION_OWNER_ROLE": "roa_owner",
    }
    secret_keys = {"MIGRATION_DATABASE_URL"}
    env = _environment_entries(service)
    if set(env) != set(expected_values) | secret_keys:
        raise ReleaseConfigurationError
    _require_environment_values(env, expected_values, secret_keys)


def _validate_release_workflow(workflow: Mapping[str, object]) -> None:
    triggers = _config_mapping(workflow.get("on"))
    if set(triggers) != {"workflow_dispatch"}:
        raise ReleaseConfigurationError
    dispatch = _config_mapping(triggers.get("workflow_dispatch"))
    inputs = _config_mapping(dispatch.get("inputs"))
    if set(inputs) != {"release_sha", "confirm"}:
        raise ReleaseConfigurationError
    for input_name in ("release_sha", "confirm"):
        input_config = _config_mapping(inputs[input_name])
        if input_config.get("required") not in {True, "true"}:
            raise ReleaseConfigurationError
        if input_config.get("type") != "string":
            raise ReleaseConfigurationError

    permissions = _config_mapping(workflow.get("permissions"))
    if permissions != {
        "contents": "read",
        "checks": "read",
        "packages": "write",
    }:
        raise ReleaseConfigurationError

    jobs = _config_mapping(workflow.get("jobs"))
    if set(jobs) != {"release"}:
        raise ReleaseConfigurationError
    release_job = _config_mapping(jobs["release"])
    job_environment = _config_mapping(release_job.get("env"))
    if (
        job_environment.get("RELEASE_SHA") != "${{ inputs.release_sha }}"
        or job_environment.get("CONFIRM") != "${{ inputs.confirm }}"
        or job_environment.get("EXPECTED_ALEMBIC_HEAD") != EXPECTED_ALEMBIC_HEAD
        or job_environment.get("GHCR_REPOSITORY") != GHCR_REPOSITORY
    ):
        raise ReleaseConfigurationError

    steps = [_config_mapping(step) for step in _config_list(release_job.get("steps"))]
    checkout_steps = [
        step
        for step in steps
        if isinstance(step.get("uses"), str)
        and str(step["uses"]).startswith("actions/checkout@")
    ]
    if len(checkout_steps) != 1:
        raise ReleaseConfigurationError
    checkout_options = _config_mapping(checkout_steps[0].get("with"))
    if checkout_options.get(
        "ref"
    ) != "${{ inputs.release_sha }}" or checkout_options.get(
        "persist-credentials"
    ) not in {
        False,
        "false",
    }:
        raise ReleaseConfigurationError

    run_scripts = chr(10).join(
        str(step["run"]) for step in steps if isinstance(step.get("run"), str)
    )
    required_fragments = (
        'if [[ "${CONFIRM}" != "DEPLOY_STAGE20" ]]; then',
        "^[0-9a-f]{40}$",
        "git/ref/heads/main",
        "validate_required_check_runs",
        "--platform linux/amd64",
        "backend/Dockerfile",
        "containerimage.digest",
        "org.opencontainers.image.source",
        "org.opencontainers.image.revision",
        "org.opencontainers.image.version",
        "docker pull --platform linux/amd64",
        "stage20-bootstrap",
        ".github/scripts/render_release.py",
        "--execute",
    )
    if (
        any(fragment not in run_scripts for fragment in required_fragments)
        or "--build-arg" in run_scripts
    ):
        raise ReleaseConfigurationError

    serialized = json.dumps(workflow, sort_keys=True)
    lowered = serialized.lower()
    if (
        "pull_request_target" in lowered
        or ":latest" in lowered
        or "write-all" in lowered
        or "id-token" in lowered
        or "deploy_stage20" not in lowered
    ):
        raise ReleaseConfigurationError
    if any(check_name not in serialized for check_name in REQUIRED_CHECK_NAMES):
        raise ReleaseConfigurationError

    pins = _collect_mapping_values(workflow, "uses")
    if not pins or any(
        not isinstance(pin, str) or FULL_ACTION_PIN_PATTERN.fullmatch(pin) is None
        for pin in pins
    ):
        raise ReleaseConfigurationError


def _config_mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise ReleaseConfigurationError
    return value


def _config_list(value: object) -> list[object]:
    if not isinstance(value, list):
        raise ReleaseConfigurationError
    return value


def _environment_entries(
    service: Mapping[str, object],
) -> dict[str, Mapping[str, object]]:
    entries: dict[str, Mapping[str, object]] = {}
    for raw_entry in _config_list(service.get("envVars")):
        entry = _config_mapping(raw_entry)
        key = entry.get("key")
        if not isinstance(key, str) or key in entries:
            raise ReleaseConfigurationError
        entries[key] = entry
    return entries


def _require_environment_values(
    entries: Mapping[str, Mapping[str, object]],
    expected_values: Mapping[str, str],
    secret_keys: set[str],
) -> None:
    for key, expected_value in expected_values.items():
        if entries[key] != {"key": key, "value": expected_value}:
            raise ReleaseConfigurationError
    for key in secret_keys:
        if entries[key] not in (
            {"key": key, "sync": False},
            {"key": key, "sync": "false"},
        ):
            raise ReleaseConfigurationError


def _blueprint_image_url(service: Mapping[str, object]) -> str:
    image = _config_mapping(service.get("image"))
    url = image.get("url")
    if set(image) != {"url"} or not isinstance(url, str):
        raise ReleaseConfigurationError
    return url


def _collect_mapping_values(value: object, target_key: str) -> list[object]:
    matches: list[object] = []
    if isinstance(value, Mapping):
        for key, child in value.items():
            if key == target_key:
                matches.append(child)
            matches.extend(_collect_mapping_values(child, target_key))
    elif isinstance(value, list):
        for child in value:
            matches.extend(_collect_mapping_values(child, target_key))
    return matches


if __name__ == "__main__":
    raise SystemExit(main())
