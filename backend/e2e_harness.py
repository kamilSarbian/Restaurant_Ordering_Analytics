"""Isolated test-only application and data harness for browser E2E runs."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from json import JSONDecodeError
from threading import Lock
from typing import Annotated
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import HTMLResponse, Response
from pydantic import SecretStr, ValidationError
from sqlalchemy import select
from sqlalchemy.engine import URL, Engine, make_url
from sqlalchemy.exc import ArgumentError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker
from starlette.requests import ClientDisconnect

from app.auth.bootstrap import (
    AdminBootstrapConflictError,
    AdminBootstrapInputError,
    create_admin,
)
from app.auth.models import User
from app.auth.passwords import verify_password
from app.auth.roles import UserRole
from app.auth.schemas import normalize_admin_email
from app.core.config import Settings
from app.database.session import create_database_engine, create_session_factory
from app.main import create_app
from app.payments.stripe_checkout import (
    CheckoutSessionResult,
    StripeCheckoutClient,
    StripeCheckoutDefinitiveError,
    StripeCheckoutRequest,
)
from app.payments.stripe_webhook import StripeWebhookVerifier
from app.seed.runner import SeedConflictError, seed_menu_data

E2E_DATABASE_DRIVER = "postgresql+psycopg"
E2E_DATABASE_HOST = "postgres"
E2E_DATABASE_PORT = 5432
E2E_DATABASE_NAME = "restaurant_ordering_analytics_e2e"
E2E_DATABASE_USER = "e2e_app"
E2E_MODE = "isolated"
E2E_PROJECT_PREFIX = "roa-stage18-e2e-"
E2E_ADMIN_EMAIL_PREFIX = "stage18-admin-"
E2E_ADMIN_EMAIL_DOMAIN = "example.com"
DEVELOPMENT_FRONTEND_PORT = 5173
FAKE_CHECKOUT_EXPIRATION = datetime(2099, 1, 1, tzinfo=UTC)
SYNTHETIC_WEBHOOK_TOLERANCE_SECONDS = 300
SYNTHETIC_WEBHOOK_DELIVERY_TIMEOUT_SECONDS = 5.0
SYNTHETIC_WEBHOOK_URL = "http://127.0.0.1:8000/api/v1/stripe/webhook"
FAKE_CHECKOUT_PATH = "/api/v1/e2e/fake-checkout"
FAKE_CHECKOUT_SCRIPT_PATH = "/api/v1/e2e/fake-checkout.js"
FAKE_CHECKOUT_COMPLETE_PATH = "/api/v1/e2e/fake-checkout/complete"
FAKE_CHECKOUT_HANDLE_BYTES = 32

_RUN_ID_PATTERN = re.compile(r"^[a-f0-9]{16}$", re.ASCII)
_CANONICAL_PORT_PATTERN = re.compile(r"^[1-9][0-9]{3,4}$", re.ASCII)
_CONTENT_LENGTH_PATTERN = re.compile(r"^[1-9][0-9]{0,2}$", re.ASCII)
_FAKE_CHECKOUT_HANDLE_PATTERN = re.compile(
    r"^[A-Za-z0-9_-]{43}$",
    re.ASCII,
)
_SIGNATURE_HEADER_PATTERN = re.compile(
    r"^t=(0|[1-9][0-9]*),v1=([a-f0-9]{64})$",
    re.ASCII,
)

_FAKE_CHECKOUT_SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; connect-src 'self'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}
_FAKE_CHECKOUT_HTML = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Test Checkout</title>
    <script src="{FAKE_CHECKOUT_SCRIPT_PATH}" defer></script>
  </head>
  <body>
    <main>
      <h1>Test Checkout</h1>
      <p id="test-checkout-status" role="status" aria-live="polite">
        Ready to complete this isolated test payment.
      </p>
      <button id="complete-test-payment" type="button">
        Complete test payment
      </button>
    </main>
  </body>
</html>
"""
_FAKE_CHECKOUT_SCRIPT = rf"""(() => {{
  'use strict';

  const handlePattern = /^[A-Za-z0-9_-]{{43}}$/u;
  const successPathPattern =
    /^\/orders\/ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{{12}}\/payment-return$/u;
  const button = document.getElementById('complete-test-payment');
  const statusMessage = document.getElementById('test-checkout-status');
  const fragment = window.location.hash.slice(1);
  window.history.replaceState(null, '', window.location.pathname);
  let checkoutHandle = handlePattern.test(fragment) ? fragment : null;

  if (!(button instanceof HTMLButtonElement) || statusMessage === null) {{
    throw new Error('E2E_CHECKOUT_DOCUMENT_INVALID');
  }}
  if (checkoutHandle === null) {{
    button.disabled = true;
    statusMessage.textContent = 'Test checkout is unavailable.';
    return;
  }}

  button.addEventListener('click', async () => {{
    const submittedHandle = checkoutHandle;
    if (submittedHandle === null) {{
      return;
    }}
    checkoutHandle = null;
    button.disabled = true;
    statusMessage.textContent = 'Completing test payment\u2026';

    try {{
      const response = await window.fetch('{FAKE_CHECKOUT_COMPLETE_PATH}', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ checkout_handle: submittedHandle }}),
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }});
      if (!response.ok) {{
        throw new Error('E2E_CHECKOUT_COMPLETION_FAILED');
      }}

      const result = await response.json();
      const keys = Object.keys(result).sort();
      if (
        keys.length !== 2 ||
        keys[0] !== 'completed' ||
        keys[1] !== 'success_url' ||
        result.completed !== true ||
        typeof result.success_url !== 'string'
      ) {{
        throw new Error('E2E_CHECKOUT_RESPONSE_INVALID');
      }}
      const successUrl = new URL(result.success_url);
      if (
        successUrl.origin !== window.location.origin ||
        !successPathPattern.test(successUrl.pathname) ||
        successUrl.search !== '' ||
        successUrl.hash !== ''
      ) {{
        throw new Error('E2E_CHECKOUT_REDIRECT_INVALID');
      }}

      statusMessage.textContent = 'Payment completed. Redirecting\u2026';
      window.location.assign(successUrl.href);
    }} catch (_error) {{
      checkoutHandle = submittedHandle;
      button.disabled = false;
      statusMessage.textContent = 'Test payment could not be completed.';
    }}
  }});
}})();
"""


