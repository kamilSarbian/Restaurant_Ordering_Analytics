from pathlib import Path

from pydantic import Field, PostgresDsn, SecretStr, field_validator
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
    admin_jwt_secret: SecretStr | None = Field(default=None, repr=False)
    admin_access_token_expire_minutes: int = Field(default=30, ge=1, le=60)

    @field_validator("admin_jwt_secret")
    @classmethod
    def validate_admin_jwt_secret(
        cls, admin_jwt_secret: SecretStr | None
    ) -> SecretStr | None:
        """Require sufficient JWT key material without changing the secret."""
        if admin_jwt_secret is None:
            return None

        raw_secret = admin_jwt_secret.get_secret_value()
        if not raw_secret.strip():
            raise ValueError("Administrator JWT secret must not be blank")
        if len(raw_secret.encode("utf-8")) < 32:
            raise ValueError(
                "Administrator JWT secret must contain at least 32 UTF-8 bytes"
            )
        return admin_jwt_secret

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
    )
