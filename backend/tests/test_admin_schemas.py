"""Unit tests for administrator authentication schemas."""

from __future__ import annotations

from uuid import UUID

import email_validator.deliverability
import pytest
from pydantic import SecretStr, ValidationError

from app.auth.schemas import (
    AdminLoginRequest,
    AdminMeResponse,
    AdminPrincipal,
    AdminTokenResponse,
    normalize_admin_email,
)

ADMIN_ID = UUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")


def test_normalize_admin_email_trims_validates_and_lowercases() -> None:
    """Canonicalize a syntactically valid mixed-case identity."""
    assert normalize_admin_email("  Admin@EXAMPLE.COM  ") == "admin@example.com"


@pytest.mark.parametrize("email", ["", "not-an-email", "admin@", "@example.com"])
def test_normalize_admin_email_rejects_invalid_syntax(email: str) -> None:
    """Reject malformed administrator identities."""
    with pytest.raises(ValueError):
        normalize_admin_email(email)


def test_normalize_admin_email_never_checks_dns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep login identity normalization independent of DNS and network access."""

    def fail_if_called(*_: object, **__: object) -> None:
        raise AssertionError("DNS deliverability validation was called")

    monkeypatch.setattr(
        email_validator.deliverability,
        "validate_email_deliverability",
        fail_if_called,
    )
    assert normalize_admin_email("Admin@example.com") == "admin@example.com"


@pytest.mark.parametrize("length", [1, 128])
def test_login_password_accepts_approved_boundaries(length: int) -> None:
    """Accept the full 1 through 128 code-point login-input range."""
    password = "p" * length
    request = AdminLoginRequest(email="admin@example.com", password=password)
    assert request.password.get_secret_value() == password


@pytest.mark.parametrize("password", ["", "p" * 129])
def test_login_password_rejects_values_outside_boundaries(password: str) -> None:
    """Reject empty and overlong login password inputs."""
    with pytest.raises(ValidationError):
        AdminLoginRequest(email="admin@example.com", password=password)


def test_login_password_preserves_unicode_and_whitespace() -> None:
    """Preserve exact Unicode password input without trimming or normalization."""
    password = "  \N{LATIN SMALL LETTER E WITH ACUTE}\N{BULLET}  "
    request = AdminLoginRequest(email="admin@example.com", password=password)
    assert request.password.get_secret_value() == password


def test_login_password_does_not_apply_bootstrap_minimum() -> None:
    """Keep login validation distinct from the 15-character bootstrap policy."""
    request = AdminLoginRequest(email="admin@example.com", password="short")
    assert request.password.get_secret_value() == "short"


def test_login_request_uses_secretstr_without_repr_leakage() -> None:
    """Hide the raw login password from ordinary model representations."""
    password = "synthetic-login-password"
    request = AdminLoginRequest(email="admin@example.com", password=password)
    assert isinstance(request.password, SecretStr)
    assert password not in repr(request)
    assert password not in str(request)


@pytest.mark.parametrize(
    ("model_type", "values"),
    [
        (
            AdminLoginRequest,
            {"email": "admin@example.com", "password": "p", "role": "admin"},
        ),
        (
            AdminTokenResponse,
            {
                "access_token": "synthetic-token",
                "token_type": "bearer",
                "expires_in": 1800,
                "refresh_token": "synthetic-refresh",
            },
        ),
        (
            AdminMeResponse,
            {"email": "admin@example.com", "is_active": True, "role": "admin"},
        ),
    ],
)
def test_public_admin_schemas_forbid_extra_fields(
    model_type: type[AdminLoginRequest | AdminTokenResponse | AdminMeResponse],
    values: dict[str, object],
) -> None:
    """Reject fields outside each exact public authentication contract."""
    with pytest.raises(ValidationError):
        model_type(**values)


def test_token_response_has_exact_fields_and_constraints() -> None:
    """Expose only a nonempty bearer token and positive relative lifetime."""
    response = AdminTokenResponse(
        access_token="synthetic-token",
        token_type="bearer",
        expires_in=1800,
    )
    assert set(AdminTokenResponse.model_fields) == {
        "access_token",
        "token_type",
        "expires_in",
    }
    assert response.model_dump() == {
        "access_token": "synthetic-token",
        "token_type": "bearer",
        "expires_in": 1800,
    }
    for values in (
        {"access_token": "", "token_type": "bearer", "expires_in": 1800},
        {"access_token": "synthetic-token", "token_type": "Bearer", "expires_in": 1800},
        {"access_token": "synthetic-token", "token_type": "bearer", "expires_in": 0},
    ):
        with pytest.raises(ValidationError):
            AdminTokenResponse(**values)


def test_me_response_has_exact_fields_and_normalized_email() -> None:
    """Expose only normalized email and active state for the current admin."""
    response = AdminMeResponse(email=" Admin@EXAMPLE.COM ", is_active=True)
    assert set(AdminMeResponse.model_fields) == {"email", "is_active"}
    assert response.model_dump() == {"email": "admin@example.com", "is_active": True}


def test_admin_principal_is_exact_normalized_and_immutable() -> None:
    """Carry only immutable internal identity data in canonical form."""
    principal = AdminPrincipal(id=ADMIN_ID, email=" Admin@EXAMPLE.COM ")
    assert set(AdminPrincipal.model_fields) == {"id", "email"}
    assert principal.id == ADMIN_ID
    assert principal.email == "admin@example.com"
    with pytest.raises(ValidationError):
        principal.email = "other@example.com"
