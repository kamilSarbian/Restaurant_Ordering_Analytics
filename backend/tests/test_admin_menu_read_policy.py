"""Non-database tests for administrator Menu read isolation."""

from __future__ import annotations

from collections.abc import Iterator
from inspect import Parameter, signature
from typing import Any, Literal
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
from app.core.config import Settings
from app.database.dependencies import get_db_session
from app.main import create_app
from app.menu.admin_service import (
    AdminMenuReadDeniedError,
    list_admin_categories,
    list_admin_menu_items,
)
from app.payments.providers import PaymentProvider

ReadKind = Literal["categories", "items"]


class _DatabaseBoundaryReached(Exception):
    """Signal that an allowed service reached its first database operation."""


class _SentinelSession:
    def __init__(self) -> None:
        self.operations: list[str] = []

    def _reach(self, operation: str) -> Any:
        self.operations.append(operation)
        raise _DatabaseBoundaryReached(operation)

    def scalar(self, *_args: object, **_kwargs: object) -> Any:
        return self._reach("scalar")

    def scalars(self, *_args: object, **_kwargs: object) -> Any:
        return self._reach("scalars")

    def execute(self, *_args: object, **_kwargs: object) -> Any:
        return self._reach("execute")

    def get(self, *_args: object, **_kwargs: object) -> Any:
        return self._reach("get")

    def begin(self) -> Any:
        return self._reach("begin")

    def add(self, *_args: object, **_kwargs: object) -> Any:
        return self._reach("add")

    def flush(self, *_args: object, **_kwargs: object) -> Any:
        return self._reach("flush")