class E2EHarnessError(Exception):
    """Report a sanitized test-harness failure."""


class E2EHarnessSafetyError(E2EHarnessError):
    """Report a rejected environment or database target."""


class E2EHarnessSetupError(E2EHarnessError):
    """Report a deterministic setup failure without sensitive context."""


@dataclass(frozen=True, slots=True)
class E2ERuntimeContract:
    """Carry validated non-production runtime configuration."""

    run_id: str
    project_name: str
    frontend_port: int
    public_origin: str
    database_url: URL = field(repr=False)
    auth_jwt_secret: SecretStr = field(repr=False)
    stripe_webhook_secret: SecretStr = field(repr=False)


@dataclass(frozen=True, slots=True)
class E2ESetupContract:
    """Carry runtime configuration plus one synthetic administrator identity."""

    runtime: E2ERuntimeContract
    admin_email: str = field(repr=False)
    admin_password: SecretStr = field(repr=False)


@dataclass(frozen=True, slots=True)
class E2ESetupResult:
    """Summarize deterministic setup without exposing identity or credentials."""

    categories_processed: int
    menu_items_processed: int
    administrator_ready: bool


class _E2EFakeCheckoutNotFoundError(E2EHarnessError):
    """Report an unknown synthetic Checkout handle."""


class _E2EFakeCheckoutExpiredError(E2EHarnessError):
    """Report an expired synthetic Checkout handle."""


class _E2EFakeCheckoutDeliveryError(E2EHarnessError):
    """Report a sanitized local webhook delivery failure."""


@dataclass(frozen=True, slots=True)
class _E2ERegisteredCheckout:
    """Hold trusted provider facts that never cross the browser boundary."""

    handle: str = field(repr=False)
    request: StripeCheckoutRequest = field(repr=False)
    session_id: str = field(repr=False)
    event_id: str = field(repr=False)
    expires_at: datetime


