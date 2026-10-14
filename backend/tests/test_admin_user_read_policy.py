"""Non-database tests for administrator User-list read isolation."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from inspect import Parameter, signature
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.auth.demo_admin import (
    DEMO_ADMIN_DISABLED_PASSWORD_HASH,
    DEMO_ADMIN_EMAIL,
    DEMO_ADMIN_ID,
)
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.user_service import UserListReadDeniedError, list_users
from app.core.config import Settings
from app.database.dependencies import get_db_session
from app.main import create_app
from app.payments.providers import PaymentProvider

FIXED_NOW = datetime(2026, 10, 14, 12, tzinfo=UTC)
USERS_PATH = "/api/v1/admin/users"


class _Rows:
    def __init__(self, users: list[User]) -> None:
        self.users = users

    def all(self) -> list[User]:
        return self.users


class _SentinelSession:
    def __init__(self, users: list[User] | None = None) -> None:
        self.users = users or []
        self.operations: list[str] = []

    def scalar(self, *_args: object, **_kwargs: object) -> int:
        self.operations.append("scalar")
        return len(self.users)

    def scalars(self, *_args: object, **_kwargs: object) -> _Rows:
        self.operations.append("scalars")
        return _Rows(self.users)

    def execute(self, *_args: object, **_kwargs: object) -> Any:
        self.operations.append("execute")
        raise AssertionError("Unexpected execute call")

    def get(self, *_args: object, **_kwargs: object) -> Any:
        self.operations.append("get")
        raise AssertionError("Unexpected get call")

    def begin(self) -> Any:
        self.operations.append("begin")
        raise AssertionError("Unexpected transaction boundary")

    def add(self, *_args: object, **_kwargs: object) -> Any:
        self.operations.append("add")
        raise AssertionError("Unexpected add call")

    def flush(self, *_args: object, **_kwargs: object) -> Any:
        self.operations.append("flush")
        raise AssertionError("Unexpected flush call")


def _user(kind: str) -> User:
    values: dict[str, tuple[UUID, str, str, UserRole, bool]] = {
        "demo_exact": (
            DEMO_ADMIN_ID,
            DEMO_ADMIN_EMAIL,
            DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            UserRole.ADMIN,
            True,
        ),
        "reserved_both_super_admin": (
            DEMO_ADMIN_ID,
            DEMO_ADMIN_EMAIL,
            DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            UserRole.SUPER_ADMIN,
            True,
        ),
        "reserved_id_super_admin": (
            DEMO_ADMIN_ID,
            "reserved-list-id@example.com",
            "synthetic-list-password-hash",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "reserved_email_super_admin": (
            UUID("00000000-0000-4000-8000-00000000e301"),
            DEMO_ADMIN_EMAIL,
            "synthetic-list-password-hash",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "super_admin": (
            UUID("00000000-0000-4000-8000-00000000e302"),
            "ordinary-list-super-admin@example.com",
            "synthetic-list-password-hash",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "inactive_super_admin": (
            UUID("00000000-0000-4000-8000-00000000e303"),
            "inactive-list-super-admin@example.com",
            "synthetic-list-password-hash",
            UserRole.SUPER_ADMIN,
            False,
        ),
        "admin": (
            UUID("00000000-0000-4000-8000-00000000e304"),
            "ordinary-list-admin@example.com",
            "synthetic-list-password-hash",
            UserRole.ADMIN,
            True,
        ),
        "customer": (
            UUID("00000000-0000-4000-8000-00000000e305"),
            "ordinary-list-customer@example.com",
            "synthetic-list-password-hash",
            UserRole.CUSTOMER,
            True,
        ),
    }
    user_id, email, password_hash, role, is_active = values[kind]
    return User(
        id=user_id,
        email=email,
        password_hash=password_hash,
        role=role,
        is_active=is_active,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )


def _call_read(
    session: _SentinelSession,
    *,
    actor: User,
    demo_mode: bool | None,
    provider: str | None,
) -> object:
    return list_users(
        session,  # type: ignore[arg-type]
        limit=50,
        offset=0,
        current_user=actor,
        portfolio_demo_mode=demo_mode,
        payment_provider=provider,
    )


def _request_read(
    *,
    actor: User,
    demo_mode: bool | None,
    provider: str | None,
) -> tuple[int, dict[str, object], _SentinelSession]:
    app = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret="a" * 32,
            portfolio_demo_mode=False,
            payment_provider=PaymentProvider.STRIPE_TEST.value,
        )
    )
    app.state.portfolio_demo_mode = demo_mode
    app.state.payment_provider = provider
    session = _SentinelSession(users=[actor])

    def current_user_override() -> User:
        return actor

    def session_override() -> Iterator[_SentinelSession]:
        yield session

    app.dependency_overrides[get_current_user] = current_user_override
    app.dependency_overrides[get_db_session] = session_override
    with TestClient(app) as client:
        response = client.get(USERS_PATH)
    return response.status_code, response.json(), session


DENIED_READ_CASES = (
    pytest.param("demo_exact", True, PaymentProvider.DEMO.value, id="exact-demo"),
    pytest.param("super_admin", True, PaymentProvider.DEMO.value, id="demo-super"),
    pytest.param(
        "reserved_both_super_admin",
        True,
        PaymentProvider.DEMO.value,
        id="demo-reserved-both",
    ),
    pytest.param(
        "reserved_id_super_admin",
        True,
        PaymentProvider.DEMO.value,
        id="demo-reserved-id-drift",
    ),
    pytest.param(
        "reserved_email_super_admin",
        True,
        PaymentProvider.DEMO.value,
        id="demo-reserved-email-drift",
    ),
    pytest.param(
        "reserved_both_super_admin",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-reserved-both",
    ),
    pytest.param(
        "reserved_id_super_admin",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-reserved-id",
    ),
    pytest.param(
        "reserved_email_super_admin",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-reserved-email",
    ),
    pytest.param(
        "inactive_super_admin",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-inactive-super",
    ),
    pytest.param(
        "admin",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-admin",
    ),
    pytest.param(
        "customer",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-customer",
    ),
    pytest.param(
        "super_admin",
        True,
        PaymentProvider.STRIPE_TEST.value,
        id="demo-stripe-mismatch",
    ),
    pytest.param(
        "super_admin",
        False,
        PaymentProvider.DEMO.value,
        id="normal-demo-mismatch",
    ),
    pytest.param(
        "super_admin",
        None,
        PaymentProvider.STRIPE_TEST.value,
        id="missing-mode",
    ),
    pytest.param("super_admin", False, None, id="missing-provider"),
    pytest.param("super_admin", None, None, id="missing-runtime"),
)


@pytest.mark.parametrize(("actor", "demo_mode", "provider"), DENIED_READ_CASES)
def test_denied_read_policy_stops_before_every_session_operation(
    actor: str,
    demo_mode: bool | None,
    provider: str | None,
) -> None:
    session = _SentinelSession()

    with pytest.raises(UserListReadDeniedError):
        _call_read(
            session,
            actor=_user(actor),
            demo_mode=demo_mode,
            provider=provider,
        )

    assert session.operations == []


def test_normal_super_admin_preserves_count_page_and_safe_response() -> None:
    actor = _user("super_admin")
    session = _SentinelSession(users=[actor])

    result = _call_read(
        session,
        actor=actor,
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert session.operations == ["scalar", "scalars"]
    assert result.model_dump(mode="json") == {
        "items": [
            {
                "id": str(actor.id),
                "email": actor.email,
                "role": "super_admin",
                "is_active": True,
                "created_at": "2026-10-14T12:00:00Z",
                "updated_at": "2026-10-14T12:00:00Z",
            }
        ],
        "total": 1,
        "limit": 50,
        "offset": 0,
    }


def test_user_list_service_requires_all_trusted_policy_inputs() -> None:
    parameters = signature(list_users).parameters

    for name in ("current_user", "portfolio_demo_mode", "payment_provider"):
        assert parameters[name].default is Parameter.empty


@pytest.mark.parametrize(
    ("actor", "demo_mode", "provider"),
    [
        pytest.param(
            "super_admin", True, PaymentProvider.DEMO.value, id="portfolio-super"
        ),
        pytest.param(
            "reserved_both_super_admin",
            True,
            PaymentProvider.DEMO.value,
            id="portfolio-reserved-both",
        ),
        pytest.param(
            "reserved_id_super_admin",
            False,
            PaymentProvider.STRIPE_TEST.value,
            id="normal-reserved-id",
        ),
        pytest.param(
            "reserved_email_super_admin",
            False,
            PaymentProvider.STRIPE_TEST.value,
            id="normal-reserved-email",
        ),
        pytest.param(
            "super_admin",
            True,
            PaymentProvider.STRIPE_TEST.value,
            id="mismatched-runtime",
        ),
        pytest.param("super_admin", None, None, id="missing-runtime"),
    ],
)
def test_endpoint_returns_fixed_403_before_session_access(
    actor: str,
    demo_mode: bool | None,
    provider: str | None,
) -> None:
    status_code, body, session = _request_read(
        actor=_user(actor),
        demo_mode=demo_mode,
        provider=provider,
    )

    assert (status_code, body) == (
        403,
        {"detail": "User list access is not allowed"},
    )
    assert session.operations == []


@pytest.mark.parametrize("actor", ["admin", "customer"])
def test_non_super_admin_keeps_role_denial_before_session_access(actor: str) -> None:
    status_code, body, session = _request_read(
        actor=_user(actor),
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert (status_code, body) == (
        403,
        {"detail": "Super-administrator access required"},
    )
    assert session.operations == []


def test_normal_super_admin_endpoint_keeps_existing_list_contract() -> None:
    status_code, body, session = _request_read(
        actor=_user("super_admin"),
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert status_code == 200
    assert body["total"] == 1
    assert body["limit"] == 50
    assert body["offset"] == 0
    assert session.operations == ["scalar", "scalars"]


def test_openapi_documents_fixed_user_list_policy_denial() -> None:
    app = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret="a" * 32,
            portfolio_demo_mode=False,
            payment_provider=PaymentProvider.STRIPE_TEST.value,
        )
    )

    operation = app.openapi()["paths"][USERS_PATH]["get"]

    assert operation["responses"]["403"]["description"] == (
        "User list access is not allowed"
    )
