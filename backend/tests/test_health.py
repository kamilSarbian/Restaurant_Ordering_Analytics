from typing import cast
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.main import app, create_app

PRODUCTION_HOST = "api.restaurant.example"
PUBLIC_APP_ORIGIN = "https://app.restaurant.example"
NEON_RUNTIME_HOST = "ep-roa-runtime-pooler.eu-central-1.aws.neon.tech"


def _production_settings() -> Settings:
    return Settings(
        _env_file=None,
        app_environment="production",
        app_debug=False,
        database_url=(
            f"postgresql://roa_runtime:synthetic@{NEON_RUNTIME_HOST}/restaurant"
            "?sslmode=require&channel_binding=require"
        ),
        stripe_secret_key="sk_test_synthetic",
        stripe_webhook_secret="whsec_synthetic",
        stripe_success_url=(
            f"{PUBLIC_APP_ORIGIN}/orders/" "{public_order_number}/payment-return"
        ),
        stripe_cancel_url=(
            f"{PUBLIC_APP_ORIGIN}/orders/" "{public_order_number}/checkout-cancelled"
        ),
        auth_jwt_secret="a" * 32,
        public_app_origin=PUBLIC_APP_ORIGIN,
        public_api_origin=f"https://{PRODUCTION_HOST}",
        trusted_hosts=(PRODUCTION_HOST,),
        trusted_proxy_mode="direct",
        stripe_expected_livemode=False,
        expected_alembic_head="0008_add_order_ownership",
        release_sha="a" * 40,
    )


def test_health_returns_expected_response() -> None:
    """Verify that the health endpoint exposes only its stable contract."""
    client = TestClient(app)
    response = None
    try:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/json")
        assert response.json() == {"status": "ok"}
    finally:
        if response is not None:
            response.close()
        client.close()


def test_ready_returns_ok_after_select_one() -> None:
    """Return readiness only after the lightweight database probe succeeds."""
    application, session = _create_readiness_application()

    with TestClient(application) as client:
        response = client.get("/ready")
        try:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("application/json")
            assert response.json() == {"status": "ok"}
        finally:
            response.close()

    statement = session.execute.call_args.args[0]
    assert str(statement) == "SELECT 1"
    session.execute.return_value.scalar_one.assert_called_once_with()


def test_ready_returns_safe_503_for_database_failure() -> None:
    """Map a predictable SQLAlchemy probe failure to a stable 503 response."""
    application, _ = _create_readiness_application(
        database_error=SQLAlchemyError("synthetic database failure")
    )

    with TestClient(application) as client:
        response = client.get("/ready")
        try:
            assert response.status_code == 503
            assert response.json() == {"detail": "Service is not ready"}
        finally:
            response.close()


def test_ready_does_not_expose_sensitive_database_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Keep sensitive database exception text out of responses and logs."""
    sensitive_marker = "sensitive-ready-sentinel"
    application, _ = _create_readiness_application(
        database_error=SQLAlchemyError(sensitive_marker)
    )

    with TestClient(application) as client:
        response = client.get("/ready")
        try:
            assert response.status_code == 503
            assert response.json() == {"detail": "Service is not ready"}
            assert sensitive_marker not in response.text
            assert sensitive_marker not in caplog.text
        finally:
            response.close()


def test_production_trusted_host_accepts_the_exact_configured_host() -> None:
    """Preserve health behavior for the exact production Host allowlist."""
    application, _ = _create_readiness_application(settings=_production_settings())

    with TestClient(application, base_url=f"https://{PRODUCTION_HOST}") as client:
        response = client.get("/health")
        try:
            assert response.status_code == 200
            assert response.json() == {"status": "ok"}
        finally:
            response.close()


@pytest.mark.parametrize("host", ["attacker.example", "www.restaurant.example"])
def test_production_trusted_host_rejects_unknown_hosts_without_redirect(
    host: str,
) -> None:
    """Fail closed for unknown hosts without Starlette's implicit www redirect."""
    application, _ = _create_readiness_application(settings=_production_settings())

    with TestClient(application, base_url=f"https://{PRODUCTION_HOST}") as client:
        response = client.get("/health", headers={"host": host})
        try:
            assert response.status_code == 400
            assert "location" not in response.headers
        finally:
            response.close()