class _E2EFakeCheckoutRegistry:
    """Store isolated Checkout facts for one application process."""

    def __init__(
        self,
        *,
        token_factory: Callable[[int], str] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._token_factory = token_factory or secrets.token_urlsafe
        self._clock = clock
        self._records: dict[str, _E2ERegisteredCheckout] = {}
        self._records_by_idempotency_key: dict[str, _E2ERegisteredCheckout] = {}
        self._lock = Lock()

    def register(self, request: StripeCheckoutRequest) -> _E2ERegisteredCheckout:
        """Register trusted Checkout facts under a random opaque handle."""
        if self._clock() >= FAKE_CHECKOUT_EXPIRATION.timestamp():
            raise StripeCheckoutDefinitiveError(
                "Synthetic Checkout could not allocate a session"
            )

        with self._lock:
            existing_record = self._records_by_idempotency_key.get(
                request.stripe_idempotency_key
            )
            if existing_record is not None:
                if existing_record.request != request:
                    raise StripeCheckoutDefinitiveError(
                        "Synthetic Checkout rejected conflicting idempotency"
                    )
                return existing_record

            for _attempt in range(8):
                try:
                    handle = self._token_factory(FAKE_CHECKOUT_HANDLE_BYTES)
                except (OSError, TypeError, ValueError):
                    break
                if _FAKE_CHECKOUT_HANDLE_PATTERN.fullmatch(handle) is None:
                    continue
                if handle in self._records:
                    continue
                handle_digest = hashlib.sha256(handle.encode("ascii")).hexdigest()
                record = _E2ERegisteredCheckout(
                    handle=handle,
                    request=request,
                    session_id=f"cs_test_e2e_{handle_digest}",
                    event_id=f"evt_test_e2e_{handle_digest[:32]}",
                    expires_at=FAKE_CHECKOUT_EXPIRATION,
                )
                self._records[handle] = record
                self._records_by_idempotency_key[request.stripe_idempotency_key] = (
                    record
                )
                return record

        raise StripeCheckoutDefinitiveError(
            "Synthetic Checkout could not allocate a session"
        )

    def resolve(self, handle: str) -> _E2ERegisteredCheckout:
        """Resolve a live opaque handle without accepting browser facts."""
        if _FAKE_CHECKOUT_HANDLE_PATTERN.fullmatch(handle) is None:
            raise _E2EFakeCheckoutNotFoundError("E2E_CHECKOUT_NOT_FOUND")
        with self._lock:
            record = self._records.get(handle)
        if record is None:
            raise _E2EFakeCheckoutNotFoundError("E2E_CHECKOUT_NOT_FOUND")
        if self._clock() >= record.expires_at.timestamp():
            raise _E2EFakeCheckoutExpiredError("E2E_CHECKOUT_EXPIRED")
        return record


class E2EFakeStripeCheckoutClient(StripeCheckoutClient):
    """Register a same-origin fake Checkout result without network I/O."""

    def __init__(
        self,
        public_origin: str,
        registry: _E2EFakeCheckoutRegistry | None = None,
    ) -> None:
        """Configure the exact loopback origin and process-local registry."""
        self._public_origin = public_origin
        self._registry = registry or _E2EFakeCheckoutRegistry()

    def create_checkout_session(
        self,
        request: StripeCheckoutRequest,
    ) -> CheckoutSessionResult:
        """Return an opaque fragment URL for one validated payment attempt."""
        expected_success_url = (
            f"{self._public_origin}/orders/"
            f"{request.public_order_number}/payment-return"
        )
        expected_cancel_url = (
            f"{self._public_origin}/orders/"
            f"{request.public_order_number}/checkout-cancelled"
        )
        if (
            request.success_url != expected_success_url
            or request.cancel_url != expected_cancel_url
        ):
            raise StripeCheckoutDefinitiveError(
                "Synthetic Checkout rejected an unsafe redirect"
            )

        record = self._registry.register(request)
        return CheckoutSessionResult(
            session_id=record.session_id,
            checkout_url=(f"{self._public_origin}{FAKE_CHECKOUT_PATH}#{record.handle}"),
            expires_at=record.expires_at,
        )


class E2ESyntheticStripeWebhookVerifier(StripeWebhookVerifier):
    """Verify registry-bound local callbacks without provider traffic."""

    def __init__(
        self,
        webhook_secret: SecretStr,
        registry: _E2EFakeCheckoutRegistry,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        """Configure local verification against trusted registered facts."""
        self._e2e_clock = clock
        self._registry = registry
        super().__init__(
            webhook_secret,
            tolerance_seconds=SYNTHETIC_WEBHOOK_TOLERANCE_SECONDS,
            construct_event=self._construct_synthetic_event,
        )

    def _construct_synthetic_event(
        self,
        payload: bytes,
        signature_header: str,
        webhook_secret: str,
        *,
        tolerance: int,
    ) -> object:
        match = _SIGNATURE_HEADER_PATTERN.fullmatch(signature_header)
        if match is None:
            raise ValueError("Synthetic webhook signature is invalid")

        timestamp = int(match.group(1))
        if abs(self._e2e_clock() - timestamp) > tolerance:
            raise ValueError("Synthetic webhook signature is invalid")

        expected_signature = _synthetic_webhook_digest(
            payload,
            webhook_secret=webhook_secret,
            timestamp=timestamp,
        )
        if not hmac.compare_digest(match.group(2), expected_signature):
            raise ValueError("Synthetic webhook signature is invalid")

        try:
            parsed_payload = json.loads(payload)
            if not isinstance(parsed_payload, dict):
                raise ValueError("Synthetic webhook payload is invalid")
            handle = parsed_payload.get("e2e_checkout_handle")
            if not isinstance(handle, str):
                raise ValueError("Synthetic webhook payload is invalid")
            record = self._registry.resolve(handle)
            expected_payload = _synthetic_checkout_event_payload(
                record,
                timestamp=timestamp,
            )
            if not hmac.compare_digest(payload, expected_payload):
                raise ValueError("Synthetic webhook payload is invalid")
            return parsed_payload
        except (
            JSONDecodeError,
            UnicodeDecodeError,
            _E2EFakeCheckoutExpiredError,
            _E2EFakeCheckoutNotFoundError,
        ) as exc:
            raise ValueError("Synthetic webhook payload is invalid") from exc


WebhookDeliveryOperation = Callable[[bytes, str], int]


@dataclass(frozen=True, slots=True)
class _E2EFakeCheckoutCompletion:
    """Carry the only safe facts returned to the synthetic Checkout page."""

    success_url: str


class _E2EFakeCheckoutCoordinator:
    """Create and deliver trusted callbacks for one local Checkout registry."""

    def __init__(
        self,
        registry: _E2EFakeCheckoutRegistry,
        webhook_secret: SecretStr,
        *,
        delivery_operation: WebhookDeliveryOperation | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._registry = registry
        self._webhook_secret = webhook_secret
        self._delivery_operation = delivery_operation or _deliver_synthetic_webhook
        self._clock = clock

    def complete(self, handle: str) -> _E2EFakeCheckoutCompletion:
        """Deliver the same trusted event twice and retain it for safe replay."""
        record = self._registry.resolve(handle)
        timestamp = int(self._clock())
        payload = _synthetic_checkout_event_payload(record, timestamp=timestamp)
        try:
            signature = sign_synthetic_webhook_payload(
                payload,
                webhook_secret=self._webhook_secret,
                timestamp=timestamp,
            )
            for _delivery_number in range(2):
                response_status = self._delivery_operation(payload, signature)
                if (
                    isinstance(response_status, bool)
                    or not isinstance(response_status, int)
                    or response_status < 200
                    or response_status >= 300
                ):
                    raise _E2EFakeCheckoutDeliveryError("E2E_WEBHOOK_DELIVERY_FAILED")
        except (
            E2EHarnessSafetyError,
            HTTPError,
            OSError,
            TimeoutError,
            TypeError,
            URLError,
            ValueError,
        ):
            raise _E2EFakeCheckoutDeliveryError("E2E_WEBHOOK_DELIVERY_FAILED") from None

        return _E2EFakeCheckoutCompletion(success_url=record.request.success_url)


def validate_e2e_database_url(
    database_url: str,
    *,
    expected_password: SecretStr,
) -> URL:
    """Validate the exact private PostgreSQL target for an isolated E2E run.

    Args:
        database_url: Candidate SQLAlchemy database URL.
        expected_password: Synthetic password supplied independently by the run.

    Returns:
        The parsed exact E2E PostgreSQL URL.

    Raises:
        E2EHarnessSafetyError: If any target or credential field differs.
    """
    try:
        parsed_url = make_url(database_url)
    except (ArgumentError, TypeError, ValueError):
        raise E2EHarnessSafetyError("E2E_DATABASE_TARGET_INVALID") from None

    configured_password = parsed_url.password
    expected_raw_password = expected_password.get_secret_value()
    password_matches = (
        isinstance(configured_password, str)
        and bool(configured_password)
        and hmac.compare_digest(configured_password, expected_raw_password)
    )
    if (
        parsed_url.drivername != E2E_DATABASE_DRIVER
        or parsed_url.host != E2E_DATABASE_HOST
        or parsed_url.port != E2E_DATABASE_PORT
        or parsed_url.database != E2E_DATABASE_NAME
        or parsed_url.username != E2E_DATABASE_USER
        or not password_matches
        or bool(parsed_url.query)
    ):
        raise E2EHarnessSafetyError("E2E_DATABASE_TARGET_INVALID")

    return parsed_url


def load_e2e_runtime_contract(
    environment: Mapping[str, str] | None = None,
) -> E2ERuntimeContract:
    """Load and validate the fail-closed process environment for E2E runtime."""
    source = os.environ if environment is None else environment
    if _required_environment_value(source, "E2E_MODE") != E2E_MODE:
        raise E2EHarnessSafetyError("E2E_MODE_INVALID")

    run_id = _required_environment_value(source, "E2E_RUN_ID")
    if _RUN_ID_PATTERN.fullmatch(run_id) is None:
        raise E2EHarnessSafetyError("E2E_RUN_ID_INVALID")

    project_name = _required_environment_value(source, "E2E_PROJECT_NAME")
    if project_name != f"{E2E_PROJECT_PREFIX}{run_id}":
        raise E2EHarnessSafetyError("E2E_PROJECT_NAME_INVALID")

    frontend_port_text = _required_environment_value(source, "E2E_FRONTEND_PORT")
    if _CANONICAL_PORT_PATTERN.fullmatch(frontend_port_text) is None:
        raise E2EHarnessSafetyError("E2E_FRONTEND_PORT_INVALID")
    frontend_port = int(frontend_port_text)
    if frontend_port > 65_535 or frontend_port == DEVELOPMENT_FRONTEND_PORT:
        raise E2EHarnessSafetyError("E2E_FRONTEND_PORT_INVALID")

    public_origin = _required_environment_value(source, "E2E_PUBLIC_ORIGIN")
    if public_origin != f"http://127.0.0.1:{frontend_port}":
        raise E2EHarnessSafetyError("E2E_PUBLIC_ORIGIN_INVALID")

    postgres_password = _required_secret(source, "E2E_POSTGRES_PASSWORD")
    database_url = validate_e2e_database_url(
        _required_environment_value(source, "DATABASE_URL"),
        expected_password=postgres_password,
    )
    auth_jwt_secret = _required_secret(source, "E2E_AUTH_JWT_SECRET")
    if len(auth_jwt_secret.get_secret_value().encode("utf-8")) < 32:
        raise E2EHarnessSafetyError("E2E_AUTH_JWT_SECRET_INVALID")
    stripe_webhook_secret = _required_secret(
        source,
        "E2E_STRIPE_WEBHOOK_SECRET",
    )
    if len(stripe_webhook_secret.get_secret_value().encode("utf-8")) < 32:
        raise E2EHarnessSafetyError("E2E_STRIPE_WEBHOOK_SECRET_INVALID")

    return E2ERuntimeContract(
        run_id=run_id,
        project_name=project_name,
        frontend_port=frontend_port,
        public_origin=public_origin,
        database_url=database_url,
        auth_jwt_secret=auth_jwt_secret,
        stripe_webhook_secret=stripe_webhook_secret,
    )


def load_e2e_setup_contract(
    environment: Mapping[str, str] | None = None,
) -> E2ESetupContract:
    """Load the runtime contract plus exact synthetic administrator inputs."""
    source = os.environ if environment is None else environment
    runtime = load_e2e_runtime_contract(source)
    admin_email = _required_environment_value(source, "E2E_ADMIN_EMAIL")
    expected_admin_email = (
        f"{E2E_ADMIN_EMAIL_PREFIX}{runtime.run_id}@{E2E_ADMIN_EMAIL_DOMAIN}"
    )
    try:
        normalized_admin_email = normalize_admin_email(admin_email)
    except ValueError:
        raise E2EHarnessSafetyError("E2E_ADMIN_EMAIL_INVALID") from None
    if admin_email != expected_admin_email or normalized_admin_email != admin_email:
        raise E2EHarnessSafetyError("E2E_ADMIN_EMAIL_INVALID")

    admin_password = _required_secret(source, "E2E_ADMIN_PASSWORD")
    password_length = len(admin_password.get_secret_value())
    if password_length < 15 or password_length > 128:
        raise E2EHarnessSafetyError("E2E_ADMIN_PASSWORD_INVALID")

    return E2ESetupContract(
        runtime=runtime,
        admin_email=admin_email,
        admin_password=admin_password,
    )


def create_e2e_app(
    *,
    webhook_delivery_operation: WebhookDeliveryOperation | None = None,
    token_factory: Callable[[int], str] | None = None,
    clock: Callable[[], float] = time.time,
) -> FastAPI:
    """Create the guarded application with process-local fake Stripe seams.

    Args:
        webhook_delivery_operation: Optional local HTTP delivery seam for tests.
        token_factory: Optional opaque-handle generator used only by unit tests.
        clock: Wall clock shared by handle expiry and callback verification.

    Returns:
        The isolated E2E FastAPI application.
    """
    contract = load_e2e_runtime_contract()
    settings = Settings(
        _env_file=None,
        app_environment="e2e",
        app_debug=False,
        database_url=contract.database_url.render_as_string(hide_password=False),
        stripe_secret_key=None,
        stripe_webhook_secret=None,
        stripe_success_url=(
            f"{contract.public_origin}/orders/" "{public_order_number}/payment-return"
        ),
        stripe_cancel_url=(
            f"{contract.public_origin}/orders/"
            "{public_order_number}/checkout-cancelled"
        ),
        auth_jwt_secret=contract.auth_jwt_secret,
        auth_access_token_expire_minutes=30,
    )
    registry = _E2EFakeCheckoutRegistry(
        token_factory=token_factory,
        clock=clock,
    )
    checkout_client = E2EFakeStripeCheckoutClient(
        contract.public_origin,
        registry,
    )
    webhook_verifier = E2ESyntheticStripeWebhookVerifier(
        contract.stripe_webhook_secret,
        registry,
        clock=clock,
    )
    checkout_coordinator = _E2EFakeCheckoutCoordinator(
        registry,
        contract.stripe_webhook_secret,
        delivery_operation=webhook_delivery_operation,
        clock=clock,
    )
    application = create_app(
        settings=settings,
        stripe_checkout_client=checkout_client,
        stripe_webhook_verifier=webhook_verifier,
    )
    application.state.e2e_fake_checkout_registry = registry
    application.state.e2e_fake_checkout_coordinator = checkout_coordinator
    application.state.e2e_public_origin = contract.public_origin
    _register_fake_checkout_routes(application)
    return application


def _register_fake_checkout_routes(application: FastAPI) -> None:
    application.add_api_route(
        FAKE_CHECKOUT_PATH,
        _serve_fake_checkout_page,
        methods=["GET"],
        include_in_schema=False,
        response_class=HTMLResponse,
    )
    application.add_api_route(
        FAKE_CHECKOUT_SCRIPT_PATH,
        _serve_fake_checkout_script,
        methods=["GET"],
        include_in_schema=False,
        response_class=Response,
    )
    application.add_api_route(
        FAKE_CHECKOUT_COMPLETE_PATH,
        _complete_fake_checkout,
        methods=["POST"],
        include_in_schema=False,
    )


def _serve_fake_checkout_page() -> HTMLResponse:
    """Serve one static CSP-restricted local Checkout page."""
    return HTMLResponse(
        _FAKE_CHECKOUT_HTML,
        headers=_FAKE_CHECKOUT_SECURITY_HEADERS,
    )


def _serve_fake_checkout_script() -> Response:
    """Serve the external script without embedding any registered facts."""
    return Response(
        _FAKE_CHECKOUT_SCRIPT,
        media_type="application/javascript",
        headers=_FAKE_CHECKOUT_SECURITY_HEADERS,
    )


async def _read_fake_checkout_handle(request: Request) -> str:
    """Read one canonical handle-only browser request without reflection."""
    if (
        request.headers.get("Origin") != request.app.state.e2e_public_origin
        or request.headers.get("Content-Type") != "application/json"
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid test checkout request",
        )

    content_length_text = request.headers.get("Content-Length")
    if (
        content_length_text is None
        or _CONTENT_LENGTH_PATTERN.fullmatch(content_length_text) is None
        or int(content_length_text) > 128
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid test checkout request",
        )
    try:
        payload = await request.body()
    except ClientDisconnect:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid test checkout request",
        ) from None
    if len(payload) != int(content_length_text):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid test checkout request",
        )

    try:
        decoded_payload = json.loads(payload)
    except (JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid test checkout request",
        ) from None
    if not isinstance(decoded_payload, dict) or set(decoded_payload) != {
        "checkout_handle"
    }:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid test checkout request",
        )
    checkout_handle = decoded_payload.get("checkout_handle")
    if (
        not isinstance(checkout_handle, str)
        or _FAKE_CHECKOUT_HANDLE_PATTERN.fullmatch(checkout_handle) is None
        or not hmac.compare_digest(
            payload,
            _fake_checkout_completion_payload(checkout_handle),
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid test checkout request",
        )
    return checkout_handle


def _complete_fake_checkout(
    request: Request,
    checkout_handle: Annotated[str, Depends(_read_fake_checkout_handle)],
) -> dict[str, bool | str]:
    """Synchronously deliver two local webhooks for a live opaque handle."""
    coordinator: _E2EFakeCheckoutCoordinator = (
        request.app.state.e2e_fake_checkout_coordinator
    )
    try:
        completion = coordinator.complete(checkout_handle)
    except _E2EFakeCheckoutNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Test checkout not found",
        ) from None
    except _E2EFakeCheckoutExpiredError:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Test checkout expired",
        ) from None
    except _E2EFakeCheckoutDeliveryError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Test payment could not be completed",
        ) from None

    return {"completed": True, "success_url": completion.success_url}


