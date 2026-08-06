"""Database dependencies shared by API routes."""

from collections.abc import Iterator

from fastapi import Request
from sqlalchemy.orm import Session, sessionmaker


def get_db_session(request: Request) -> Iterator[Session]:
    """Provide one database session for the duration of a request.

    Args:
        request: Current FastAPI request containing application state.

    Yields:
        A database session managed by the configured session factory.

    Raises:
        RuntimeError: If the application has no configured session factory.
    """
    session_factory: sessionmaker[Session] | None = getattr(
        request.app.state, "session_factory", None
    )
    if session_factory is None:
        raise RuntimeError("Database session factory is not configured")

    with session_factory() as session:
        yield session
