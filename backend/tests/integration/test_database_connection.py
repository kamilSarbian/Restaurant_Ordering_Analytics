"""Integration tests for the local PostgreSQL connection."""

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.database.session import create_database_engine


@pytest.mark.integration
def test_database_connection() -> None:
    """Verify a real connection to the approved local development database."""
    settings = Settings()
    assert settings.database_url is not None, "DATABASE_URL is required"

    database_url = make_url(str(settings.database_url))
    assert database_url.host in {"localhost", "127.0.0.1"}
    assert database_url.database == "restaurant_ordering_analytics_dev"

    engine = create_database_engine(settings.database_url)
    try:
        with engine.connect() as connection:
            assert connection.execute(text("SELECT 1")).scalar_one() == 1
    finally:
        engine.dispose()