def setup_e2e_data() -> E2ESetupResult:
    """Seed menu data and ensure the exact synthetic super-administrator.

    Returns:
        A safe setup summary without identities or connection details.

    Raises:
        E2EHarnessSetupError: If seeding or administrator setup cannot converge.
    """
    resolved_contract = load_e2e_setup_contract()
    engine: Engine | None = None
    try:
        engine = create_database_engine(
            resolved_contract.runtime.database_url.render_as_string(hide_password=False)
        )
        session_factory = create_session_factory(engine)
        seed_result = seed_menu_data(session_factory)
        _ensure_synthetic_admin(session_factory, resolved_contract)
    except (
        AdminBootstrapInputError,
        OSError,
        SeedConflictError,
        SQLAlchemyError,
    ):
        raise E2EHarnessSetupError("E2E_SETUP_FAILED") from None
    finally:
        if engine is not None:
            try:
                engine.dispose()
            except (OSError, SQLAlchemyError):
                raise E2EHarnessSetupError("E2E_SETUP_CLEANUP_FAILED") from None

    return E2ESetupResult(
        categories_processed=seed_result.categories_processed,
        menu_items_processed=seed_result.menu_items_processed,
        administrator_ready=True,
    )


def sign_synthetic_webhook_payload(
    payload: bytes,
    *,
    webhook_secret: SecretStr,
    timestamp: int,
) -> str:
    """Sign exact callback bytes for the local synthetic webhook verifier."""
    if isinstance(timestamp, bool) or timestamp < 0:
        raise E2EHarnessSafetyError("E2E_WEBHOOK_TIMESTAMP_INVALID")
    digest = _synthetic_webhook_digest(
        payload,
        webhook_secret=webhook_secret.get_secret_value(),
        timestamp=timestamp,
    )
    return f"t={timestamp},v1={digest}"


