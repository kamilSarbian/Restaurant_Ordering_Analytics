"""Unit tests for administrator JWT access-token primitives."""

from __future__ import annotations

import json
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
import pytest
from pydantic import SecretStr

from app.auth.tokens import (
    ALGORITHM,
    AUDIENCE,
    ISSUER,
    TOKEN_TYPE,
    AdminTokenConfigurationError,
    AdminTokenExpiredError,
    AdminTokenInvalidError,
    AdminTokenService,
)

ADMIN_ID = UUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")
VERSION_ONE_ADMIN_ID = UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
FIXED_NOW = datetime(2026, 8, 8, 12, tzinfo=UTC)
ISSUED_AT = int(FIXED_NOW.timestamp())
SYNTHETIC_SECRET = "s" * 32
OTHER_SYNTHETIC_SECRET = "o" * 32


def _now() -> datetime:
    return FIXED_NOW


def _payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "sub": str(ADMIN_ID),
        "type": TOKEN_TYPE,
        "iat": ISSUED_AT,
        "exp": ISSUED_AT + 1800,
        "iss": ISSUER,
        "aud": AUDIENCE,
    }
    payload.update(overrides)
    return payload


def _signed_token(
    payload: dict[str, object] | None = None,
    *,
    secret: str | None = SYNTHETIC_SECRET,
    algorithm: str = ALGORITHM,
) -> str:
    return jwt.encode(payload or _payload(), secret, algorithm=algorithm)


def _raw_signed_token(payload: dict[str, object]) -> str:
    return jwt.api_jws.encode(
        json.dumps(payload, separators=(",", ":")).encode(),
        SYNTHETIC_SECRET,
        algorithm=ALGORITHM,
    )


def _service(
    *,
    secret: str | SecretStr = SYNTHETIC_SECRET,
    minutes: int = 30,
    now: datetime = FIXED_NOW,
) -> AdminTokenService:
    return AdminTokenService(
        secret,
        access_token_expire_minutes=minutes,
        now_provider=lambda: now,
    )


@pytest.mark.parametrize("secret", ["", " " * 32, "s" * 31, 123])
def test_service_rejects_invalid_secret_configuration(secret: object) -> None:
    """Reject blank, short, and non-text HS256 key material safely."""
    with pytest.raises(AdminTokenConfigurationError):
        AdminTokenService(secret)  # type: ignore[arg-type]


def test_service_accepts_secretstr_and_utf8_byte_boundary() -> None:
    """Accept SecretStr and count multi-byte key material by UTF-8 bytes."""
    service = _service(secret=SecretStr("\N{LOCK}" * 8))
    assert (
        service.decode_access_token(service.create_access_token(ADMIN_ID)).admin_id
        == ADMIN_ID
    )
    with pytest.raises(AdminTokenConfigurationError):
        _service(secret="\N{LOCK}" * 7)


def test_service_representation_does_not_reveal_secret() -> None:
    """Keep raw signing key material out of ordinary service representations."""
    service = _service()
    assert SYNTHETIC_SECRET not in repr(service)
    assert SYNTHETIC_SECRET not in str(service)


@pytest.mark.parametrize("minutes", [1, 60])
def test_service_accepts_ttl_boundaries(minutes: int) -> None:
    """Accept the approved access-token lifetime boundaries."""
    service = _service(minutes=minutes)
    token = service.create_access_token(ADMIN_ID)
    claims = jwt.decode(token, options={"verify_signature": False})
    assert claims["exp"] - claims["iat"] == minutes * 60


@pytest.mark.parametrize("minutes", [0, 61, True])
def test_service_rejects_invalid_ttl_configuration(minutes: object) -> None:
    """Reject lifetimes outside 1 through 60 integer minutes."""
    with pytest.raises(AdminTokenConfigurationError):
        AdminTokenService(
            SYNTHETIC_SECRET,
            access_token_expire_minutes=minutes,  # type: ignore[arg-type]
        )


