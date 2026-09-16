import ipaddress
import re
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

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
ALEMBIC_HEAD_PATTERN = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*")
GIT_SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
HOST_LABEL_PATTERN = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
STRIPE_TEST_KEY_PREFIXES = ("sk_test_", "rk_test_")
AppEnvironment = Literal["development", "test", "e2e", "production"]


class Settings(BaseSettings):
    """Define configuration for the FastAPI application."""

    app_name: str = "Restaurant Ordering & Analytics API"
    app_version: str = "0.1.0"
    app_environment: AppEnvironment = "development"
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
    auth_access_token_expire_minutes: int = Field(
        default=30,
        ge=1,
        le=60,
        validation_alias=AliasChoices(
            "AUTH_ACCESS_TOKEN_EXPIRE_MINUTES",
            "auth_access_token_expire_minutes",
        ),
    )
    public_app_origin: str | None = None
    trusted_hosts: tuple[str, ...] = ()
    trusted_proxy_mode: Literal["direct"] | None = None
    stripe_expected_livemode: bool | None = None
    expected_alembic_head: str | None = None
    release_sha: str | None = None
    log_level: str = "INFO"

    @field_validator("database_url", mode="before")
    @classmethod
    def normalize_database_url_value(cls, database_url: object) -> object:
        """Normalize supported provider PostgreSQL URLs to the Psycopg 3 driver."""
        return normalize_database_url(database_url)

    @field_validator("auth_jwt_secret")
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

    @field_validator("public_app_origin")
    @classmethod
    def validate_public_app_origin(cls, origin: str | None) -> str | None:
        """Require one credential-free HTTPS origin without URL suffixes."""
        if origin is None:
            return None
        _parse_https_authority(origin)
        parsed = urlsplit(origin)
        if parsed.path or "?" in origin or "#" in origin:
            raise ValueError("Public application origin must be one exact HTTPS origin")
        return origin

    @field_validator("trusted_hosts")
    @classmethod
    def validate_trusted_hosts(cls, hosts: tuple[str, ...]) -> tuple[str, ...]:
        """Validate immutable exact hostnames without wildcard semantics."""
        validated = tuple(_validate_exact_host(host) for host in hosts)
        if len(set(validated)) != len(validated):
            raise ValueError("Trusted hosts must not contain duplicate entries")
        return validated

    @field_validator("expected_alembic_head")
    @classmethod
    def validate_expected_alembic_head(cls, value: str | None) -> str | None:
        """Accept one bounded lowercase Alembic revision identifier."""
        return validate_alembic_head(value)

    @field_validator("release_sha")
    @classmethod
    def validate_release_sha(cls, value: str | None) -> str | None:
        """Accept only a complete lowercase Git commit SHA."""
        if value is None:
            return None
        if GIT_SHA_PATTERN.fullmatch(value) is None:
            raise ValueError("Release SHA must be 40 lowercase hexadecimal characters")
        return value

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, value: str) -> str:
        """Normalize one supported application log level."""
        normalized = value.upper()
        if normalized not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError("Log level is not supported")
        return normalized

    @model_validator(mode="after")
    def validate_production_contract(self) -> "Settings":
        """Fail closed when the production deployment contract is incomplete."""
        if self.app_environment != "production":
            return self

        required_values = {
            "DATABASE_URL": self.database_url,
            "STRIPE_SECRET_KEY": self.stripe_secret_key,
            "STRIPE_WEBHOOK_SECRET": self.stripe_webhook_secret,
            "STRIPE_SUCCESS_URL": self.stripe_success_url,
            "STRIPE_CANCEL_URL": self.stripe_cancel_url,
            "AUTH_JWT_SECRET": self.auth_jwt_secret,
            "PUBLIC_APP_ORIGIN": self.public_app_origin,
            "TRUSTED_HOSTS": self.trusted_hosts,
            "TRUSTED_PROXY_MODE": self.trusted_proxy_mode,
            "STRIPE_EXPECTED_LIVEMODE": self.stripe_expected_livemode,
            "EXPECTED_ALEMBIC_HEAD": self.expected_alembic_head,
            "RELEASE_SHA": self.release_sha,
        }
        missing = [
            name
            for name, value in required_values.items()
            if value is None
            or value == ()
            or (isinstance(value, str) and not value.strip())
        ]
        if missing:
            raise ValueError(
                "Production configuration is missing required settings: "
                + ", ".join(missing)
            )
        if self.app_debug:
            raise ValueError("Production configuration requires APP_DEBUG=false")
        if self.stripe_expected_livemode is not False:
            raise ValueError(
                "Production configuration requires Stripe test mode explicitly"
            )

        public_hostname = urlsplit(self.public_app_origin or "").hostname
        if public_hostname not in self.trusted_hosts:
            raise ValueError(
                "PUBLIC_APP_ORIGIN hostname must be included in TRUSTED_HOSTS"
            )

        public_origin = self.public_app_origin or ""
        for redirect_url in (self.stripe_success_url, self.stripe_cancel_url):
            _validate_production_redirect_template(redirect_url or "", public_origin)

        stripe_secret = self.stripe_secret_key
        if stripe_secret is None or not _is_stripe_test_key(
            stripe_secret.get_secret_value()
        ):
            raise ValueError("Production configuration requires a Stripe test key")
        if (
            self.stripe_webhook_secret is None
            or not self.stripe_webhook_secret.get_secret_value().strip()
        ):
            raise ValueError("Production Stripe webhook secret must not be blank")
        return self

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
        hide_input_in_errors=True,
        populate_by_name=True,
    )


