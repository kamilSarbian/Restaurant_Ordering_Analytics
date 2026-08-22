from typing import cast
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.main import app, create_app


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


def _create_readiness_application(
    *,
    database_error: SQLAlchemyError | None = None,
) -> tuple[FastAPI, MagicMock]:
    session = MagicMock(spec=Session)
    if database_error is None:
        session.execute.return_value.scalar_one.return_value = 1
    else:
        session.execute.side_effect = database_error

    session_factory = MagicMock()
    session_factory.return_value.__enter__.return_value = session
    application = create_app(
        settings=Settings(database_url=None),
        session_factory=cast(sessionmaker[Session], session_factory),
    )
    return application, session
