"""Shared schemas for operational administrator boundaries."""

from __future__ import annotations

from uuid import UUID

from email_validator import validate_email
from pydantic import BaseModel, ConfigDict, field_validator


def normalize_admin_email(value: str) -> str:
    """Validate and canonicalize an administrator email address without DNS.

    Args:
        value: Email address supplied at an authentication boundary.

    Returns:
        The syntax-normalized address in lowercase without outer whitespace.

    Raises:
        ValueError: If the stripped address is syntactically invalid.
    """
    validated = validate_email(value.strip(), check_deliverability=False)
    return validated.normalized.lower()


class AdminPrincipal(BaseModel):
    """Carry immutable administrator identity between internal boundaries."""

    id: UUID
    email: str

    model_config = ConfigDict(extra="forbid", frozen=True)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, email: str) -> str:
        """Store the internal identity in canonical form."""
        return normalize_admin_email(email)