def test_encode_uses_exact_header_claims_and_default_ttl() -> None:
    """Issue the fixed six-claim contract with HS256 and a 30-minute lifetime."""
    token = _service().create_access_token(ADMIN_ID)
    assert jwt.get_unverified_header(token)["alg"] == ALGORITHM
    claims = jwt.decode(token, options={"verify_signature": False})
    assert claims == _payload()
    assert claims["exp"] - claims["iat"] == 1800


def test_encode_excludes_sensitive_or_unapproved_claims() -> None:
    """Keep credentials, authorization state, and mutable identity out of JWTs."""
    token = _service().create_access_token(ADMIN_ID)
    claims = jwt.decode(token, options={"verify_signature": False})
    assert {
        "email",
        "role",
        "password",
        "password_hash",
        "is_active",
        "token_version",
    }.isdisjoint(claims)


def test_valid_decode_returns_immutable_aware_utc_claims() -> None:
    """Return only canonical identity and timezone-aware token timestamps."""
    claims = _service().decode_access_token(_signed_token())
    assert claims.admin_id == ADMIN_ID
    assert claims.issued_at == FIXED_NOW
    assert claims.expires_at == FIXED_NOW + timedelta(minutes=30)
    assert claims.issued_at.tzinfo is UTC
    assert claims.expires_at.tzinfo is UTC
    with pytest.raises(FrozenInstanceError):
        claims.admin_id = VERSION_ONE_ADMIN_ID


def test_decode_accepts_canonical_uuid_without_requiring_version_four() -> None:
    """Accept any UUID version when the subject uses canonical text."""
    token = _signed_token(_payload(sub=str(VERSION_ONE_ADMIN_ID)))
    assert _service().decode_access_token(token).admin_id == VERSION_ONE_ADMIN_ID


def test_wrong_secret_is_mapped_to_stable_invalid_error() -> None:
    """Map signature failure to the local token exception contract."""
    token = _signed_token(secret=OTHER_SYNTHETIC_SECRET)
    with pytest.raises(AdminTokenInvalidError) as exc_info:
        _service().decode_access_token(token)
    assert type(exc_info.value) is AdminTokenInvalidError


@pytest.mark.parametrize("token", ["", "   ", "not-a-jwt", "a.b.c"])
def test_empty_or_malformed_token_is_rejected_safely(token: str) -> None:
    """Reject unusable compact token input through the stable local error."""
    with pytest.raises(AdminTokenInvalidError):
        _service().decode_access_token(token)


@pytest.mark.parametrize("missing_claim", ["sub", "type", "iat", "exp", "iss", "aud"])
def test_missing_required_claim_is_rejected(missing_claim: str) -> None:
    """Require every claim in the approved six-claim contract."""
    payload = _payload()
    del payload[missing_claim]
    with pytest.raises(AdminTokenInvalidError):
        _service().decode_access_token(_signed_token(payload))


@pytest.mark.parametrize(
    "subject",
    [
        123,
        "not-a-uuid",
        "F47AC10B-58CC-4372-A567-0E02B2C3D479",
        "f47ac10b58cc4372a5670e02b2c3d479",
        "{f47ac10b-58cc-4372-a567-0e02b2c3d479}",
    ],
)
def test_malformed_or_noncanonical_subject_is_rejected(subject: object) -> None:
    """Reject non-UUID subjects and alternate UUID text forms."""
    with pytest.raises(AdminTokenInvalidError):
        _service().decode_access_token(_signed_token(_payload(sub=subject)))


@pytest.mark.parametrize("token_type", [None, "", "access", "ADMIN_ACCESS"])
def test_missing_or_wrong_token_type_is_rejected(token_type: object) -> None:
    """Accept only the fixed administrator access-token discriminator."""
    payload = _payload()
    if token_type is None:
        del payload["type"]
    else:
        payload["type"] = token_type
    with pytest.raises(AdminTokenInvalidError):
        _service().decode_access_token(_signed_token(payload))