def normalize_database_url(database_url: object) -> str | None:
    """Normalize a PostgreSQL URL to the synchronous Psycopg 3 driver."""
    if database_url is None:
        return None

    raw_url = str(database_url)
    separator_index = raw_url.find("://")
    if separator_index <= 0:
        raise ValueError("Database URL must use PostgreSQL with Psycopg 3")

    scheme = raw_url[:separator_index].lower()
    remainder = raw_url[separator_index:]
    if scheme in {"postgres", "postgresql"}:
        return f"postgresql+psycopg{remainder}"
    if scheme != "postgresql+psycopg":
        raise ValueError("Database URL must use PostgreSQL with Psycopg 3")
    return raw_url


def validate_alembic_head(value: str | None) -> str | None:
    """Validate one bounded lowercase Alembic revision identifier."""
    if value is None:
        return None
    if len(value) > 128 or ALEMBIC_HEAD_PATTERN.fullmatch(value) is None:
        raise ValueError("Expected Alembic head must be a safe revision identifier")
    return value


def _validate_exact_host(host: str) -> str:
    """Normalize one exact DNS or IPv4 host without wildcard or port syntax."""
    if (
        host != host.strip()
        or not host
        or "*" in host
        or "://" in host
        or any(character in host for character in "/@:#?[]")
    ):
        raise ValueError("Trusted host must be one exact hostname without a port")

    normalized = host.lower()
    try:
        parsed_ip = ipaddress.ip_address(normalized)
    except ValueError:
        parsed_ip = None
    if parsed_ip is not None:
        if parsed_ip.version != 4:
            raise ValueError("Trusted host must be one exact hostname without a port")
        return normalized

    if len(normalized) > 253 or normalized.endswith("."):
        raise ValueError("Trusted host is malformed")
    labels = normalized.split(".")
    if any(HOST_LABEL_PATTERN.fullmatch(label) is None for label in labels):
        raise ValueError("Trusted host is malformed")
    return normalized


def _parse_https_authority(url: str) -> tuple[str, int]:
    """Return one canonical HTTPS hostname and effective port."""
    error_message = "URL must use one canonical credential-free HTTPS authority"
    if (
        url != url.strip()
        or not url.startswith("https://")
        or "*" in url
        or any(ord(character) < 32 or ord(character) == 127 for character in url)
    ):
        raise ValueError(error_message)
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        username = parsed.username
        password = parsed.password
        port = parsed.port
    except ValueError as exc:
        raise ValueError(error_message) from exc
    if (
        parsed.scheme != "https"
        or hostname is None
        or username is not None
        or password is not None
        or port == 0
    ):
        raise ValueError(error_message)

    normalized_host = _validate_exact_host(hostname)
    canonical_authority = (
        normalized_host if port is None else f"{normalized_host}:{port}"
    )
    if parsed.netloc != canonical_authority:
        raise ValueError(error_message)
    return normalized_host, 443 if port is None else port


def _validate_production_redirect_template(template: str, origin: str) -> None:
    """Require a supported Stripe redirect template on the public HTTPS origin."""
    placeholder = "{public_order_number}"
    if template.count(placeholder) > 1:
        raise ValueError("Production Stripe redirect URL is invalid")
    remainder = template.replace(placeholder, "")
    if "{" in remainder or "}" in remainder or "#" in template:
        raise ValueError("Production Stripe redirect URL is invalid")

    rendered = template.replace(placeholder, "ROA-000000000000")
    if _parse_https_authority(rendered) != _parse_https_authority(origin):
        raise ValueError("Production Stripe redirect URL must use PUBLIC_APP_ORIGIN")


def _is_stripe_test_key(secret: str) -> bool:
    """Recognize a nonblank Stripe test or restricted-test key form."""
    for prefix in STRIPE_TEST_KEY_PREFIXES:
        if secret.startswith(prefix):
            return bool(secret.removeprefix(prefix).strip())
    return False
