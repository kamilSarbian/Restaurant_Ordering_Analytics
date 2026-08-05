"""Establish the initial database migration baseline.

Revision ID: 0001_database_baseline
Revises:
Create Date: 2026-08-05
"""

from collections.abc import Sequence

revision: str = "0001_database_baseline"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Establish the database baseline without creating business tables."""
    pass


def downgrade() -> None:
    """Remove the database baseline without changing business data."""
    pass