def _user(kind: str) -> User:
    if kind == "demo_exact":
        return User(
            id=DEMO_ADMIN_ID,
            email=DEMO_ADMIN_EMAIL,
            password_hash=DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            role=UserRole.ADMIN,
            is_active=True,
        )

    values: dict[str, tuple[UUID, str, UserRole, bool]] = {
        "admin": (
            UUID("00000000-0000-4000-8000-00000000e101"),
            "ordinary-read-admin@example.com",
            UserRole.ADMIN,
            True,
        ),
        "super_admin": (
            UUID("00000000-0000-4000-8000-00000000e102"),
            "ordinary-read-super-admin@example.com",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "reserved_id": (
            DEMO_ADMIN_ID,
            "reserved-read-id@example.com",
            UserRole.ADMIN,
            True,
        ),
        "reserved_email": (
            UUID("00000000-0000-4000-8000-00000000e103"),
            DEMO_ADMIN_EMAIL,
            UserRole.ADMIN,
            True,
        ),
        "inactive_admin": (
            UUID("00000000-0000-4000-8000-00000000e104"),
            "inactive-read-admin@example.com",
            UserRole.ADMIN,
            False,
        ),
        "customer": (
            UUID("00000000-0000-4000-8000-00000000e105"),
            "read-customer@example.com",
            UserRole.CUSTOMER,
            True,
        ),
    }
    user_id, email, role, is_active = values[kind]
    return User(
        id=user_id,
        email=email,
        password_hash="synthetic-read-password-hash",
        role=role,
        is_active=is_active,
    )


def _call_read(
    kind: ReadKind,
    *,
    session: _SentinelSession,
    current_user: User,
    portfolio_demo_mode: bool | None,
    payment_provider: str | None,
) -> object:
    service = list_admin_categories if kind == "categories" else list_admin_menu_items
    return service(
        session,  # type: ignore[arg-type]
        limit=50,
        offset=0,
        current_user=current_user,
        portfolio_demo_mode=portfolio_demo_mode,
        payment_provider=payment_provider,
    )


def _request_read(
    *,
    path: str,
    current_user: User,
    demo_mode: bool | None,
    provider: str | None,
) -> tuple[int, dict[str, object], _SentinelSession]:
    settings = Settings(
        _env_file=None,
        database_url=None,
        auth_jwt_secret="a" * 32,
    )
    app = create_app(settings=settings)
    app.state.portfolio_demo_mode = demo_mode
    app.state.payment_provider = provider
    session = _SentinelSession()

    def current_user_override() -> User:
        return current_user

    def session_override() -> Iterator[_SentinelSession]:
        yield session

    app.dependency_overrides[get_current_user] = current_user_override
    app.dependency_overrides[get_db_session] = session_override
    with TestClient(app) as client:
        response = client.get(path)
    return response.status_code, response.json(), session


DENIED_READ_CASES = (
    pytest.param("demo_exact", True, PaymentProvider.DEMO.value, id="portfolio-demo"),
    pytest.param("admin", True, PaymentProvider.DEMO.value, id="portfolio-admin"),
    pytest.param(
        "super_admin",
        True,
        PaymentProvider.DEMO.value,
        id="portfolio-super-admin",
    ),
    pytest.param(
        "reserved_id",
        True,
        PaymentProvider.DEMO.value,
        id="portfolio-reserved-id-drift",
    ),
    pytest.param(
        "reserved_email",
        True,
        PaymentProvider.DEMO.value,
        id="portfolio-reserved-email-drift",
    ),
    pytest.param(
        "demo_exact",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-exact-demo",
    ),
    pytest.param(
        "reserved_id",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-reserved-id",
    ),
    pytest.param(
        "reserved_email",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-reserved-email",
    ),
    pytest.param(
        "inactive_admin",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-inactive-admin",
    ),
    pytest.param(
        "customer",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-customer",
    ),
    pytest.param(
        "admin",
        True,
        PaymentProvider.STRIPE_TEST.value,
        id="mismatched-demo-mode-stripe-provider",
    ),
    pytest.param(
        "admin",
        False,
        PaymentProvider.DEMO.value,
        id="mismatched-normal-mode-demo-provider",
    ),
    pytest.param(
        "admin",
        None,
        PaymentProvider.STRIPE_TEST.value,
        id="missing-demo-mode",
    ),
    pytest.param("admin", False, None, id="missing-provider"),
    pytest.param("admin", None, None, id="missing-runtime-state"),
)


@pytest.mark.parametrize("kind", ["categories", "items"])
@pytest.mark.parametrize(
    ("actor", "demo_mode", "provider"),
    DENIED_READ_CASES,
)
def test_denied_read_policy_stops_before_every_session_operation(
    kind: ReadKind,
    actor: str,
    demo_mode: bool | None,
    provider: str | None,
) -> None:
    session = _SentinelSession()

    with pytest.raises(AdminMenuReadDeniedError):
        _call_read(
            kind,
            session=session,
            current_user=_user(actor),
            portfolio_demo_mode=demo_mode,
            payment_provider=provider,
        )

    assert session.operations == []


@pytest.mark.parametrize("kind", ["categories", "items"])
@pytest.mark.parametrize("actor", ["admin", "super_admin"])
def test_normal_administrators_reach_only_the_first_read_boundary(
    kind: ReadKind,
    actor: str,
) -> None:
    session = _SentinelSession()

    with pytest.raises(_DatabaseBoundaryReached, match="scalar"):
        _call_read(
            kind,
            session=session,
            current_user=_user(actor),
            portfolio_demo_mode=False,
            payment_provider=PaymentProvider.STRIPE_TEST.value,
        )

    assert session.operations == ["scalar"]


@pytest.mark.parametrize("service", [list_admin_categories, list_admin_menu_items])
def test_read_services_require_all_trusted_policy_inputs(service: object) -> None:
    parameters = signature(service).parameters

    for name in ("current_user", "portfolio_demo_mode", "payment_provider"):
        assert parameters[name].default is Parameter.empty


@pytest.mark.parametrize(
    "path",
    ["/api/v1/admin/menu/categories", "/api/v1/admin/menu/items"],
)
@pytest.mark.parametrize(
    "actor",
    ["demo_exact", "admin", "super_admin", "reserved_id", "reserved_email"],
)
def test_portfolio_runtime_returns_fixed_403_before_session_access(
    path: str,
    actor: str,
) -> None:
    status_code, body, session = _request_read(
        path=path,
        current_user=_user(actor),
        demo_mode=True,
        provider=PaymentProvider.DEMO.value,
    )

    assert (status_code, body) == (
        403,
        {"detail": "Administrator menu access is not allowed"},
    )
    assert session.operations == []


@pytest.mark.parametrize(
    "path",
    ["/api/v1/admin/menu/categories", "/api/v1/admin/menu/items"],
)
def test_customer_keeps_existing_role_denial_before_session_access(path: str) -> None:
    status_code, body, session = _request_read(
        path=path,
        current_user=_user("customer"),
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert (status_code, body) == (
        403,
        {"detail": "Administrator access required"},
    )
    assert session.operations == []


def test_public_menu_routes_remain_separate_from_admin_read_policy() -> None:
    app = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret="a" * 32,
        )
    )
    paths = app.openapi()["paths"]

    assert "get" in paths["/api/v1/menu"]
    assert "get" in paths["/api/v1/menu/items/{item_id}"]