def main(argv: Sequence[str] | None = None) -> int:
    """Run the explicit guarded E2E setup command."""
    parser = argparse.ArgumentParser(description="Manage isolated browser E2E data.")
    parser.add_argument("command", choices=("setup",))
    arguments = parser.parse_args(argv)

    if arguments.command != "setup":
        raise E2EHarnessSafetyError("E2E_COMMAND_INVALID")
    try:
        result = setup_e2e_data()
    except (E2EHarnessError, OSError, SQLAlchemyError, ValidationError):
        print("E2E setup failed.", file=sys.stderr)
        return 1

    print(
        "E2E setup complete: "
        f"{result.categories_processed} categories and "
        f"{result.menu_items_processed} menu items ready."
    )
    return 0


def _required_environment_value(
    environment: Mapping[str, str],
    name: str,
) -> str:
    value = environment.get(name)
    if value is None or not value or value.strip() != value:
        raise E2EHarnessSafetyError("E2E_ENVIRONMENT_INVALID")
    return value


def _required_secret(
    environment: Mapping[str, str],
    name: str,
) -> SecretStr:
    value = _required_environment_value(environment, name)
    if not value.strip():
        raise E2EHarnessSafetyError("E2E_ENVIRONMENT_INVALID")
    return SecretStr(value)


