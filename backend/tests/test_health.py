from fastapi.testclient import TestClient

from app.main import app


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