def test_invalid_production_host_is_rejected_before_database_readiness() -> None:
    """Reject an untrusted Host before opening a readiness database session."""
    application, session = _create_readiness_application(
        settings=_production_settings()
    )

    with TestClient(application, base_url=f"https://{PRODUCTION_HOST}") as client:
        response = client.get("/ready", headers={"host": "attacker.example"})
        try:
            assert response.status_code == 400
        finally:
            response.close()
    session.execute.assert_not_called()


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_production_disables_interactive_docs_and_openapi(path: str) -> None:
    """Do not expose framework discovery endpoints on the public backend."""
    application, _ = _create_readiness_application(settings=_production_settings())

    with TestClient(application, base_url=f"https://{PRODUCTION_HOST}") as client:
        response = client.get(path)

    assert response.status_code == 404


@pytest.mark.parametrize("environment", ["development", "test", "e2e"])
@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_nonproduction_keeps_docs_functional_for_local_development(
    path: str,
    environment: str,
) -> None:
    """Keep local API discovery available without production-only strict CSP."""
    application, _ = _create_readiness_application(
        settings=Settings(_env_file=None, app_environment=environment)
    )

    with TestClient(application) as client:
        response = client.get(path)

    assert response.status_code == 200
    assert "Content-Security-Policy" not in response.headers


@pytest.mark.parametrize("path", ["/health", "/missing"])
def test_api_security_headers_cover_success_and_handled_error(path: str) -> None:
    """Apply the response security contract to ordinary and 404 responses."""
    application, _ = _create_readiness_application(settings=_production_settings())

    with TestClient(application, base_url=f"https://{PRODUCTION_HOST}") as client:
        response = client.get(path)

    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["Content-Security-Policy"].startswith("default-src 'none'")
    assert response.headers["Permissions-Policy"] == (
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
    )
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Strict-Transport-Security"] == (
        "max-age=31536000; includeSubDomains"
    )


def test_api_security_headers_cover_unhandled_production_error() -> None:
    """Keep the fail-safe 500 response generic and covered by all headers."""
    sensitive_marker = "sensitive-unhandled-error-marker"
    application, _ = _create_readiness_application(settings=_production_settings())

    @application.get("/synthetic-unhandled-error")
    def raise_unhandled_error() -> None:
        """Raise one test-only error outside the handled API paths."""
        raise RuntimeError(sensitive_marker)

    with TestClient(
        application,
        base_url=f"https://{PRODUCTION_HOST}",
        raise_server_exceptions=False,
    ) as client:
        response = client.get(
            "/synthetic-unhandled-error",
            headers={"Origin": PUBLIC_APP_ORIGIN},
        )
        rejected = client.get(
            "/synthetic-unhandled-error",
            headers={"Origin": "https://attacker.example"},
        )

    assert response.status_code == 500
    assert response.text == "Internal Server Error"
    assert sensitive_marker not in response.text
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["Content-Security-Policy"].startswith("default-src 'none'")
    assert response.headers["Permissions-Policy"] == (
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
    )
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Strict-Transport-Security"] == (
        "max-age=31536000; includeSubDomains"
    )
    assert response.headers["Access-Control-Allow-Origin"] == PUBLIC_APP_ORIGIN
    assert response.headers["Vary"] == "Origin"
    assert "Access-Control-Allow-Credentials" not in response.headers
    assert rejected.status_code == 500
    assert "Access-Control-Allow-Origin" not in rejected.headers


def test_production_cors_allows_only_the_exact_frontend_origin() -> None:
    """Allow the static frontend without reflecting unrelated public origins."""
    application, _ = _create_readiness_application(settings=_production_settings())

    with TestClient(application, base_url=f"https://{PRODUCTION_HOST}") as client:
        allowed = client.get("/health", headers={"Origin": PUBLIC_APP_ORIGIN})
        rejected = client.get("/health", headers={"Origin": "https://attacker.example"})
        null_origin = client.get("/health", headers={"Origin": "null"})

    assert allowed.headers["Access-Control-Allow-Origin"] == PUBLIC_APP_ORIGIN
    assert "Access-Control-Allow-Credentials" not in allowed.headers
    assert allowed.headers["Access-Control-Expose-Headers"] == (
        "Content-Disposition, Retry-After"
    )
    assert "*" not in allowed.headers["Access-Control-Allow-Origin"]
    assert "Access-Control-Allow-Origin" not in rejected.headers
    assert "Access-Control-Allow-Origin" not in null_origin.headers