def _ensure_synthetic_admin(
    session_factory: sessionmaker[Session],
    contract: E2ESetupContract,
) -> None:
    password = contract.admin_password.get_secret_value()
    try:
        with session_factory() as session:
            create_admin(
                session,
                email=contract.admin_email,
                password=password,
            )
        return
    except AdminBootstrapConflictError:
        pass

    try:
        with session_factory() as session:
            administrators = list(
                session.scalars(
                    select(User)
                    .where(User.role == UserRole.SUPER_ADMIN)
                    .order_by(User.id.asc())
                ).all()
            )
    except SQLAlchemyError:
        raise E2EHarnessSetupError("E2E_ADMIN_SETUP_FAILED") from None

    if len(administrators) != 1:
        raise E2EHarnessSetupError("E2E_ADMIN_SETUP_FAILED")
    administrator = administrators[0]
    if (
        not administrator.is_active
        or administrator.email != contract.admin_email
        or not verify_password(password, administrator.password_hash)
    ):
        raise E2EHarnessSetupError("E2E_ADMIN_SETUP_FAILED")


def _fake_checkout_completion_payload(handle: str) -> bytes:
    return json.dumps(
        {"checkout_handle": handle},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _synthetic_checkout_event_payload(
    record: _E2ERegisteredCheckout,
    *,
    timestamp: int,
) -> bytes:
    request = record.request
    event = {
        "data": {
            "object": {
                "amount_total": request.amount,
                "currency": request.currency.lower(),
                "id": record.session_id,
                "metadata": {
                    "order_id": str(request.order_id),
                    "payment_id": str(request.payment_id),
                    "public_order_number": request.public_order_number,
                },
                "mode": "payment",
                "payment_status": "paid",
                "status": "complete",
            }
        },
        "e2e_checkout_handle": record.handle,
        "id": record.event_id,
        "livemode": False,
        "type": "checkout.session.completed",
        "created": timestamp,
    }
    return json.dumps(event, sort_keys=True, separators=(",", ":")).encode("utf-8")


class _RejectRedirectHandler(urllib_request.HTTPRedirectHandler):
    """Prevent a local webhook request from following any redirect."""

    def redirect_request(
        self,
        request: urllib_request.Request,
        file_pointer: object,
        code: int,
        message: str,
        headers: object,
        new_url: str,
    ) -> None:
        """Reject every redirect without inspecting its untrusted destination."""
        return None


def _deliver_synthetic_webhook(payload: bytes, signature_header: str) -> int:
    request = urllib_request.Request(
        SYNTHETIC_WEBHOOK_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Stripe-Signature": signature_header,
        },
        method="POST",
    )
    opener = urllib_request.build_opener(
        urllib_request.ProxyHandler({}),
        _RejectRedirectHandler(),
    )
    try:
        with opener.open(
            request,
            timeout=SYNTHETIC_WEBHOOK_DELIVERY_TIMEOUT_SECONDS,
        ) as response:
            response_status = response.getcode()
            final_url = response.geturl()
    except (HTTPError, OSError, TimeoutError, URLError, ValueError):
        raise _E2EFakeCheckoutDeliveryError("E2E_WEBHOOK_DELIVERY_FAILED") from None
    if (
        isinstance(response_status, bool)
        or not isinstance(response_status, int)
        or response_status < 200
        or response_status >= 300
        or final_url != SYNTHETIC_WEBHOOK_URL
    ):
        raise _E2EFakeCheckoutDeliveryError("E2E_WEBHOOK_DELIVERY_FAILED")
    return response_status


def _synthetic_webhook_digest(
    payload: bytes,
    *,
    webhook_secret: str,
    timestamp: int,
) -> str:
    signed_payload = str(timestamp).encode("ascii") + b"." + payload
    return hmac.new(
        webhook_secret.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "E2EFakeStripeCheckoutClient",
    "E2EHarnessError",
    "E2EHarnessSafetyError",
    "E2EHarnessSetupError",
    "E2ERuntimeContract",
    "E2ESetupContract",
    "E2ESetupResult",
    "E2ESyntheticStripeWebhookVerifier",
    "create_e2e_app",
    "load_e2e_runtime_contract",
    "load_e2e_setup_contract",
    "main",
    "setup_e2e_data",
    "sign_synthetic_webhook_payload",
    "validate_e2e_database_url",
]