@pytest.mark.parametrize("issuer", ["wrong-issuer", 123])
def test_wrong_issuer_is_rejected(issuer: object) -> None:
    """Require the fixed API issuer value and type."""
    token = (
        _signed_token(_payload(iss=issuer))
        if isinstance(issuer, str)
        else _raw_signed_token(_payload(iss=issuer))
    )
    with pytest.raises(AdminTokenInvalidError):
        _service().decode_access_token(token)


@pytest.mark.parametrize("audience", ["wrong-audience", [AUDIENCE], 123])
def test_wrong_or_nonexact_audience_is_rejected(audience: object) -> None:
    """Require the exact scalar administrator audience value."""
    with pytest.raises(AdminTokenInvalidError):
        _service().decode_access_token(_signed_token(_payload(aud=audience)))


@pytest.mark.parametrize("issued_at", ["0", 1.5, True])
def test_noninteger_issued_at_is_rejected(issued_at: object) -> None:
    """Reject encoded-at timestamps that are not JSON integers."""
    with pytest.raises(AdminTokenInvalidError):
        _service().decode_access_token(_signed_token(_payload(iat=issued_at)))


@pytest.mark.parametrize("expires_at", ["1", 1.5, True])
def test_noninteger_expiration_is_rejected(expires_at: object) -> None:
    """Reject expiration timestamps that are not JSON integers."""
    with pytest.raises(AdminTokenInvalidError):
        _service().decode_access_token(_signed_token(_payload(exp=expires_at)))


@pytest.mark.parametrize("expires_at", [ISSUED_AT, ISSUED_AT - 1])
def test_expiration_not_after_issued_at_is_rejected(expires_at: int) -> None:
    """Require a strictly positive signed token lifetime."""
    with pytest.raises(AdminTokenInvalidError) as exc_info:
        _service(now=FIXED_NOW - timedelta(seconds=10)).decode_access_token(
            _signed_token(_payload(exp=expires_at))
        )
    assert type(exc_info.value) is AdminTokenInvalidError


def test_future_issued_at_is_rejected() -> None:
    """Reject tokens issued after the injected validation clock."""
    token = _signed_token(_payload(iat=ISSUED_AT + 1, exp=ISSUED_AT + 1801))
    with pytest.raises(AdminTokenInvalidError):
        _service().decode_access_token(token)


def test_token_is_valid_one_second_before_expiration() -> None:
    """Accept a token immediately before its strict expiration boundary."""
    token = _signed_token()
    claims = _service(now=FIXED_NOW + timedelta(seconds=1799)).decode_access_token(
        token
    )
    assert claims.expires_at == FIXED_NOW + timedelta(minutes=30)


def test_token_is_expired_exactly_at_expiration() -> None:
    """Reject a token when the injected clock equals its expiration."""
    token = _signed_token()
    with pytest.raises(AdminTokenExpiredError):
        _service(now=FIXED_NOW + timedelta(seconds=1800)).decode_access_token(token)


@pytest.mark.parametrize("algorithm", ["none", "HS384"])
def test_none_or_incompatible_algorithm_is_rejected(algorithm: str) -> None:
    """Enforce the fixed HS256 allow-list against algorithm substitution."""
    secret = None if algorithm == "none" else "s" * 48
    token = _signed_token(secret=secret, algorithm=algorithm)
    with pytest.raises(AdminTokenInvalidError):
        _service().decode_access_token(token)


def test_extra_signed_claims_are_tolerated_but_not_returned() -> None:
    """Ignore authenticated forward-compatible claims at the internal boundary."""
    token = _signed_token(_payload(trace_id="synthetic-trace"))
    claims = _service().decode_access_token(token)
    assert set(claims.__slots__) == {"admin_id", "issued_at", "expires_at"}


def test_naive_clock_is_rejected_as_configuration_error() -> None:
    """Require an aware injected clock before token generation or validation."""
    service = _service(now=FIXED_NOW.replace(tzinfo=None))
    with pytest.raises(AdminTokenConfigurationError):
        service.create_access_token(ADMIN_ID)
