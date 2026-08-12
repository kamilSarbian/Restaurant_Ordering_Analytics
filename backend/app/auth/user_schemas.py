"""Validation schemas for canonical registered-user authentication."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
)

from app.auth.roles import UserRole
from app.auth.schemas import AdminTokenResponse as TokenResponse
from app.auth.schemas import normalize_admin_email


class UserRegisterRequest(BaseModel):
    """Validate the exact public account-registration request."""

    email: str
    password: SecretStr

    model_config = ConfigDict(extra="forbid")

    @field_validator("email")
    @classmethod
    def normalize_email(cls, email: str) -> str:
        """Store the validated registration identity in canonical form."""
        return normalize_admin_email(email)

    @field_validator("password")
    @classmethod
    def validate_password_length(cls, password: SecretStr) -> SecretStr:
        """Require 15 through 128 Unicode code points without mutation."""
        length = len(password.get_secret_value())
        if length < 15:
            raise ValueError(
                "Registration password must contain at least 15 characters"
            )
        if length > 128:
            raise ValueError(
                "Registration password must contain at most 128 characters"
            )
        return password


class UserLoginRequest(BaseModel):
    """Validate the exact canonical user-login request."""

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
        """Require 1 through 128 Unicode code points without mutation."""
        length = len(password.get_secret_value())
        if length < 1:
            raise ValueError("Login password must not be empty")
        if length > 128:
            raise ValueError("Login password must contain at most 128 characters")
        return password


class CurrentUserResponse(BaseModel):
    """Expose the current database-authoritative registered identity."""

    id: UUID
    email: str
    role: UserRole
    is_active: bool = Field(strict=True)

    model_config = ConfigDict(extra="forbid")

    @field_validator("email")
    @classmethod
    def normalize_email(cls, email: str) -> str:
        """Keep the returned identity in canonical email form."""
        return normalize_admin_email(email)


class UserAdminListItem(BaseModel):
    """Expose one safe registered-user identity to a super-administrator."""

    id: UUID
    email: str
    role: UserRole
    is_active: bool
    created_at: AwareDatetime
    updated_at: AwareDatetime

    model_config = ConfigDict(extra="forbid", strict=True)


class UserAdminListResponse(BaseModel):
    """Represent one deterministic page of registered users."""

    items: list[UserAdminListItem]
    total: int = Field(strict=True, ge=0)
    limit: int = Field(strict=True, ge=1, le=100)
    offset: int = Field(strict=True, ge=0)

    model_config = ConfigDict(extra="forbid", strict=True)


class UserRoleUpdateRequest(BaseModel):
    """Allow only ordinary customer and administrator target roles."""

    role: Literal["customer", "admin"]

    model_config = ConfigDict(extra="forbid")


class UserRoleUpdateResponse(BaseModel):
    """Expose the safe result of one ordinary role transition."""

    id: UUID
    email: str
    role: UserRole
    updated_at: AwareDatetime

    model_config = ConfigDict(extra="forbid", strict=True)


__all__ = [
    "CurrentUserResponse",
    "TokenResponse",
    "UserAdminListItem",
    "UserAdminListResponse",
    "UserLoginRequest",
    "UserRegisterRequest",
    "UserRoleUpdateRequest",
    "UserRoleUpdateResponse",
]
