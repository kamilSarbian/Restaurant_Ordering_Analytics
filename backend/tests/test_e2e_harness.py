"""Deterministic tests for the isolated browser-E2E backend harness."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from threading import Lock
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock
from urllib.parse import urlsplit
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy.engine import URL

import e2e_harness as harness
from app.payments import stripe_checkout as stripe_checkout_module
from app.payments import stripe_webhook as stripe_webhook_module
from app.payments.stripe_checkout import (
    StripeCheckoutDefinitiveError,
    StripeCheckoutRequest,
)
from app.payments.stripe_webhook import (
    StripeWebhookEventType,
    StripeWebhookVerificationError,
    VerifiedStripeCheckoutEvent,
)
from app.seed.runner import SeedConflictError, SeedResult

RUN_ID = "a1b2c3d4e5f60718"
PROJECT_NAME = f"roa-stage18-e2e-{RUN_ID}"
FRONTEND_PORT = 15180
PUBLIC_ORIGIN = f"http://127.0.0.1:{FRONTEND_PORT}"
POSTGRES_PASSWORD = "test-only-postgres-" + ("p" * 24)
AUTH_JWT_SECRET = "test-only-auth-" + ("a" * 32)
WEBHOOK_SECRET = "test-only-webhook-" + ("w" * 32)
ADMIN_EMAIL = f"stage18-admin-{RUN_ID}@example.com"
ADMIN_PASSWORD = "test-only-admin-password"
ORDER_ID = UUID("12345678-1234-4234-9234-1234567890ab")
PAYMENT_ID = UUID("abcdefab-cdef-4def-8def-abcdefabcdef")
PUBLIC_ORDER_NUMBER = "ROA-23456789ABCD"
OPAQUE_HANDLE = "A" * 43
WEBHOOK_TIMESTAMP = 1_787_400_000


def _database_url(
    *,
    drivername: str = harness.E2E_DATABASE_DRIVER,
    username: str = harness.E2E_DATABASE_USER,
    password: str = POSTGRES_PASSWORD,
    host: str = harness.E2E_DATABASE_HOST,
    port: int = harness.E2E_DATABASE_PORT,
    database: str = harness.E2E_DATABASE_NAME,
    query: dict[str, str] | None = None,
) -> str:
    return URL.create(
        drivername=drivername,
        username=username,
        password=password,
        host=host,
        port=port,
        database=database,
        query=query,
    ).render_as_string(hide_password=False)


def _runtime_environment() -> dict[str, str]:
    return {
        "E2E_MODE": harness.E2E_MODE,
        "E2E_RUN_ID": RUN_ID,
        "E2E_PROJECT_NAME": PROJECT_NAME,
        "E2E_FRONTEND_PORT": str(FRONTEND_PORT),
        "E2E_PUBLIC_ORIGIN": PUBLIC_ORIGIN,
        "E2E_POSTGRES_PASSWORD": POSTGRES_PASSWORD,
        "E2E_AUTH_JWT_SECRET": AUTH_JWT_SECRET,
        "E2E_STRIPE_WEBHOOK_SECRET": WEBHOOK_SECRET,
        "DATABASE_URL": _database_url(),
    }


def _setup_environment() -> dict[str, str]:
    return {
        **_runtime_environment(),
        "E2E_ADMIN_EMAIL": ADMIN_EMAIL,
        "E2E_ADMIN_PASSWORD": ADMIN_PASSWORD,
    }


def _runtime_contract() -> harness.E2ERuntimeContract:
    return harness.load_e2e_runtime_contract(_runtime_environment())


def _setup_contract() -> harness.E2ESetupContract:
    return harness.load_e2e_setup_contract(_setup_environment())


def _checkout_request(
    *,
    success_url: str | None = None,
    cancel_url: str | None = None,
) -> StripeCheckoutRequest:
    public_order_number = PUBLIC_ORDER_NUMBER
    return StripeCheckoutRequest(
        amount=2500,
        currency="NOK",
        public_order_number=public_order_number,
        order_id=ORDER_ID,
        payment_id=PAYMENT_ID,
        success_url=(
            success_url
            or f"{PUBLIC_ORIGIN}/orders/{public_order_number}/payment-return"
        ),
        cancel_url=(
            cancel_url
            or f"{PUBLIC_ORIGIN}/orders/{public_order_number}/checkout-cancelled"
        ),
        stripe_idempotency_key=f"checkout-session:{PAYMENT_ID}",
    )


def _registered_checkout(
    *,
    clock: Mock | None = None,
) -> tuple[
    harness._E2EFakeCheckoutRegistry,
    harness._E2ERegisteredCheckout,
]:
    resolved_clock = clock or Mock(return_value=float(WEBHOOK_TIMESTAMP))
    registry = harness._E2EFakeCheckoutRegistry(
        token_factory=Mock(return_value=OPAQUE_HANDLE),
        clock=resolved_clock,
    )
    record = registry.register(_checkout_request())
    return registry, record


def _route_application(
    monkeypatch: pytest.MonkeyPatch,
    delivery_operation: Mock,
    *,
    clock: Mock | None = None,
) -> FastAPI:
    resolved_clock = clock or Mock(return_value=float(WEBHOOK_TIMESTAMP))
    monkeypatch.setattr(
        harness,
        "load_e2e_runtime_contract",
        Mock(return_value=_runtime_contract()),
    )
    return harness.create_e2e_app(
        webhook_delivery_operation=delivery_operation,
        token_factory=Mock(return_value=OPAQUE_HANDLE),
        clock=resolved_clock,
    )


@contextmanager
def _session_context(session: object):
    yield session


def test_validate_e2e_database_url_accepts_only_the_exact_target() -> None:
    parsed_url = harness.validate_e2e_database_url(
        _database_url(),
        expected_password=SecretStr(POSTGRES_PASSWORD),
    )

    assert parsed_url.drivername == "postgresql+psycopg"
    assert parsed_url.host == "postgres"
    assert parsed_url.port == 5432
    assert parsed_url.database == "restaurant_ordering_analytics_e2e"
    assert parsed_url.username == "e2e_app"


@pytest.mark.parametrize(
    "candidate",
    [
        _database_url(host="localhost"),
        _database_url(host="127.0.0.1"),
        _database_url(port=5433),
        _database_url(database="restaurant_ordering_analytics"),
        _database_url(database="restaurant_ordering_analytics_test"),
        _database_url(database="unexpected_e2e"),
        _database_url(username="postgres"),
        _database_url(drivername="postgresql"),
        _database_url(password="different-test-only-password"),
        _database_url(query={"sslmode": "disable"}),
    ],
)
def test_validate_e2e_database_url_rejects_nonisolated_targets(
    candidate: str,
) -> None:
    with pytest.raises(
        harness.E2EHarnessSafetyError,
        match="^E2E_DATABASE_TARGET_INVALID$",
    ) as error:
        harness.validate_e2e_database_url(
            candidate,
            expected_password=SecretStr(POSTGRES_PASSWORD),
        )

    rendered_error = str(error.value)
    assert POSTGRES_PASSWORD not in rendered_error
    assert "://" not in rendered_error


def test_validate_e2e_database_url_sanitizes_malformed_input() -> None:
    unsafe_candidate = (
        f"postgresql+psycopg://e2e_app:{POSTGRES_PASSWORD}@"
        f"postgres:not-a-port-{POSTGRES_PASSWORD}/{harness.E2E_DATABASE_NAME}"
    )

    with pytest.raises(
        harness.E2EHarnessSafetyError,
        match="^E2E_DATABASE_TARGET_INVALID$",
    ) as error:
        harness.validate_e2e_database_url(
            unsafe_candidate,
            expected_password=SecretStr(POSTGRES_PASSWORD),
        )

    assert POSTGRES_PASSWORD not in str(error.value)
    assert unsafe_candidate not in str(error.value)


def test_runtime_contract_accepts_exact_isolated_environment_without_admin() -> None:
    contract = harness.load_e2e_runtime_contract(_runtime_environment())

    assert contract.run_id == RUN_ID
    assert contract.project_name == PROJECT_NAME
    assert contract.frontend_port == FRONTEND_PORT
    assert contract.public_origin == PUBLIC_ORIGIN
    rendered_contract = repr(contract)
    assert POSTGRES_PASSWORD not in rendered_contract
    assert AUTH_JWT_SECRET not in rendered_contract
    assert WEBHOOK_SECRET not in rendered_contract
    assert "postgresql" not in rendered_contract
    assert harness.E2E_DATABASE_NAME not in rendered_contract


@pytest.mark.parametrize(
    ("name", "value", "expected_error"),
    [
        ("E2E_MODE", "development", "E2E_MODE_INVALID"),
        ("E2E_RUN_ID", RUN_ID.upper(), "E2E_RUN_ID_INVALID"),
        ("E2E_RUN_ID", "a1b2c3", "E2E_RUN_ID_INVALID"),
        ("E2E_RUN_ID", "g1b2c3d4e5f60718", "E2E_RUN_ID_INVALID"),
        ("E2E_PROJECT_NAME", "roa-stage18-e2e-other", "E2E_PROJECT_NAME_INVALID"),
        ("E2E_FRONTEND_PORT", "5173", "E2E_FRONTEND_PORT_INVALID"),
        ("E2E_FRONTEND_PORT", "08080", "E2E_FRONTEND_PORT_INVALID"),
        ("E2E_PUBLIC_ORIGIN", "http://frontend:8080", "E2E_PUBLIC_ORIGIN_INVALID"),
        ("E2E_AUTH_JWT_SECRET", "too-short", "E2E_AUTH_JWT_SECRET_INVALID"),
        (
            "E2E_STRIPE_WEBHOOK_SECRET",
            "too-short",
            "E2E_STRIPE_WEBHOOK_SECRET_INVALID",
        ),
    ],
)
def test_runtime_contract_rejects_environment_drift(
    name: str,
    value: str,
    expected_error: str,
) -> None:
    environment = _runtime_environment()
    environment[name] = value

    with pytest.raises(
        harness.E2EHarnessSafetyError,
        match=f"^{expected_error}$",
    ) as error:
        harness.load_e2e_runtime_contract(environment)

    assert value not in str(error.value)


def test_runtime_contract_rejects_missing_values_without_leakage() -> None:
    environment = _runtime_environment()
    del environment["E2E_POSTGRES_PASSWORD"]

    with pytest.raises(
        harness.E2EHarnessSafetyError,
        match="^E2E_ENVIRONMENT_INVALID$",
    ):
        harness.load_e2e_runtime_contract(environment)


def test_runtime_contract_rejects_database_password_mismatch() -> None:
    environment = _runtime_environment()
    environment["E2E_POSTGRES_PASSWORD"] = "test-only-mismatched-" + ("m" * 24)

    with pytest.raises(
        harness.E2EHarnessSafetyError,
        match="^E2E_DATABASE_TARGET_INVALID$",
    ) as error:
        harness.load_e2e_runtime_contract(environment)

    assert POSTGRES_PASSWORD not in str(error.value)
    assert environment["E2E_POSTGRES_PASSWORD"] not in str(error.value)


def test_setup_contract_requires_the_run_bound_administrator() -> None:
    contract = harness.load_e2e_setup_contract(_setup_environment())

    assert contract.runtime.run_id == RUN_ID
    assert contract.admin_email == ADMIN_EMAIL
    assert contract.admin_password.get_secret_value() == ADMIN_PASSWORD
    assert ADMIN_EMAIL not in repr(contract)
    assert ADMIN_PASSWORD not in repr(contract)


@pytest.mark.parametrize(
    ("name", "value", "expected_error"),
    [
        ("E2E_ADMIN_EMAIL", "other@example.com", "E2E_ADMIN_EMAIL_INVALID"),
        (
            "E2E_ADMIN_EMAIL",
            f"stage18-admin-{RUN_ID}@other.example",
            "E2E_ADMIN_EMAIL_INVALID",
        ),
        ("E2E_ADMIN_PASSWORD", "too-short", "E2E_ADMIN_PASSWORD_INVALID"),
        ("E2E_ADMIN_PASSWORD", "x" * 129, "E2E_ADMIN_PASSWORD_INVALID"),
    ],
)
def test_setup_contract_rejects_conflicting_administrator_inputs(
    name: str,
    value: str,
    expected_error: str,
) -> None:
    environment = _setup_environment()
    environment[name] = value

    with pytest.raises(
        harness.E2EHarnessSafetyError,
        match=f"^{expected_error}$",
    ) as error:
        harness.load_e2e_setup_contract(environment)

    assert value not in str(error.value)


def test_create_e2e_app_injects_fake_stripe_without_database_or_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = _runtime_contract()
    forbidden_engine = Mock(side_effect=AssertionError("database access attempted"))
    forbidden_stripe = Mock(side_effect=AssertionError("Stripe access attempted"))
    monkeypatch.setattr(harness, "load_e2e_runtime_contract", lambda: runtime)
    monkeypatch.setattr(harness, "create_database_engine", forbidden_engine)
    monkeypatch.setattr(
        stripe_checkout_module.stripe,
        "StripeClient",
        forbidden_stripe,
    )
    monkeypatch.setattr(
        stripe_webhook_module.stripe.Webhook,
        "construct_event",
        forbidden_stripe,
    )

    app = harness.create_e2e_app(
        webhook_delivery_operation=Mock(return_value=200),
        token_factory=Mock(return_value=OPAQUE_HANDLE),
        clock=Mock(return_value=float(WEBHOOK_TIMESTAMP)),
    )

    assert isinstance(
        app.state.stripe_checkout_client, harness.E2EFakeStripeCheckoutClient
    )
    assert isinstance(
        app.state.stripe_webhook_verifier,
        harness.E2ESyntheticStripeWebhookVerifier,
    )
    assert (
        app.state.stripe_checkout_client._registry
        is app.state.e2e_fake_checkout_registry
    )
    assert (
        app.state.stripe_webhook_verifier._registry
        is app.state.e2e_fake_checkout_registry
    )
    assert app.state.stripe_success_url == (
        f"{PUBLIC_ORIGIN}/orders/{{public_order_number}}/payment-return"
    )
    assert app.state.stripe_cancel_url == (
        f"{PUBLIC_ORIGIN}/orders/{{public_order_number}}/checkout-cancelled"
    )
    forbidden_engine.assert_not_called()
    forbidden_stripe.assert_not_called()
    openapi_paths = app.openapi()["paths"]
    assert harness.FAKE_CHECKOUT_PATH not in openapi_paths
    assert harness.FAKE_CHECKOUT_SCRIPT_PATH not in openapi_paths
    assert harness.FAKE_CHECKOUT_COMPLETE_PATH not in openapi_paths


def test_fake_checkout_returns_an_opaque_same_origin_fragment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    forbidden_stripe = Mock(side_effect=AssertionError("Stripe access attempted"))
    monkeypatch.setattr(
        stripe_checkout_module.stripe,
        "StripeClient",
        forbidden_stripe,
    )
    registry = harness._E2EFakeCheckoutRegistry(
        token_factory=Mock(return_value=OPAQUE_HANDLE),
        clock=Mock(return_value=float(WEBHOOK_TIMESTAMP)),
    )
    client = harness.E2EFakeStripeCheckoutClient(PUBLIC_ORIGIN, registry)

    result = client.create_checkout_session(_checkout_request())

    checkout_url = urlsplit(result.checkout_url)
    assert checkout_url.scheme == "http"
    assert checkout_url.netloc == f"127.0.0.1:{FRONTEND_PORT}"
    assert checkout_url.path == harness.FAKE_CHECKOUT_PATH
    assert checkout_url.query == ""
    assert checkout_url.fragment == OPAQUE_HANDLE
    assert result.expires_at == harness.FAKE_CHECKOUT_EXPIRATION
    assert str(ORDER_ID) not in result.checkout_url
    assert str(PAYMENT_ID) not in result.checkout_url
    assert PAYMENT_ID.hex not in result.checkout_url
    assert "2500" not in result.checkout_url
    record = registry.resolve(OPAQUE_HANDLE)
    assert record.request == _checkout_request()
    assert record.session_id == result.session_id
    forbidden_stripe.assert_not_called()


def test_registry_replays_the_same_idempotent_checkout_without_new_entropy() -> None:
    token_factory = Mock(return_value=OPAQUE_HANDLE)
    registry = harness._E2EFakeCheckoutRegistry(
        token_factory=token_factory,
        clock=Mock(return_value=float(WEBHOOK_TIMESTAMP)),
    )
    request = _checkout_request()

    first_record = registry.register(request)
    replayed_record = registry.register(request)

    assert replayed_record is first_record
    assert replayed_record.session_id == first_record.session_id
    assert replayed_record.event_id == first_record.event_id
    token_factory.assert_called_once_with(harness.FAKE_CHECKOUT_HANDLE_BYTES)


def test_registry_serializes_concurrent_replays_of_one_idempotency_key() -> None:
    token_factory = Mock(return_value=OPAQUE_HANDLE)
    registry = harness._E2EFakeCheckoutRegistry(
        token_factory=token_factory,
        clock=Mock(return_value=float(WEBHOOK_TIMESTAMP)),
    )
    request = _checkout_request()

    with ThreadPoolExecutor(max_workers=4) as executor:
        records = list(
            executor.map(lambda _index: registry.register(request), range(8))
        )

    assert len({id(record) for record in records}) == 1
    assert len({record.session_id for record in records}) == 1
    assert len({record.event_id for record in records}) == 1
    token_factory.assert_called_once_with(harness.FAKE_CHECKOUT_HANDLE_BYTES)


def test_registry_rejects_same_idempotency_key_with_conflicting_trusted_facts() -> None:
    token_factory = Mock(return_value=OPAQUE_HANDLE)
    registry = harness._E2EFakeCheckoutRegistry(
        token_factory=token_factory,
        clock=Mock(return_value=float(WEBHOOK_TIMESTAMP)),
    )
    request = _checkout_request()
    registry.register(request)
    conflicting_request = replace(request, amount=987_654_321)

    with pytest.raises(
        StripeCheckoutDefinitiveError,
        match="^Synthetic Checkout rejected conflicting idempotency$",
    ) as error:
        registry.register(conflicting_request)

    rendered_error = str(error.value)
    assert "987654321" not in rendered_error
    assert str(PAYMENT_ID) not in rendered_error
    assert OPAQUE_HANDLE not in rendered_error
    token_factory.assert_called_once_with(harness.FAKE_CHECKOUT_HANDLE_BYTES)


def test_fake_checkout_rejects_an_unsafe_redirect_without_leaking_it() -> None:
    unsafe_url = "http://frontend:8080/private-marker"
    client = harness.E2EFakeStripeCheckoutClient(PUBLIC_ORIGIN)

    with pytest.raises(
        StripeCheckoutDefinitiveError,
        match="^Synthetic Checkout rejected an unsafe redirect$",
    ) as error:
        client.create_checkout_session(_checkout_request(success_url=unsafe_url))

    assert unsafe_url not in str(error.value)


def test_synthetic_webhook_signature_round_trip_uses_no_stripe_sdk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry, record = _registered_checkout()
    payload = harness._synthetic_checkout_event_payload(
        record,
        timestamp=WEBHOOK_TIMESTAMP,
    )
    secret = SecretStr(WEBHOOK_SECRET)
    forbidden_stripe = Mock(side_effect=AssertionError("Stripe access attempted"))
    monkeypatch.setattr(
        stripe_webhook_module.stripe.Webhook,
        "construct_event",
        forbidden_stripe,
    )
    signature = harness.sign_synthetic_webhook_payload(
        payload,
        webhook_secret=secret,
        timestamp=WEBHOOK_TIMESTAMP,
    )
    verifier = harness.E2ESyntheticStripeWebhookVerifier(
        secret,
        registry,
        clock=lambda: float(WEBHOOK_TIMESTAMP),
    )

    event = verifier.verify(payload, signature)

    assert isinstance(event, VerifiedStripeCheckoutEvent)
    assert event.stripe_event_id == record.event_id
    assert event.event_type == StripeWebhookEventType.COMPLETED
    assert event.livemode is False
    assert event.stripe_checkout_session_id == record.session_id
    assert event.session_status == "complete"
    assert event.payment_status == "paid"
    assert event.mode == "payment"
    assert event.amount_total == 2500
    assert event.currency == "nok"
    assert event.metadata_payment_id == str(PAYMENT_ID)
    assert event.metadata_order_id == str(ORDER_ID)
    assert event.metadata_public_order_number == PUBLIC_ORDER_NUMBER
    forbidden_stripe.assert_not_called()


@pytest.mark.parametrize("failure", ["tampered", "expired", "malformed"])
def test_synthetic_webhook_rejects_untrusted_callbacks_without_leakage(
    failure: str,
) -> None:
    registry, record = _registered_checkout()
    payload = harness._synthetic_checkout_event_payload(
        record,
        timestamp=WEBHOOK_TIMESTAMP,
    )
    secret = SecretStr(WEBHOOK_SECRET)
    signature = harness.sign_synthetic_webhook_payload(
        payload,
        webhook_secret=secret,
        timestamp=WEBHOOK_TIMESTAMP,
    )
    clock_timestamp = WEBHOOK_TIMESTAMP
    if failure == "tampered":
        payload += b" "
    elif failure == "expired":
        clock_timestamp = (
            WEBHOOK_TIMESTAMP + harness.SYNTHETIC_WEBHOOK_TOLERANCE_SECONDS + 1
        )
    else:
        signature = f"unsafe-{WEBHOOK_SECRET}"
    verifier = harness.E2ESyntheticStripeWebhookVerifier(
        secret,
        registry,
        clock=lambda: float(clock_timestamp),
    )

    with pytest.raises(
        StripeWebhookVerificationError,
        match="^Stripe webhook verification failed$",
    ) as error:
        verifier.verify(payload, signature)

    assert WEBHOOK_SECRET not in str(error.value)
    assert signature not in str(error.value)


def test_fake_checkout_page_and_script_expose_only_the_generic_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delivery = Mock(return_value=200)
    application = _route_application(monkeypatch, delivery)
    checkout = application.state.stripe_checkout_client.create_checkout_session(
        _checkout_request()
    )
    client = TestClient(application)
    try:
        page_response = client.get(harness.FAKE_CHECKOUT_PATH)
        script_response = client.get(harness.FAKE_CHECKOUT_SCRIPT_PATH)
    finally:
        client.close()

    assert page_response.status_code == 200
    assert page_response.headers["cache-control"] == "no-store"
    content_security_policy = page_response.headers["content-security-policy"]
    assert "script-src 'self'" in content_security_policy
    assert "'unsafe-inline'" not in content_security_policy
    assert "<h1>Test Checkout</h1>" in page_response.text
    assert "Complete test payment" in page_response.text
    assert f'src="{harness.FAKE_CHECKOUT_SCRIPT_PATH}"' in page_response.text

    assert script_response.status_code == 200
    assert script_response.headers["content-type"].startswith("application/javascript")
    assert "window.location.hash.slice(1)" in script_response.text
    assert "window.history.replaceState" in script_response.text
    assert script_response.text.index(
        "window.history.replaceState"
    ) < script_response.text.index("window.fetch")
    assert harness.FAKE_CHECKOUT_COMPLETE_PATH in script_response.text
    assert "/api/v1/stripe/webhook" not in script_response.text

    browser_resources = page_response.text + script_response.text
    for private_value in (
        OPAQUE_HANDLE,
        str(ORDER_ID),
        str(PAYMENT_ID),
        PAYMENT_ID.hex,
        WEBHOOK_SECRET,
        "Stripe-Signature",
    ):
        assert private_value not in browser_resources
    assert OPAQUE_HANDLE not in urlsplit(checkout.checkout_url).path
    assert delivery.call_count == 0


def test_completion_delivers_identical_trusted_webhook_twice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delivery = Mock(return_value=200)
    application = _route_application(monkeypatch, delivery)
    checkout = application.state.stripe_checkout_client.create_checkout_session(
        _checkout_request()
    )
    checkout_handle = urlsplit(checkout.checkout_url).fragment
    browser_payload = json.dumps(
        {"checkout_handle": checkout_handle},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    client = TestClient(application)
    try:
        response = client.post(
            harness.FAKE_CHECKOUT_COMPLETE_PATH,
            content=browser_payload,
            headers={
                "Content-Type": "application/json",
                "Origin": PUBLIC_ORIGIN,
            },
        )
    finally:
        client.close()

    assert response.status_code == 200
    assert response.json() == {
        "completed": True,
        "success_url": (f"{PUBLIC_ORIGIN}/orders/{PUBLIC_ORDER_NUMBER}/payment-return"),
    }
    assert delivery.call_count == 2
    first_payload, first_signature = delivery.call_args_list[0].args
    second_payload, second_signature = delivery.call_args_list[1].args
    assert first_payload == second_payload
    assert first_signature == second_signature
    assert browser_payload == harness._fake_checkout_completion_payload(checkout_handle)
    for trusted_value in (
        str(ORDER_ID).encode("ascii"),
        str(PAYMENT_ID).encode("ascii"),
        b'"amount_total":2500',
        b'"payment_status":"paid"',
    ):
        assert trusted_value not in browser_payload
        assert trusted_value in first_payload
    assert WEBHOOK_SECRET.encode("utf-8") not in first_payload
    assert WEBHOOK_SECRET not in first_signature

    verified_event = application.state.stripe_webhook_verifier.verify(
        first_payload,
        first_signature,
    )
    assert isinstance(verified_event, VerifiedStripeCheckoutEvent)
    assert verified_event.stripe_event_id.startswith("evt_test_e2e_")
    assert verified_event.metadata_payment_id == str(PAYMENT_ID)


@pytest.mark.parametrize(
    ("payload", "headers"),
    [
        (
            harness._fake_checkout_completion_payload(OPAQUE_HANDLE),
            {"Content-Type": "application/json"},
        ),
        (
            harness._fake_checkout_completion_payload(OPAQUE_HANDLE),
            {
                "Content-Type": "application/json; charset=utf-8",
                "Origin": PUBLIC_ORIGIN,
            },
        ),
        (
            json.dumps(
                {"checkout_handle": OPAQUE_HANDLE, "status": "paid"},
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8"),
            {"Content-Type": "application/json", "Origin": PUBLIC_ORIGIN},
        ),
        (
            json.dumps({"checkout_handle": OPAQUE_HANDLE}).encode("utf-8"),
            {"Content-Type": "application/json", "Origin": PUBLIC_ORIGIN},
        ),
    ],
)
def test_completion_rejects_noncanonical_or_cross_origin_browser_inputs(
    payload: bytes,
    headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delivery = Mock(return_value=200)
    application = _route_application(monkeypatch, delivery)
    application.state.stripe_checkout_client.create_checkout_session(
        _checkout_request()
    )
    client = TestClient(application)
    try:
        response = client.post(
            harness.FAKE_CHECKOUT_COMPLETE_PATH,
            content=payload,
            headers=headers,
        )
    finally:
        client.close()

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid test checkout request"}
    assert OPAQUE_HANDLE not in response.text
    assert str(PAYMENT_ID) not in response.text
    delivery.assert_not_called()


def test_completion_returns_safe_unknown_and_expired_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = Mock(return_value=float(WEBHOOK_TIMESTAMP))
    delivery = Mock(return_value=200)
    application = _route_application(monkeypatch, delivery, clock=clock)
    application.state.stripe_checkout_client.create_checkout_session(
        _checkout_request()
    )
    client = TestClient(application)
    headers = {"Content-Type": "application/json", "Origin": PUBLIC_ORIGIN}
    unknown_payload = harness._fake_checkout_completion_payload("B" * 43)
    expired_payload = harness._fake_checkout_completion_payload(OPAQUE_HANDLE)
    try:
        unknown_response = client.post(
            harness.FAKE_CHECKOUT_COMPLETE_PATH,
            content=unknown_payload,
            headers=headers,
        )
        clock.return_value = harness.FAKE_CHECKOUT_EXPIRATION.timestamp()
        expired_response = client.post(
            harness.FAKE_CHECKOUT_COMPLETE_PATH,
            content=expired_payload,
            headers=headers,
        )
    finally:
        client.close()

    assert unknown_response.status_code == 404
    assert unknown_response.json() == {"detail": "Test checkout not found"}
    assert expired_response.status_code == 410
    assert expired_response.json() == {"detail": "Test checkout expired"}
    for response in (unknown_response, expired_response):
        assert OPAQUE_HANDLE not in response.text
        assert str(PAYMENT_ID) not in response.text
    delivery.assert_not_called()


def test_completion_retains_registry_after_a_sanitized_delivery_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unsafe_detail = f"delivery {WEBHOOK_SECRET} {PAYMENT_ID}"
    delivery = Mock(side_effect=[OSError(unsafe_detail), 200, 200])
    application = _route_application(monkeypatch, delivery)
    checkout = application.state.stripe_checkout_client.create_checkout_session(
        _checkout_request()
    )
    checkout_handle = urlsplit(checkout.checkout_url).fragment
    browser_payload = harness._fake_checkout_completion_payload(checkout_handle)
    client = TestClient(application)
    headers = {"Content-Type": "application/json", "Origin": PUBLIC_ORIGIN}
    try:
        failed_response = client.post(
            harness.FAKE_CHECKOUT_COMPLETE_PATH,
            content=browser_payload,
            headers=headers,
        )
        replay_response = client.post(
            harness.FAKE_CHECKOUT_COMPLETE_PATH,
            content=browser_payload,
            headers=headers,
        )
    finally:
        client.close()

    assert failed_response.status_code == 502
    assert failed_response.json() == {"detail": "Test payment could not be completed"}
    assert unsafe_detail not in failed_response.text
    assert replay_response.status_code == 200
    assert delivery.call_count == 3
    delivered_payloads = [call.args[0] for call in delivery.call_args_list]
    delivered_signatures = [call.args[1] for call in delivery.call_args_list]
    assert len(set(delivered_payloads)) == 1
    assert len(set(delivered_signatures)) == 1
    assert (
        application.state.e2e_fake_checkout_registry.resolve(
            checkout_handle
        ).request.payment_id
        == PAYMENT_ID
    )


def test_registry_bound_verifier_rejects_signed_fabricated_trusted_facts() -> None:
    registry, record = _registered_checkout()
    payload = harness._synthetic_checkout_event_payload(
        record,
        timestamp=WEBHOOK_TIMESTAMP,
    )
    fabricated_event = json.loads(payload)
    fabricated_event["data"]["object"]["amount_total"] = 1
    fabricated_payload = json.dumps(
        fabricated_event,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    signature = harness.sign_synthetic_webhook_payload(
        fabricated_payload,
        webhook_secret=SecretStr(WEBHOOK_SECRET),
        timestamp=WEBHOOK_TIMESTAMP,
    )
    verifier = harness.E2ESyntheticStripeWebhookVerifier(
        SecretStr(WEBHOOK_SECRET),
        registry,
        clock=Mock(return_value=float(WEBHOOK_TIMESTAMP)),
    )

    with pytest.raises(
        StripeWebhookVerificationError,
        match="^Stripe webhook verification failed$",
    ):
        verifier.verify(fabricated_payload, signature)


def test_concurrent_completion_keeps_one_stable_idempotent_event() -> None:
    registry, record = _registered_checkout()
    delivered: list[tuple[bytes, str]] = []
    delivered_lock = Lock()

    def record_delivery(payload: bytes, signature: str) -> int:
        with delivered_lock:
            delivered.append((payload, signature))
        return 200

    coordinator = harness._E2EFakeCheckoutCoordinator(
        registry,
        SecretStr(WEBHOOK_SECRET),
        delivery_operation=record_delivery,
        clock=Mock(return_value=float(WEBHOOK_TIMESTAMP)),
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        completions = list(
            executor.map(lambda _index: coordinator.complete(record.handle), range(2))
        )

    assert len(completions) == 2
    assert len(delivered) == 4
    assert len({payload for payload, _signature in delivered}) == 1
    assert len({signature for _payload, signature in delivered}) == 1
    event = json.loads(delivered[0][0])
    assert event["id"] == record.event_id


def test_default_webhook_delivery_disables_proxies_and_redirects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = MagicMock()
    response.__enter__.return_value = response
    response.getcode.return_value = 200
    response.geturl.return_value = harness.SYNTHETIC_WEBHOOK_URL
    opener = Mock()
    opener.open.return_value = response
    build_opener = Mock(return_value=opener)
    monkeypatch.setattr(harness.urllib_request, "build_opener", build_opener)

    result = harness._deliver_synthetic_webhook(
        b'{"safe":"payload"}',
        "t=1787400000,v1=" + ("a" * 64),
    )

    assert result == 200
    handlers = build_opener.call_args.args
    assert any(
        isinstance(handler, harness.urllib_request.ProxyHandler)
        and handler.proxies == {}
        for handler in handlers
    )
    assert any(
        isinstance(handler, harness._RejectRedirectHandler) for handler in handlers
    )
    request = opener.open.call_args.args[0]
    assert request.full_url == harness.SYNTHETIC_WEBHOOK_URL
    assert request.data == b'{"safe":"payload"}'
    assert opener.open.call_args.kwargs["timeout"] == (
        harness.SYNTHETIC_WEBHOOK_DELIVERY_TIMEOUT_SECONDS
    )


def test_setup_e2e_data_reuses_seed_and_admin_boundaries_and_disposes_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract = _setup_contract()
    load_contract = Mock(return_value=contract)
    engine = SimpleNamespace(dispose=Mock())
    session_factory = object()
    seed = Mock(return_value=SeedResult(5, 15))
    ensure_admin = Mock()
    monkeypatch.setattr(harness, "load_e2e_setup_contract", load_contract)
    monkeypatch.setattr(harness, "create_database_engine", Mock(return_value=engine))
    monkeypatch.setattr(
        harness,
        "create_session_factory",
        Mock(return_value=session_factory),
    )
    monkeypatch.setattr(harness, "seed_menu_data", seed)
    monkeypatch.setattr(harness, "_ensure_synthetic_admin", ensure_admin)

    result = harness.setup_e2e_data()

    assert result == harness.E2ESetupResult(5, 15, True)
    load_contract.assert_called_once_with()
    seed.assert_called_once_with(session_factory)
    ensure_admin.assert_called_once_with(session_factory, contract)
    engine.dispose.assert_called_once_with()


def test_setup_e2e_data_sanitizes_failures_and_disposes_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract = _setup_contract()
    engine = SimpleNamespace(dispose=Mock())
    unsafe_detail = f"seed conflict at {_database_url()} using {ADMIN_PASSWORD}"
    monkeypatch.setattr(
        harness,
        "load_e2e_setup_contract",
        Mock(return_value=contract),
    )
    monkeypatch.setattr(harness, "create_database_engine", Mock(return_value=engine))
    monkeypatch.setattr(harness, "create_session_factory", Mock(return_value=object()))
    monkeypatch.setattr(
        harness,
        "seed_menu_data",
        Mock(side_effect=SeedConflictError(unsafe_detail)),
    )

    with pytest.raises(
        harness.E2EHarnessSetupError,
        match="^E2E_SETUP_FAILED$",
    ) as error:
        harness.setup_e2e_data()

    assert POSTGRES_PASSWORD not in str(error.value)
    assert ADMIN_PASSWORD not in str(error.value)
    assert "://" not in str(error.value)
    engine.dispose.assert_called_once_with()


def test_setup_e2e_data_sanitizes_cleanup_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract = _setup_contract()
    unsafe_detail = f"cleanup {_database_url()} using {POSTGRES_PASSWORD}"
    engine = SimpleNamespace(dispose=Mock(side_effect=OSError(unsafe_detail)))
    monkeypatch.setattr(
        harness,
        "load_e2e_setup_contract",
        Mock(return_value=contract),
    )
    monkeypatch.setattr(harness, "create_database_engine", Mock(return_value=engine))
    monkeypatch.setattr(harness, "create_session_factory", Mock(return_value=object()))
    monkeypatch.setattr(
        harness,
        "seed_menu_data",
        Mock(return_value=SeedResult(5, 15)),
    )
    monkeypatch.setattr(harness, "_ensure_synthetic_admin", Mock())

    with pytest.raises(
        harness.E2EHarnessSetupError,
        match="^E2E_SETUP_CLEANUP_FAILED$",
    ) as error:
        harness.setup_e2e_data()

    assert POSTGRES_PASSWORD not in str(error.value)
    assert "://" not in str(error.value)
    engine.dispose.assert_called_once_with()


def test_setup_e2e_data_rejects_contract_injection_before_engine_creation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    create_engine = Mock(side_effect=AssertionError("engine creation attempted"))
    monkeypatch.setattr(harness, "create_database_engine", create_engine)

    with pytest.raises(TypeError):
        harness.setup_e2e_data(_setup_contract())  # type: ignore[call-arg]

    create_engine.assert_not_called()


def test_existing_exact_administrator_is_an_idempotent_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract = _setup_contract()
    create_admin = Mock(side_effect=harness.AdminBootstrapConflictError("conflict"))
    first_session = object()
    second_session = Mock()
    second_session.scalars.return_value.all.return_value = [
        SimpleNamespace(
            email=ADMIN_EMAIL,
            is_active=True,
            password_hash="test-only-stored-hash",
        )
    ]
    session_factory = Mock(
        side_effect=[
            _session_context(first_session),
            _session_context(second_session),
        ]
    )
    monkeypatch.setattr(harness, "create_admin", create_admin)
    monkeypatch.setattr(harness, "verify_password", Mock(return_value=True))

    harness._ensure_synthetic_admin(session_factory, contract)

    create_admin.assert_called_once_with(
        first_session,
        email=ADMIN_EMAIL,
        password=ADMIN_PASSWORD,
    )
    second_session.scalars.assert_called_once()


@pytest.mark.parametrize(
    "administrators",
    [
        [],
        [
            SimpleNamespace(
                email=ADMIN_EMAIL,
                is_active=True,
                password_hash="hash-one",
            ),
            SimpleNamespace(
                email=ADMIN_EMAIL,
                is_active=True,
                password_hash="hash-two",
            ),
        ],
        [
            SimpleNamespace(
                email="other@example.com",
                is_active=True,
                password_hash="hash-one",
            )
        ],
        [
            SimpleNamespace(
                email=ADMIN_EMAIL,
                is_active=False,
                password_hash="hash-one",
            )
        ],
    ],
)
def test_existing_administrator_conflicts_fail_closed(
    administrators: list[SimpleNamespace],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract = _setup_contract()
    second_session = Mock()
    second_session.scalars.return_value.all.return_value = administrators
    session_factory = Mock(
        side_effect=[
            _session_context(object()),
            _session_context(second_session),
        ]
    )
    monkeypatch.setattr(
        harness,
        "create_admin",
        Mock(side_effect=harness.AdminBootstrapConflictError("unsafe detail")),
    )
    monkeypatch.setattr(harness, "verify_password", Mock(return_value=True))

    with pytest.raises(
        harness.E2EHarnessSetupError,
        match="^E2E_ADMIN_SETUP_FAILED$",
    ) as error:
        harness._ensure_synthetic_admin(session_factory, contract)

    assert ADMIN_EMAIL not in str(error.value)
    assert ADMIN_PASSWORD not in str(error.value)


def test_existing_administrator_with_wrong_password_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract = _setup_contract()
    second_session = Mock()
    second_session.scalars.return_value.all.return_value = [
        SimpleNamespace(
            email=ADMIN_EMAIL,
            is_active=True,
            password_hash="test-only-stored-hash",
        )
    ]
    session_factory = Mock(
        side_effect=[
            _session_context(object()),
            _session_context(second_session),
        ]
    )
    monkeypatch.setattr(
        harness,
        "create_admin",
        Mock(side_effect=harness.AdminBootstrapConflictError("unsafe detail")),
    )
    monkeypatch.setattr(harness, "verify_password", Mock(return_value=False))

    with pytest.raises(
        harness.E2EHarnessSetupError,
        match="^E2E_ADMIN_SETUP_FAILED$",
    ):
        harness._ensure_synthetic_admin(session_factory, contract)


def test_setup_cli_reports_only_safe_counts(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        harness,
        "setup_e2e_data",
        Mock(return_value=harness.E2ESetupResult(5, 15, True)),
    )

    assert harness.main(["setup"]) == 0

    captured = capsys.readouterr()
    assert captured.out == "E2E setup complete: 5 categories and 15 menu items ready.\n"
    assert captured.err == ""
    assert POSTGRES_PASSWORD not in captured.out
    assert ADMIN_PASSWORD not in captured.out


def test_setup_cli_sanitizes_handled_failures(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unsafe_detail = f"{_database_url()} {POSTGRES_PASSWORD} {ADMIN_PASSWORD}"
    monkeypatch.setattr(
        harness,
        "setup_e2e_data",
        Mock(side_effect=harness.E2EHarnessSetupError(unsafe_detail)),
    )

    assert harness.main(["setup"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "E2E setup failed.\n"
    assert POSTGRES_PASSWORD not in captured.err
    assert ADMIN_PASSWORD not in captured.err
    assert "://" not in captured.err


def test_setup_cli_sanitizes_predictable_system_failures(
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unsafe_detail = f"filesystem {_database_url()} {POSTGRES_PASSWORD}"
    monkeypatch.setattr(
        harness,
        "setup_e2e_data",
        Mock(side_effect=OSError(unsafe_detail)),
    )

    assert harness.main(["setup"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "E2E setup failed.\n"
    assert POSTGRES_PASSWORD not in captured.err
    assert "://" not in captured.err
