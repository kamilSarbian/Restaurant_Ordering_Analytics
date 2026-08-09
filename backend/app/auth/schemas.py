"""Validation schemas for administrator authentication boundaries."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from email_validator import validate_email
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


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


class AdminLoginRequest(BaseModel):
    """Validate the exact administrator login request contract."""

    email: str
    password: SecretStr

    model_config = ConfigDict(extra="forbid")

    @field_validator("email")
    @classmethod
    def normalize_email(cls, email: str) -> str:
        """Store the validated login identity in canonical form."""
        return normalize_admin_email(email)

    @field_validator("password")
    @classmethod
    def validate_password_length(cls, password: SecretStr) -> SecretStr:
        """Enforce only the login-input size boundary without mutation."""
        length = len(password.get_secret_value())
        if length < 1:
            raise ValueError("Administrator login password must not be empty")
        if length > 128:
            raise ValueError(
                "Administrator login password must contain at most 128 characters"
            )
        return password


class AdminTokenResponse(BaseModel):
    """Represent the exact successful administrator token response."""

    access_token: str = Field(min_length=1, strict=True)
    token_type: Literal["bearer"]
    expires_in: int = Field(gt=0, strict=True)

    model_config = ConfigDict(extra="forbid")


class AdminMeResponse(BaseModel):
    """Represent the minimal authenticated administrator response."""

    email: str
    is_active: bool = Field(strict=True)

    model_config = ConfigDict(extra="forbid")

    @field_validator("email")
    @classmethod
    def normalize_email(cls, email: str) -> str:
        """Store the response identity in canonical form."""
        return normalize_admin_email(email)


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