@pytest.mark.parametrize("method", ["GET", "POST", "PATCH", "OPTIONS"])
def test_production_cors_preflight_accepts_exact_methods_and_required_headers(
    method: str,
) -> None:
    """Permit only the methods and request headers used by current transports."""
    application, _ = _create_readiness_application(settings=_production_settings())
    headers = {
        "Origin": PUBLIC_APP_ORIGIN,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": (
            "authorization,content-type,idempotency-key,x-order-access-token"
        ),
    }

    with TestClient(application, base_url=f"https://{PRODUCTION_HOST}") as client:
        response = client.options("/api/v1/orders/quote", headers=headers)

    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == PUBLIC_APP_ORIGIN
    assert set(response.headers["Access-Control-Allow-Methods"].split(", ")) == {
        "GET",
        "POST",
        "PATCH",
        "OPTIONS",
    }
    allowed_headers = {
        name.lower()
        for name in response.headers["Access-Control-Allow-Headers"].split(", ")
    }
    assert {
        "accept",
        "authorization",
        "content-type",
        "idempotency-key",
        "x-order-access-token",
    } <= allowed_headers
    assert "x-unapproved" not in allowed_headers
    assert "Access-Control-Allow-Credentials" not in response.headers
    assert response.headers["Cache-Control"] == "no-store"


def test_production_cors_rejects_null_hostile_and_unapproved_header_preflights() -> (
    None
):
    """Reject noncanonical origins and request headers without wildcard fallback."""
    application, _ = _create_readiness_application(settings=_production_settings())
    base_headers = {"Access-Control-Request-Method": "POST"}

    with TestClient(application, base_url=f"https://{PRODUCTION_HOST}") as client:
        hostile = client.options(
            "/api/v1/orders/quote",
            headers={**base_headers, "Origin": "https://attacker.example"},
        )
        null_origin = client.options(
            "/api/v1/orders/quote",
            headers={**base_headers, "Origin": "null"},
        )
        unapproved_header = client.options(
            "/api/v1/orders/quote",
            headers={
                **base_headers,
                "Origin": PUBLIC_APP_ORIGIN,
                "Access-Control-Request-Headers": "x-unapproved",
            },
        )

    for response in (hostile, null_origin):
        assert response.status_code == 400
        assert "Access-Control-Allow-Origin" not in response.headers
    assert unapproved_header.status_code == 400
    assert (
        "x-unapproved"
        not in unapproved_header.headers["Access-Control-Allow-Headers"].lower()
    )
    assert all(value != "*" for value in unapproved_header.headers.values())


def test_production_cors_rejects_unapproved_methods() -> None:
    """Reject browser preflights for methods outside the current API contract."""
    application, _ = _create_readiness_application(settings=_production_settings())
    headers = {
        "Origin": PUBLIC_APP_ORIGIN,
        "Access-Control-Request-Method": "DELETE",
    }

    with TestClient(application, base_url=f"https://{PRODUCTION_HOST}") as client:
        response = client.options("/api/v1/menu", headers=headers)

    assert response.status_code == 400


def _create_readiness_application(
    *,
    database_error: SQLAlchemyError | None = None,
    settings: Settings | None = None,
) -> tuple[FastAPI, MagicMock]:
    session = MagicMock(spec=Session)
    if database_error is None:
        session.execute.return_value.scalar_one.return_value = 1
    else:
        session.execute.side_effect = database_error

    session_factory = MagicMock()
    session_factory.return_value.__enter__.return_value = session
    application = create_app(
        settings=settings or Settings(database_url=None),
        session_factory=cast(sessionmaker[Session], session_factory),
    )
    return application, session
