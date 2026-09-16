from typing import cast
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.main import app, create_app

PRODUCTION_HOST = "restaurant.example"


def _production_settings() -> Settings:
    return Settings(
        _env_file=None,
        app_environment="production",
        app_debug=False,
        database_url="postgresql://runtime:synthetic@db.internal/restaurant",
        stripe_secret_key="sk_test_synthetic",
        stripe_webhook_secret="whsec_synthetic",
        stripe_success_url=(
            f"https://{PRODUCTION_HOST}/orders/" "{public_order_number}/payment-return"
        ),
        stripe_cancel_url=(
            f"https://{PRODUCTION_HOST}/orders/"
            "{public_order_number}/checkout-cancelled"
        ),
        auth_jwt_secret="a" * 32,
        public_app_origin=f"https://{PRODUCTION_HOST}",
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
