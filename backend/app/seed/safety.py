"""Local-only safety boundary for the demonstration seed command."""

from pydantic import PostgresDsn
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError

REQUIRED_DRIVER = "postgresql+psycopg"
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
REQUIRED_PORT = 5433
DEVELOPMENT_DATABASE_NAME = "restaurant_ordering_analytics_dev"


class SeedSafetyError(Exception):
    """Report a rejected seed target without exposing connection details."""


def validate_local_seed_database_url(database_url: str | PostgresDsn) -> URL:
    """Validate and return the exact approved local development database URL."""
    try:
        parsed_url = make_url(str(database_url))
    except ArgumentError as exc:
        raise SeedSafetyError("The database URL is invalid.") from exc

    if parsed_url.drivername != REQUIRED_DRIVER:
        raise SeedSafetyError("The seed requires the PostgreSQL Psycopg driver.")
    if parsed_url.host not in ALLOWED_HOSTS:
        raise SeedSafetyError("The seed requires an approved local database host.")
    if parsed_url.port != REQUIRED_PORT:
        raise SeedSafetyError("The seed requires local host port 5433.")
    if parsed_url.database != DEVELOPMENT_DATABASE_NAME:
        raise SeedSafetyError("The seed requires the exact local development database.")
    if not parsed_url.username:
        raise SeedSafetyError("The seed database username is required.")
    if not parsed_url.password:
        raise SeedSafetyError("The seed database password is required.")

    return parsed_url


__all__ = ["SeedSafetyError", "validate_local_seed_database_url"]
