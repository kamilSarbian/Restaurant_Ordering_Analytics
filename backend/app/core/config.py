from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = REPOSITORY_ROOT / ".env"


class Settings(BaseSettings):
    """Define configuration for the FastAPI application."""

    app_name: str = "Restaurant Ordering & Analytics API"
    app_version: str = "0.1.0"
    app_environment: str = "development"
    app_debug: bool = False

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )
