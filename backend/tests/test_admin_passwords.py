"""Unit tests for administrator password hashing and bootstrap policy."""

from __future__ import annotations

import re

import pytest

from app.auth import passwords
from app.auth.passwords import (
    AdminPasswordPolicyError,
    hash_password,
    validate_bootstrap_password,
    verify_dummy_password,
    verify_password,
)

SYNTHETIC_PASSWORD = "synthetic-admin-password"


def test_hash_is_argon2id_and_does_not_contain_the_password() -> None:
    """Create an Argon2id PHC value without retaining the source password."""
    password_hash = hash_password(SYNTHETIC_PASSWORD)
    assert password_hash != SYNTHETIC_PASSWORD
    assert SYNTHETIC_PASSWORD not in password_hash
    assert password_hash.startswith("$argon2id$")


def test_hash_uses_the_exact_approved_argon2_parameters() -> None:
    """Pin the approved OWASP Argon2id memory, time, and parallelism values."""
    password_hash = hash_password(SYNTHETIC_PASSWORD)
    match = re.search(r"\$m=(\d+),t=(\d+),p=(\d+)\$", password_hash)
    assert match is not None
    assert match.groups() == ("19456", "2", "1")


def test_correct_password_verifies() -> None:
    """Accept the exact password used to create the stored hash."""
    password_hash = hash_password(SYNTHETIC_PASSWORD)
    assert verify_password(SYNTHETIC_PASSWORD, password_hash) is True


def test_wrong_password_does_not_verify() -> None:
    """Reject a different password without raising a credential error."""
    password_hash = hash_password(SYNTHETIC_PASSWORD)
    assert verify_password("different-synthetic-password", password_hash) is False


def test_same_password_uses_distinct_library_generated_salts() -> None:
    """Produce different PHC values for the same password."""
    first_hash = hash_password(SYNTHETIC_PASSWORD)
    second_hash = hash_password(SYNTHETIC_PASSWORD)
    assert first_hash != second_hash
    assert verify_password(SYNTHETIC_PASSWORD, first_hash) is True
    assert verify_password(SYNTHETIC_PASSWORD, second_hash) is True


@pytest.mark.parametrize("password_hash", ["", "unsupported-hash", "$argon2id$"])
def test_malformed_or_unsupported_hash_fails_closed(password_hash: str) -> None:
    """Return false without leaking an invalid stored hash through an exception."""
    assert verify_password(SYNTHETIC_PASSWORD, password_hash) is False


def test_bootstrap_policy_rejects_fourteen_code_points() -> None:
    """Reject a bootstrap password immediately below the lower boundary."""
    with pytest.raises(AdminPasswordPolicyError, match="at least 15"):
        validate_bootstrap_password("a" * 14)


def test_bootstrap_policy_accepts_fifteen_code_points() -> None:
    """Accept the exact lower bootstrap-password boundary."""
    password = "a" * 15
    assert validate_bootstrap_password(password) is password


def test_bootstrap_policy_accepts_one_hundred_twenty_eight_code_points() -> None:
    """Accept the exact upper bootstrap-password boundary."""
    password = "a" * 128
    assert validate_bootstrap_password(password) is password


def test_bootstrap_policy_rejects_one_hundred_twenty_nine_code_points() -> None:
    """Reject a bootstrap password immediately above the upper boundary."""
    with pytest.raises(AdminPasswordPolicyError, match="at most 128"):
        validate_bootstrap_password("a" * 129)


def test_bootstrap_policy_accepts_unicode_without_composition_rules() -> None:
    """Count Unicode code points and require no ASCII character classes."""
    password = "界" * 15
    assert validate_bootstrap_password(password) == password


def test_bootstrap_policy_preserves_leading_and_trailing_whitespace() -> None:
    """Treat whitespace as password content without trimming or normalization."""
    password = "  simple phrase  "
    assert validate_bootstrap_password(password) == password


@pytest.mark.parametrize("password", ["a" * 15, "1" * 15, "!" * 15, " " * 15])
def test_bootstrap_policy_has_no_character_complexity_rules(password: str) -> None:
    """Accept any character class when the length boundary is satisfied."""
    assert validate_bootstrap_password(password) == password


def test_policy_error_does_not_include_submitted_password() -> None:
    """Keep rejected password material out of policy exception messages."""
    submitted_password = "short-secret"
    with pytest.raises(AdminPasswordPolicyError) as exc_info:
        validate_bootstrap_password(submitted_password)
    assert submitted_password not in str(exc_info.value)


def test_dummy_hash_is_created_lazily_once_and_verified_on_every_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cache only one generated dummy hash and perform one verify per attempt."""
    generated_sources = 0
    hash_calls = 0
    verify_calls = 0

    def fake_source(_: int) -> str:
        nonlocal generated_sources
        generated_sources += 1
        return "process-local-random-source"

    def fake_hash(source_material: str) -> str:
        nonlocal hash_calls
        hash_calls += 1
        assert source_material == "process-local-random-source"
        return f"synthetic-dummy-{hash_calls}"

    def fake_verify(candidate: str, dummy_hash: str) -> bool:
        nonlocal verify_calls
        verify_calls += 1
        assert candidate == SYNTHETIC_PASSWORD
        assert dummy_hash.startswith("synthetic-dummy-")
        return False

    monkeypatch.setattr(passwords, "_dummy_password_hash", None)
    monkeypatch.setattr(passwords.secrets, "token_urlsafe", fake_source)
    monkeypatch.setattr(passwords, "hash_password", fake_hash)
    monkeypatch.setattr(passwords, "verify_password", fake_verify)

    assert generated_sources == hash_calls == verify_calls == 0
    verify_dummy_password(SYNTHETIC_PASSWORD)
    verify_dummy_password(SYNTHETIC_PASSWORD)

    assert generated_sources == 1
    assert hash_calls == 1
    assert verify_calls == 2
