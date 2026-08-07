"""Unit tests for guest order number and access-token security."""

import hashlib
import hmac
import re
from unittest.mock import patch

from app.orders.access import (
    PUBLIC_ORDER_ALPHABET,
    generate_order_access_token,
    generate_public_order_number,
    hash_order_access_token,
    verify_order_access_token,
)

PUBLIC_NUMBER_PATTERN = re.compile(r"^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$")


def test_public_number_generator_uses_exact_secrets_alphabet() -> None:
    """Delegate every suffix character to secrets.choice."""
    with patch(
        "app.orders.access.secrets.choice",
        side_effect=list("23456789ABCD"),
    ) as choice:
        value = generate_public_order_number()

    assert value == "ROA-23456789ABCD"
    assert choice.call_count == 12
    assert all(call.args == (PUBLIC_ORDER_ALPHABET,) for call in choice.call_args_list)


def test_generated_public_numbers_have_the_approved_format() -> None:
    """Generate multiple correctly shaped values without statistical claims."""
    for _ in range(50):
        value = generate_public_order_number()
        assert len(value) == 16
        assert PUBLIC_NUMBER_PATTERN.fullmatch(value)
        assert set(value.removeprefix("ROA-")) <= set(PUBLIC_ORDER_ALPHABET)


def test_public_number_alphabet_excludes_ambiguous_characters() -> None:
    """Exclude characters commonly confused in guest-facing identifiers."""
    assert set("01IO").isdisjoint(PUBLIC_ORDER_ALPHABET)


def test_access_token_generator_requests_exactly_32_bytes() -> None:
    """Use the approved token_urlsafe source-byte count."""
    with patch(
        "app.orders.access.secrets.token_urlsafe",
        return_value="generated-token",
    ) as token_urlsafe:
        token = generate_order_access_token()

    assert token
    token_urlsafe.assert_called_once_with(32)


def test_access_token_hash_matches_sha256_lowercase_hex() -> None:
    """Produce the exact stable SHA-256 lookup digest."""
    token = "known-private-token"
    expected = hashlib.sha256(token.encode("utf-8")).hexdigest()
    actual = hash_order_access_token(token)
    assert actual == expected
    assert len(actual) == 64
    assert actual == actual.lower()
    assert re.fullmatch(r"[0-9a-f]{64}", actual)


def test_access_token_verification_accepts_correct_and_rejects_wrong() -> None:
    """Authenticate only the token matching the stored digest."""
    expected_hash = hash_order_access_token("correct-token")
    assert verify_order_access_token("correct-token", expected_hash) is True
    assert verify_order_access_token("wrong-token", expected_hash) is False


def test_access_token_verification_uses_compare_digest() -> None:
    """Use constant-time digest comparison instead of equality."""
    expected_hash = hash_order_access_token("correct-token")
    with patch(
        "app.orders.access.hmac.compare_digest",
        wraps=hmac.compare_digest,
    ) as compare_digest:
        result = verify_order_access_token("correct-token", expected_hash)

    assert result is True
    compare_digest.assert_called_once_with(expected_hash, expected_hash)
