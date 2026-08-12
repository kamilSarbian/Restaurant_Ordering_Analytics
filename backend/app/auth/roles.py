"""Registered user roles for authentication and authorization."""

from enum import StrEnum


class UserRole(StrEnum):
    """Enumerate the mutually exclusive roles for registered users."""

    CUSTOMER = "customer"
    ADMIN = "admin"
    SUPER_ADMIN = "super_admin"


__all__ = ["UserRole"]
