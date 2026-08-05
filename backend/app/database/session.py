"""Synchronous SQLAlchemy engine and session factories."""

from pydantic import PostgresDsn
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker


def create_database_engine(database_url: str | PostgresDsn) -> Engine:
    """Create a synchronous SQLAlchemy engine for the configured database."""
    return create_engine(str(database_url), pool_pre_ping=True)


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    """Create a typed SQLAlchemy session factory bound to an engine."""
    return sessionmaker[Session](bind=engine)
