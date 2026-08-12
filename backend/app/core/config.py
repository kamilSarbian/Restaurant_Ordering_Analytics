from pathlib import Path

from pydantic import (
    AliasChoices,
    Field,
    PostgresDsn,
    SecretStr,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = REPOSITORY_ROOT / ".env"


class Settings(BaseSettings):
    """Define configuration for the FastAPI application."""

    app_name: str = "Restaurant Ordering & Analytics API"
    app_version: str = "0.1.0"
    app_environment: str = "development"
    app_debug: bool = False
    database_url: PostgresDsn | None = Field(default=None, repr=False)
    stripe_secret_key: SecretStr | None = Field(default=None, repr=False)
    stripe_webhook_secret: SecretStr | None = Field(default=None, repr=False)
    stripe_success_url: str | None = None
    stripe_cancel_url: str | None = None
    auth_jwt_secret: SecretStr | None = Field(
        default=None,
        repr=False,
        validation_alias=AliasChoices("AUTH_JWT_SECRET", "auth_jwt_secret"),
    )
    auth_access_token_expire_minutes: int | None = Field(
        default=None,
        ge=1,
        le=60,
        validation_alias=AliasChoices(
            "AUTH_ACCESS_TOKEN_EXPIRE_MINUTES",
            "auth_access_token_expire_minutes",
        ),
    )
    legacy_admin_jwt_secret_input: SecretStr | None = Field(
        default=None,
        repr=False,
        exclude=True,
        validation_alias=AliasChoices("ADMIN_JWT_SECRET", "admin_jwt_secret"),
    )
    legacy_admin_access_token_expire_minutes_input: int | None = Field(
        default=None,
        exclude=True,
        ge=1,
        le=60,
        validation_alias=AliasChoices(
            "ADMIN_ACCESS_TOKEN_EXPIRE_MINUTES",
            "admin_access_token_expire_minutes",
        ),
    )

    @field_validator("auth_jwt_secret", "legacy_admin_jwt_secret_input")
    @classmethod
    def validate_auth_jwt_secret(
        cls, auth_jwt_secret: SecretStr | None
    ) -> SecretStr | None:
        """Require sufficient JWT key material without changing the secret."""
        if auth_jwt_secret is None:
            return None

        raw_secret = auth_jwt_secret.get_secret_value()
        if not raw_secret.strip():
            raise ValueError("Authentication JWT secret must not be blank")
        if len(raw_secret.encode("utf-8")) < 32:
            raise ValueError(
                "Authentication JWT secret must contain at least 32 UTF-8 bytes"
            )
        return auth_jwt_secret

    @model_validator(mode="after")
    def resolve_auth_compatibility_inputs(self) -> "Settings":
        """Resolve canonical and legacy auth inputs without accepting conflicts."""
        canonical_secret = self.auth_jwt_secret
        legacy_secret = self.legacy_admin_jwt_secret_input
        if canonical_secret is not None and legacy_secret is not None:
            if canonical_secret.get_secret_value() != legacy_secret.get_secret_value():
                raise ValueError("Authentication JWT secret settings conflict")
        self.auth_jwt_secret = canonical_secret or legacy_secret

        canonical_expiry = self.auth_access_token_expire_minutes
        legacy_expiry = self.legacy_admin_access_token_expire_minutes_input
        if (
            canonical_expiry is not None
            and legacy_expiry is not None
            and canonical_expiry != legacy_expiry
        ):
            raise ValueError("Authentication access-token lifetime settings conflict")
        self.auth_access_token_expire_minutes = (
            canonical_expiry
            if canonical_expiry is not None
            else legacy_expiry if legacy_expiry is not None else 30
        )
        return self

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
        hide_input_in_errors=True,
        populate_by_name=True,
    )
