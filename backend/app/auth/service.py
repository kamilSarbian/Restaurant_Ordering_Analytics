"""Legacy administrator authentication and canonical user-token services."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import jwt
from jwt.exceptions import InvalidTokenError
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import AdminUser
from app.auth.passwords import verify_dummy_password, verify_password
from app.auth.schemas import AdminPrincipal
from app.auth.tokens import (
    ALGORITHM,
    DEFAULT_ACCESS_TOKEN_EXPIRE_MINUTES,
    ISSUER,
    MAX_ACCESS_TOKEN_EXPIRE_MINUTES,
    MIN_ACCESS_TOKEN_EXPIRE_MINUTES,
    AdminTokenInvalidError,
    AdminTokenService,
)

USER_AUDIENCE = "restaurant-ordering-analytics-user"
USER_TOKEN_TYPE = "user_access"
USER_REQUIRED_CLAIMS = ("sub", "type", "iat", "exp", "iss", "aud")


class AdminAuthenticationError(Exception):
    """Report an administrator credential failure without distinguishing its cause."""


class UserTokenConfigurationError(ValueError):
    """Report invalid canonical token-service configuration safely."""


class UserTokenInvalidError(ValueError):
    """Report a canonical token that fails authentication or claim validation."""


class UserTokenExpiredError(UserTokenInvalidError):
    """Report a correctly structured canonical token after expiration."""


def create_auth_token_services(
    auth_jwt_secret: str | SecretStr | None,
    auth_access_token_expire_minutes: int,
) -> tuple[UserTokenService | None, AdminTokenService | None]:
    """Build canonical and legacy validators from one effective auth config.

    Args:
        auth_jwt_secret: Effective generic signing key or None when auth is off.
        auth_access_token_expire_minutes: Shared access-token lifetime in minutes.

    Returns:
        Canonical user service and transitional legacy validator, or two None
        values when no signing key is configured.
    """
    if auth_jwt_secret is None:
        return None, None
    return (
        UserTokenService(
            auth_jwt_secret,
            auth_access_token_expire_minutes,
        ),
        AdminTokenService(
            auth_jwt_secret,
            auth_access_token_expire_minutes,
        ),
    )


@dataclass(frozen=True, slots=True)
class UserTokenClaims:
    """Expose validated canonical identity and token timestamps."""

    user_id: UUID
    issued_at: datetime
    expires_at: datetime


def _system_utc_now() -> datetime:
    return datetime.now(UTC)


class UserTokenService:
    """Issue and validate audience-isolated canonical user access tokens."""

    def __init__(
        self,
        secret: str | SecretStr,
        access_token_expire_minutes: int = DEFAULT_ACCESS_TOKEN_EXPIRE_MINUTES,
        now_provider: Callable[[], datetime] = _system_utc_now,
    ) -> None:
        """Configure canonical signing with validated transitional key material."""
        self._secret = self._validate_secret(secret)
        if (
            type(access_token_expire_minutes) is not int
            or not MIN_ACCESS_TOKEN_EXPIRE_MINUTES
            <= access_token_expire_minutes
            <= MAX_ACCESS_TOKEN_EXPIRE_MINUTES
        ):
            raise UserTokenConfigurationError(
                "User access-token lifetime must be from 1 to 60 minutes"
            )
        self._access_token_expire_minutes = access_token_expire_minutes
        self._now_provider = now_provider

    def create_access_token(self, user_id: UUID) -> str:
        """Create a signed user_access token containing only six fixed claims."""
        now = self._now()
        issued_at = int(now.timestamp())
        expires_at = issued_at + self._access_token_expire_minutes * 60
        payload = {
            "sub": str(user_id),
            "type": USER_TOKEN_TYPE,
            "iat": issued_at,
            "exp": expires_at,
            "iss": ISSUER,
            "aud": USER_AUDIENCE,
        }
        return jwt.encode(payload, self._secret, algorithm=ALGORITHM)

    def decode_access_token(self, token: str) -> UserTokenClaims:
        """Authenticate and parse one canonical user_access token."""
        if not isinstance(token, str) or not token.strip():
            raise UserTokenInvalidError("User access token is invalid")
        try:
            payload = jwt.decode(
                token,
                self._secret,
                algorithms=[ALGORITHM],
                audience=USER_AUDIENCE,
                issuer=ISSUER,
                leeway=0,
                options={
                    "require": list(USER_REQUIRED_CLAIMS),
                    "verify_exp": False,
                    "verify_iat": False,
                },
            )
        except InvalidTokenError:
            raise UserTokenInvalidError("User access token is invalid") from None
        return self._validate_claims(payload)

    @staticmethod
    def _validate_secret(secret: str | SecretStr) -> str:
        if isinstance(secret, SecretStr):
            raw_secret = secret.get_secret_value()
        elif isinstance(secret, str):
            raw_secret = secret
        else:
            raise UserTokenConfigurationError("User JWT secret must be text")
        if not raw_secret.strip():
            raise UserTokenConfigurationError("User JWT secret must not be blank")
        if len(raw_secret.encode("utf-8")) < 32:
            raise UserTokenConfigurationError(
                "User JWT secret must contain at least 32 UTF-8 bytes"
            )
        return raw_secret

    def _now(self) -> datetime:
        now = self._now_provider()
        if (
            not isinstance(now, datetime)
            or now.tzinfo is None
            or now.utcoffset() is None
        ):
            raise UserTokenConfigurationError(
                "User token clock must return an aware datetime"
            )
        return now.astimezone(UTC)

    def _validate_claims(self, payload: dict[str, Any]) -> UserTokenClaims:
        subject = payload.get("sub")
        if not isinstance(subject, str):
            self._raise_invalid()
        try:
            user_id = UUID(subject)
        except (ValueError, AttributeError):
            self._raise_invalid()
        if subject != str(user_id):
            self._raise_invalid()
        if payload.get("type") != USER_TOKEN_TYPE:
            self._raise_invalid()
        if payload.get("iss") != ISSUER or payload.get("aud") != USER_AUDIENCE:
            self._raise_invalid()

        issued_at = self._integer_claim(payload, "iat")
        expires_at = self._integer_claim(payload, "exp")
        if expires_at <= issued_at:
            self._raise_invalid()
        now_timestamp = self._now().timestamp()
        if issued_at > now_timestamp:
            self._raise_invalid()
        if expires_at <= now_timestamp:
            raise UserTokenExpiredError("User access token has expired")
        try:
            issued_at_datetime = datetime.fromtimestamp(issued_at, UTC)
            expires_at_datetime = datetime.fromtimestamp(expires_at, UTC)
        except (OverflowError, OSError, ValueError):
            self._raise_invalid()
        return UserTokenClaims(
            user_id=user_id,
            issued_at=issued_at_datetime,
            expires_at=expires_at_datetime,
        )

    @staticmethod
    def _integer_claim(payload: dict[str, Any], name: str) -> int:
        value = payload.get(name)
        if type(value) is not int:
            UserTokenService._raise_invalid()
        return value

    @staticmethod
    def _raise_invalid() -> None:
        raise UserTokenInvalidError("User access token is invalid")


def decode_admin_compatible_token(
    token: str,
    *,
    user_token_service: UserTokenService | None,
    legacy_token_service: AdminTokenService | None,
) -> UUID:
    """Validate either strict token family for transitional administrator auth.

    Args:
        token: Opaque Bearer JWT received from the administrator boundary.
        user_token_service: Canonical user_access validator when configured.
        legacy_token_service: Transitional admin_access validator when configured.

    Returns:
        The canonical User UUID identified by either valid token family.

    Raises:
        UserTokenConfigurationError: If neither validator is configured.
        UserTokenInvalidError: If neither strict token contract accepts the token.
        AdminTokenConfigurationError: If legacy validation configuration fails.
    """
    if user_token_service is not None:
        try:
            return user_token_service.decode_access_token(token).user_id
        except UserTokenInvalidError:
            pass

    if legacy_token_service is not None:
        try:
            return legacy_token_service.decode_access_token(token).admin_id
        except AdminTokenInvalidError:
            pass

    if user_token_service is None and legacy_token_service is None:
        raise UserTokenConfigurationError(
            "Administrator token validation service is unavailable"
        )
    raise UserTokenInvalidError("Administrator access token is invalid")


def authenticate_admin(
    session: Session,
    *,
    email: str,
    password: str,
) -> AdminPrincipal:
    """Authenticate one administrator through an exact normalized email lookup.

    Args:
        session: Database session used only for the identity lookup.
        email: Already-normalized administrator email address.
        password: Exact submitted password without normalization.

    Returns:
        Immutable authenticated administrator identity.

    Raises:
        AdminAuthenticationError: If the identity is unknown, the password is
            wrong, or the administrator is inactive.
    """
    admin = session.scalar(select(AdminUser).where(AdminUser.email == email))
    if admin is None:
        verify_dummy_password(password)
        raise AdminAuthenticationError("Administrator credentials are invalid")

    password_matches = verify_password(password, admin.password_hash)
    if not password_matches or not admin.is_active:
        raise AdminAuthenticationError("Administrator credentials are invalid")

    return AdminPrincipal(id=admin.id, email=admin.email)
