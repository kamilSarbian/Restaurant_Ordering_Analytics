"""Password hashing and administrator bootstrap policy primitives."""

from __future__ import annotations

import secrets
from threading import Lock

from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError
from pwdlib.hashers.argon2 import Argon2Hasher

ARGON2_MEMORY_COST_KIB = 19_456
ARGON2_TIME_COST = 2
ARGON2_PARALLELISM = 1
MIN_BOOTSTRAP_PASSWORD_LENGTH = 15
MAX_BOOTSTRAP_PASSWORD_LENGTH = 128
_DUMMY_SOURCE_BYTES = 32

_PASSWORD_HASH = PasswordHash(
    (
        Argon2Hasher(
            memory_cost=ARGON2_MEMORY_COST_KIB,
            time_cost=ARGON2_TIME_COST,
            parallelism=ARGON2_PARALLELISM,
        ),
    )
)
_dummy_password_hash: str | None = None
_dummy_password_hash_lock = Lock()


class AdminPasswordPolicyError(ValueError):
    """Report a bootstrap password policy violation without secret material."""


def hash_password(password: str) -> str:
    """Hash a password with the approved Argon2id configuration.

    Args:
        password: Exact password text to hash without normalization.

    Returns:
        A salted Argon2id PHC string.
    """
    return _PASSWORD_HASH.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password and fail closed for an unsupported stored hash.

    Args:
        password: Exact candidate password without normalization.
        password_hash: Persisted password hash to verify.

    Returns:
        True only when the candidate matches a supported valid hash.
    """
    try:
        return _PASSWORD_HASH.verify(password, password_hash)
    except UnknownHashError:
        return False


def validate_bootstrap_password(password: str) -> str:
    """Validate the administrator bootstrap password without mutating it.

    Args:
        password: Exact proposed password, including any whitespace.

    Returns:
        The unchanged password when it satisfies the bootstrap policy.

    Raises:
        AdminPasswordPolicyError: If the password is shorter than 15 or longer
            than 128 Unicode code points.
    """
    if len(password) < MIN_BOOTSTRAP_PASSWORD_LENGTH:
        raise AdminPasswordPolicyError(
            "Administrator password must contain at least 15 characters."
        )
    if len(password) > MAX_BOOTSTRAP_PASSWORD_LENGTH:
        raise AdminPasswordPolicyError(
            "Administrator password must contain at most 128 characters."
        )
    return password


def verify_dummy_password(password: str) -> None:
    """Perform one process-local dummy verification for a missing identity.

    The dummy hash is created lazily so importing the package never performs an
    expensive password hash.

    Args:
        password: Exact candidate password to verify against the dummy hash.
    """
    verify_password(password, _get_dummy_password_hash())


def _get_dummy_password_hash() -> str:
    global _dummy_password_hash

    if _dummy_password_hash is None:
        with _dummy_password_hash_lock:
            if _dummy_password_hash is None:
                source_material = secrets.token_urlsafe(_DUMMY_SOURCE_BYTES)
                try:
                    _dummy_password_hash = hash_password(source_material)
                finally:
                    del source_material
    return _dummy_password_hash
