"""Local-only safety boundary for the demonstration seed command."""

import os

from pydantic import PostgresDsn
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError

REQUIRED_DRIVER = "postgresql+psycopg"
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
PINNED_HOST = "127.0.0.1"
REQUIRED_PORT = 5433
DEVELOPMENT_DATABASE_NAME = "restaurant_ordering_analytics_dev"
TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES = frozenset(
    {
        "PGDATABASE",
        "PGHOST",
        "PGHOSTADDR",
        "PGLOADBALANCEHOSTS",
        "PGOPTIONS",
        "PGPASSFILE",
        "PGPASSWORD",
        "PGPORT",
        "PGSERVICE",
        "PGSERVICEFILE",
        "PGSYSCONFDIR",
        "PGTARGETSESSIONATTRS",
        "PGUSER",
    }
)


class SeedSafetyError(Exception):
    """Report a rejected seed target without exposing connection details."""


def reject_target_changing_postgres_environment() -> None:
    """Reject ambient libpq settings that could alter the approved connection."""
    if any(
        variable in os.environ
        for variable in TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES
    ):
        raise SeedSafetyError(
            "Target-changing PostgreSQL environment variables are not allowed."
        )


def validate_local_seed_database_url(database_url: str | PostgresDsn) -> URL:
    """Validate and return the exact approved local development database URL."""
    reject_target_changing_postgres_environment()
    raw_database_url = str(database_url)
    if "?" in raw_database_url:
        raise SeedSafetyError(
            "The seed database URL must not include query parameters."
        )
    try:
        parsed_url = make_url(raw_database_url)
    except (ArgumentError, ValueError):
        raise SeedSafetyError("The database URL is invalid.") from None

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

    return parsed_url.set(host=PINNED_HOST)


__all__ = [
    "DEVELOPMENT_DATABASE_NAME",
    "PINNED_HOST",
    "REQUIRED_PORT",
    "SeedSafetyError",
    "TARGET_CHANGING_POSTGRES_ENVIRONMENT_VARIABLES",
    "reject_target_changing_postgres_environment",
    "validate_local_seed_database_url",
]
