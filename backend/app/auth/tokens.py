"""JWT access-token primitives for administrator authentication."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import jwt
from jwt.exceptions import InvalidTokenError
from pydantic import SecretStr

ALGORITHM = "HS256"
ISSUER = "restaurant-ordering-analytics-api"
AUDIENCE = "restaurant-ordering-analytics-admin"
TOKEN_TYPE = "admin_access"
REQUIRED_CLAIMS = ("sub", "type", "iat", "exp", "iss", "aud")
DEFAULT_ACCESS_TOKEN_EXPIRE_MINUTES = 30
MIN_ACCESS_TOKEN_EXPIRE_MINUTES = 1
MAX_ACCESS_TOKEN_EXPIRE_MINUTES = 60


class AdminTokenConfigurationError(ValueError):
    """Report invalid local token-service configuration safely."""


class AdminTokenInvalidError(ValueError):
    """Report a token that fails authentication or claim validation."""


class AdminTokenExpiredError(AdminTokenInvalidError):
    """Report a correctly structured token at or beyond its expiration."""


@dataclass(frozen=True, slots=True)
class AdminTokenClaims:
    """Expose the validated administrator identity and token time window."""

    admin_id: UUID
    issued_at: datetime
    expires_at: datetime


def _system_utc_now() -> datetime:
    return datetime.now(UTC)


class AdminTokenService:
    """Issue and validate fixed-contract administrator HS256 access tokens."""

    def __init__(
        self,
        secret: str | SecretStr,
        access_token_expire_minutes: int = DEFAULT_ACCESS_TOKEN_EXPIRE_MINUTES,
        now_provider: Callable[[], datetime] = _system_utc_now,
    ) -> None:
        """Configure the token service with validated local key material.

        Args:
            secret: HS256 key material containing at least 32 UTF-8 bytes.
            access_token_expire_minutes: Access-token lifetime from 1 to 60 minutes.
            now_provider: Injectable timezone-aware clock used for all time checks.

        Raises:
            AdminTokenConfigurationError: If key material or TTL is invalid.
        """
        self._secret = self._validate_secret(secret)
        if (
            type(access_token_expire_minutes) is not int
            or not MIN_ACCESS_TOKEN_EXPIRE_MINUTES
            <= access_token_expire_minutes
            <= MAX_ACCESS_TOKEN_EXPIRE_MINUTES
        ):
            raise AdminTokenConfigurationError(
                "Administrator access-token lifetime must be from 1 to 60 minutes"
            )
        self._access_token_expire_minutes = access_token_expire_minutes
        self._now_provider = now_provider

    def create_access_token(self, admin_id: UUID) -> str:
        """Create one signed administrator access token for a UUID identity.

        Args:
            admin_id: Persisted administrator identifier.

        Returns:
            A signed JWT containing only the approved six claims.
        """
        now = self._now()
        issued_at = int(now.timestamp())
        expires_at = issued_at + self._access_token_expire_minutes * 60
        payload = {
            "sub": str(admin_id),
            "type": TOKEN_TYPE,
            "iat": issued_at,
            "exp": expires_at,
            "iss": ISSUER,
            "aud": AUDIENCE,
        }
        return jwt.encode(payload, self._secret, algorithm=ALGORITHM)

    def decode_access_token(self, token: str) -> AdminTokenClaims:
        """Authenticate and parse one administrator access token.

        Args:
            token: Compact JWT text received from an authentication boundary.

        Returns:
            Immutable validated identity and UTC token timestamps.

        Raises:
            AdminTokenExpiredError: If the token is at or beyond expiration.
            AdminTokenInvalidError: If authentication or any claim check fails.
            AdminTokenConfigurationError: If the injected clock is invalid.
        """
        if not isinstance(token, str) or not token.strip():
            raise AdminTokenInvalidError("Administrator access token is invalid")

        try:
            payload = jwt.decode(
                token,
                self._secret,
                algorithms=[ALGORITHM],
                audience=AUDIENCE,
                issuer=ISSUER,
                leeway=0,
                options={
                    "require": list(REQUIRED_CLAIMS),
                    "verify_exp": False,
                    "verify_iat": False,
                },
            )
        except InvalidTokenError:
            raise AdminTokenInvalidError(
                "Administrator access token is invalid"
            ) from None

        return self._validate_claims(payload)

    @staticmethod
    def _validate_secret(secret: str | SecretStr) -> str:
        if isinstance(secret, SecretStr):
            raw_secret = secret.get_secret_value()
        elif isinstance(secret, str):
            raw_secret = secret
        else:
            raise AdminTokenConfigurationError("Administrator JWT secret must be text")

        if not raw_secret.strip():
            raise AdminTokenConfigurationError(
                "Administrator JWT secret must not be blank"
            )
        if len(raw_secret.encode("utf-8")) < 32:
            raise AdminTokenConfigurationError(
                "Administrator JWT secret must contain at least 32 UTF-8 bytes"
            )
        return raw_secret

    def _now(self) -> datetime:
        now = self._now_provider()
        if (
            not isinstance(now, datetime)
            or now.tzinfo is None
            or now.utcoffset() is None
        ):
            raise AdminTokenConfigurationError(
                "Administrator token clock must return an aware datetime"
            )
        return now.astimezone(UTC)

    def _validate_claims(self, payload: dict[str, Any]) -> AdminTokenClaims:
        subject = payload.get("sub")
        if not isinstance(subject, str):
            self._raise_invalid()
        try:
            admin_id = UUID(subject)
        except (ValueError, AttributeError):
            self._raise_invalid()
        if subject != str(admin_id):
            self._raise_invalid()

        if payload.get("type") != TOKEN_TYPE:
            self._raise_invalid()
        if payload.get("iss") != ISSUER or payload.get("aud") != AUDIENCE:
            self._raise_invalid()

        issued_at = self._integer_claim(payload, "iat")
        expires_at = self._integer_claim(payload, "exp")
        if expires_at <= issued_at:
            self._raise_invalid()

        now_timestamp = self._now().timestamp()
        if issued_at > now_timestamp:
            self._raise_invalid()
        if expires_at <= now_timestamp:
            raise AdminTokenExpiredError("Administrator access token has expired")

        try:
            issued_at_datetime = datetime.fromtimestamp(issued_at, UTC)
            expires_at_datetime = datetime.fromtimestamp(expires_at, UTC)
        except (OverflowError, OSError, ValueError):
            self._raise_invalid()
        return AdminTokenClaims(
            admin_id=admin_id,
            issued_at=issued_at_datetime,
            expires_at=expires_at_datetime,
        )

    @staticmethod
    def _integer_claim(payload: dict[str, Any], name: str) -> int:
        value = payload.get(name)
        if type(value) is not int:
            AdminTokenService._raise_invalid()
        return value

    @staticmethod
    def _raise_invalid() -> None:
        raise AdminTokenInvalidError("Administrator access token is invalid")
