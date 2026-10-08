"""Non-database tests for administrator User-role mutation isolation."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from types import TracebackType
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql

from app.auth import admin_router
from app.auth.demo_admin import DEMO_ADMIN_EMAIL, DEMO_ADMIN_ID
from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.user_schemas import UserRoleUpdateRequest
from app.auth.user_service import (
    UserNotFoundError,
    UserRoleConflictError,
    UserRoleMutationDeniedError,
    update_user_role,
)
from app.core.config import Settings
from app.database.dependencies import get_db_session
from app.main import create_app
from app.payments.providers import PaymentProvider

TARGET_ID = UUID("00000000-0000-4000-8000-00000000e001")
FIXED_NOW = datetime(2026, 10, 8, 12, tzinfo=UTC)


class _MissingRuntimeValue:
    """Represent an application-state attribute that must remain absent."""


MISSING_RUNTIME_VALUE = _MissingRuntimeValue()


class _DatabaseBoundaryReached(Exception):
    """Signal that an allowed service reached its first database boundary."""


class _Transaction(AbstractContextManager[None]):
    def __enter__(self) -> None:
        return None

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        return False


class _Session:
    def __init__(
        self,
        target: User | None = None,
        *,
        fail_at_begin: bool = False,
    ) -> None:
        self.target = target
        self.fail_at_begin = fail_at_begin
        self.begin_calls = 0
        self.scalar_calls = 0
        self.scalars_calls = 0
        self.get_calls = 0
        self.execute_calls = 0
        self.add_calls = 0
        self.flush_calls = 0
        self.refresh_calls = 0
        self.statements: list[object] = []

    def begin(self) -> AbstractContextManager[None]:
        self.begin_calls += 1
        if self.fail_at_begin:
            raise _DatabaseBoundaryReached("begin")
        return _Transaction()

    def scalar(self, statement: object) -> User | None:
        self.scalar_calls += 1
        self.statements.append(statement)
        return self.target

    def scalars(self, *_args: object, **_kwargs: object) -> object:
        self.scalars_calls += 1
        raise _DatabaseBoundaryReached("scalars")

    def get(self, *_args: object, **_kwargs: object) -> object:
        self.get_calls += 1
        raise _DatabaseBoundaryReached("get")

    def execute(self, *_args: object, **_kwargs: object) -> object:
        self.execute_calls += 1
        raise _DatabaseBoundaryReached("execute")

    def add(self, *_args: object, **_kwargs: object) -> None:
        self.add_calls += 1
        raise _DatabaseBoundaryReached("add")

    def flush(self) -> None:
        self.flush_calls += 1

    def refresh(self, _value: object, *, attribute_names: list[str]) -> None:
        assert attribute_names == ["updated_at"]
        self.refresh_calls += 1


def _user(kind: str) -> User:
    values: dict[str, tuple[UUID, str, UserRole, bool]] = {
        "super_admin": (
            UUID("00000000-0000-4000-8000-00000000e101"),
            "ordinary-user-super-admin@example.com",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "reserved_id_super_admin": (
            DEMO_ADMIN_ID,
            "reserved-id-user-super-admin@example.com",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "reserved_email_super_admin": (
            UUID("00000000-0000-4000-8000-00000000e102"),
            DEMO_ADMIN_EMAIL,
            UserRole.SUPER_ADMIN,
            True,
        ),
        "inactive_super_admin": (
            UUID("00000000-0000-4000-8000-00000000e103"),
            "inactive-user-super-admin@example.com",
            UserRole.SUPER_ADMIN,
            False,
        ),
        "admin": (
            UUID("00000000-0000-4000-8000-00000000e104"),
            "ordinary-user-admin@example.com",
            UserRole.ADMIN,
            True,
        ),
        "customer": (
            UUID("00000000-0000-4000-8000-00000000e105"),
            "ordinary-user-customer@example.com",
            UserRole.CUSTOMER,
            True,
        ),
        "target_admin": (
            TARGET_ID,
            "target-user-admin@example.com",
            UserRole.ADMIN,
            True,
        ),
        "target_customer": (
            TARGET_ID,
            "target-user-customer@example.com",
            UserRole.CUSTOMER,
            True,
        ),
        "target_super_admin": (
            TARGET_ID,
            "target-user-super-admin@example.com",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "target_reserved_id": (
            DEMO_ADMIN_ID,
            "reserved-target-id@example.com",
            UserRole.ADMIN,
            True,
        ),
        "target_reserved_email": (
            TARGET_ID,
            DEMO_ADMIN_EMAIL,
            UserRole.ADMIN,
            True,
        ),
    }
    user_id, email, role, is_active = values[kind]
    return User(
        id=user_id,
        email=email,
        password_hash="synthetic-user-role-policy-password-hash",
        role=role,
        is_active=is_active,
        created_at=FIXED_NOW,
        updated_at=FIXED_NOW,
    )


def _request(role: str) -> UserRoleUpdateRequest:
    return UserRoleUpdateRequest(role=role)


def _call_service(
    session: _Session,
    *,
    actor: User,
    target_id: UUID = TARGET_ID,
    target_role: str = "admin",
    demo_mode: bool | None,
    provider: str | None,
) -> object:
    return update_user_role(
        session,  # type: ignore[arg-type]
        user_id=target_id,
        request=_request(target_role),
        current_user=actor,
        portfolio_demo_mode=demo_mode,
        payment_provider=provider,
    )


def _assert_session_untouched(session: _Session) -> None:
    assert session.begin_calls == 0
    assert session.scalar_calls == 0
    assert session.scalars_calls == 0
    assert session.get_calls == 0
    assert session.execute_calls == 0
    assert session.add_calls == 0
    assert session.flush_calls == 0
    assert session.refresh_calls == 0
    assert session.statements == []


def _assert_locked_once_without_writes(session: _Session) -> None:
    assert session.begin_calls == 1
    assert session.scalar_calls == 1
    assert session.scalars_calls == 0
    assert session.get_calls == 0
    assert session.execute_calls == 0
    assert session.add_calls == 0
    assert session.flush_calls == 0
    assert session.refresh_calls == 0
    assert len(session.statements) == 1
    statement = str(session.statements[0].compile(dialect=postgresql.dialect())).upper()
    assert "SELECT" in statement
    assert "FOR UPDATE" in statement


def _snapshot(user: User) -> tuple[object, ...]:
    return (
        user.id,
        user.email,
        user.password_hash,
        user.role,
        user.is_active,
        user.created_at,
        user.updated_at,
    )


DENIED_POLICY_CASES = (
    pytest.param(
        "super_admin", True, PaymentProvider.DEMO.value, id="portfolio-super-admin"
    ),
    pytest.param(
        "super_admin",
        True,
        PaymentProvider.STRIPE_TEST.value,
        id="mismatched-demo-stripe",
    ),
    pytest.param(
        "super_admin", False, PaymentProvider.DEMO.value, id="mismatched-normal-demo"
    ),
    pytest.param(
        "super_admin",
        None,
        PaymentProvider.STRIPE_TEST.value,
        id="missing-mode",
    ),
    pytest.param("super_admin", False, None, id="missing-provider"),
    pytest.param("super_admin", None, None, id="missing-runtime"),
    pytest.param(
        "reserved_id_super_admin",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="reserved-id-actor",
    ),
    pytest.param(
        "reserved_email_super_admin",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="reserved-email-actor",
    ),
    pytest.param(
        "inactive_super_admin",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="inactive-super-admin",
    ),
    pytest.param(
        "admin", False, PaymentProvider.STRIPE_TEST.value, id="non-super-admin"
    ),
)


@pytest.mark.parametrize(("actor", "demo_mode", "provider"), DENIED_POLICY_CASES)
def test_denied_runtime_or_actor_stops_before_every_database_boundary(
    actor: str,
    demo_mode: bool | None,
    provider: str | None,
) -> None:
    session = _Session()

    with pytest.raises(UserRoleMutationDeniedError):
        _call_service(
            session,
            actor=_user(actor),
            demo_mode=demo_mode,
            provider=provider,
        )

    _assert_session_untouched(session)


def test_normal_runtime_non_reserved_super_admin_reaches_transaction_boundary() -> None:
    session = _Session(fail_at_begin=True)

    with pytest.raises(_DatabaseBoundaryReached, match="begin"):
        _call_service(
            session,
            actor=_user("super_admin"),
            demo_mode=False,
            provider=PaymentProvider.STRIPE_TEST.value,
        )

    assert session.begin_calls == 1
    assert session.scalar_calls == 0
    assert session.flush_calls == 0


@pytest.mark.parametrize("target", ["target_reserved_id", "target_reserved_email"])
def test_existing_reserved_target_is_rejected_after_lock_without_mutation(
    target: str,
) -> None:
    target_user = _user(target)
    before = _snapshot(target_user)
    session = _Session(target_user)

    with pytest.raises(UserRoleConflictError):
        _call_service(
            session,
            actor=_user("super_admin"),
            target_id=target_user.id,
            target_role="customer",
            demo_mode=False,
            provider=PaymentProvider.STRIPE_TEST.value,
        )

    _assert_locked_once_without_writes(session)
    assert _snapshot(target_user) == before


def test_missing_reserved_uuid_preserves_not_found_after_locked_lookup() -> None:
    session = _Session()

    with pytest.raises(UserNotFoundError):
        _call_service(
            session,
            actor=_user("super_admin"),
            target_id=DEMO_ADMIN_ID,
            demo_mode=False,
            provider=PaymentProvider.STRIPE_TEST.value,
        )

    _assert_locked_once_without_writes(session)


@pytest.mark.parametrize(
    ("target", "target_role"),
    [("target_admin", "admin"), ("target_super_admin", "customer")],
)
def test_existing_no_op_and_super_admin_target_keep_generic_conflict(
    target: str,
    target_role: str,
) -> None:
    target_user = _user(target)
    before = _snapshot(target_user)
    session = _Session(target_user)

    with pytest.raises(UserRoleConflictError):
        _call_service(
            session,
            actor=_user("super_admin"),
            target_role=target_role,
            demo_mode=False,
            provider=PaymentProvider.STRIPE_TEST.value,
        )

    _assert_locked_once_without_writes(session)
    assert _snapshot(target_user) == before


@pytest.mark.parametrize(
    ("target", "target_role", "expected_role"),
    [
        ("target_customer", "admin", UserRole.ADMIN),
        ("target_admin", "customer", UserRole.CUSTOMER),
    ],
)
def test_normal_runtime_preserves_legal_cross_role_transition(
    target: str,
    target_role: str,
    expected_role: UserRole,
) -> None:
    target_user = _user(target)
    session = _Session(target_user)

    response = _call_service(
        session,
        actor=_user("super_admin"),
        target_role=target_role,
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert response.id == target_user.id
    assert response.email == target_user.email
    assert response.role is expected_role
    assert response.updated_at == FIXED_NOW
    assert target_user.role is expected_role
    assert session.begin_calls == 1
    assert session.scalar_calls == 1
    assert session.flush_calls == 1
    assert session.refresh_calls == 1
    assert session.add_calls == 0


def _request_endpoint(
    *,
    actor: User,
    demo_mode: bool | None | _MissingRuntimeValue,
    provider: str | None | _MissingRuntimeValue,
    payload: dict[str, object],
) -> tuple[int, dict[str, Any], _Session]:
    app = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret="a" * 32,
        )
    )
    if demo_mode is not MISSING_RUNTIME_VALUE:
        app.state.portfolio_demo_mode = demo_mode
    else:
        delattr(app.state, "portfolio_demo_mode")
    if provider is not MISSING_RUNTIME_VALUE:
        app.state.payment_provider = provider
    else:
        delattr(app.state, "payment_provider")
    session = _Session()

    def current_user_override() -> User:
        return actor

    def session_override() -> Iterator[_Session]:
        yield session

    app.dependency_overrides[get_current_user] = current_user_override
    app.dependency_overrides[get_db_session] = session_override
    with TestClient(app) as client:
        response = client.patch(
            f"/api/v1/admin/users/{TARGET_ID}/role",
            json=payload,
        )
    return response.status_code, response.json(), session


@pytest.mark.parametrize(
    ("actor", "demo_mode", "provider"),
    [
        ("super_admin", True, PaymentProvider.DEMO.value),
        ("super_admin", True, PaymentProvider.STRIPE_TEST.value),
        ("super_admin", False, PaymentProvider.DEMO.value),
        ("super_admin", None, PaymentProvider.STRIPE_TEST.value),
        ("super_admin", False, None),
        ("reserved_id_super_admin", False, PaymentProvider.STRIPE_TEST.value),
        ("reserved_email_super_admin", False, PaymentProvider.STRIPE_TEST.value),
    ],
)
def test_endpoint_returns_one_fixed_403_before_domain_database_access(
    actor: str,
    demo_mode: bool | None,
    provider: str | None,
) -> None:
    status_code, body, session = _request_endpoint(
        actor=_user(actor),
        demo_mode=demo_mode,
        provider=provider,
        payload={"role": "admin"},
    )

    assert (status_code, body) == (
        403,
        {"detail": "User role mutation is not allowed"},
    )
    _assert_session_untouched(session)


@pytest.mark.parametrize(
    ("demo_mode", "provider"),
    [
        (MISSING_RUNTIME_VALUE, PaymentProvider.STRIPE_TEST.value),
        (False, MISSING_RUNTIME_VALUE),
        (MISSING_RUNTIME_VALUE, MISSING_RUNTIME_VALUE),
    ],
)
def test_endpoint_missing_runtime_attributes_fail_closed(
    demo_mode: bool | _MissingRuntimeValue,
    provider: str | _MissingRuntimeValue,
) -> None:
    status_code, body, session = _request_endpoint(
        actor=_user("super_admin"),
        demo_mode=demo_mode,
        provider=provider,
        payload={"role": "admin"},
    )

    assert (status_code, body) == (
        403,
        {"detail": "User role mutation is not allowed"},
    )
    _assert_session_untouched(session)


@pytest.mark.parametrize("actor", ["customer", "admin"])
def test_endpoint_keeps_existing_super_admin_authorization_403(actor: str) -> None:
    status_code, body, session = _request_endpoint(
        actor=_user(actor),
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
        payload={"role": "admin"},
    )

    assert (status_code, body) == (
        403,
        {"detail": "Super-administrator access required"},
    )
    _assert_session_untouched(session)


@pytest.mark.parametrize(
    "payload",
    [
        {"role": "super_admin"},
        {"role": "owner"},
        {"role": "admin", "is_active": False},
        {},
    ],
)
def test_endpoint_keeps_invalid_body_422_before_service_access(
    payload: dict[str, object],
) -> None:
    status_code, _body, session = _request_endpoint(
        actor=_user("super_admin"),
        demo_mode=True,
        provider=PaymentProvider.DEMO.value,
        payload=payload,
    )

    assert status_code == 422
    _assert_session_untouched(session)


def test_portfolio_runtime_keeps_user_list_outside_mutation_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret="a" * 32,
        )
    )
    app.state.portfolio_demo_mode = True
    app.state.payment_provider = PaymentProvider.DEMO.value
    session = _Session()

    def current_user_override() -> User:
        return _user("super_admin")

    def session_override() -> Iterator[_Session]:
        yield session

    def list_override(
        _session: object,
        *,
        limit: int,
        offset: int,
    ) -> dict[str, object]:
        return {"items": [], "total": 0, "limit": limit, "offset": offset}

    monkeypatch.setattr(admin_router, "list_users", list_override)
    app.dependency_overrides[get_current_user] = current_user_override
    app.dependency_overrides[get_db_session] = session_override
    with TestClient(app) as client:
        response = client.get("/api/v1/admin/users")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0, "limit": 50, "offset": 0}
    _assert_session_untouched(session)
