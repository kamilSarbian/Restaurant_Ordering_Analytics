"""Non-database tests for administrator Menu mutation isolation."""

from __future__ import annotations

from collections.abc import Iterator
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
from app.menu import admin_router
from app.menu.admin_schemas import (
    AdminCategoryCreateRequest,
    AdminCategoryUpdateRequest,
    AdminMenuItemCreateRequest,
    AdminMenuItemUpdateRequest,
)
from app.menu.admin_service import (
    AdminMenuMutationDeniedError,
    create_admin_category,
    create_admin_menu_item,
    update_admin_category,
    update_admin_menu_item,
)
from app.payments.providers import PaymentProvider

CATEGORY_ID = UUID("00000000-0000-4000-8000-00000000d001")
ITEM_ID = UUID("00000000-0000-4000-8000-00000000d002")
MISSING_CATEGORY_ID = UUID("00000000-0000-4000-8000-00000000d003")
MISSING_ITEM_ID = UUID("00000000-0000-4000-8000-00000000d004")
MutationKind = Literal[
    "create_category",
    "update_category",
    "create_item",
    "update_item",
]


class _DatabaseBoundaryReached(Exception):
    """Signal that an allowed service reached its first database boundary."""


class _Session:
    def __init__(self) -> None:
        self.begin_calls = 0
        self.scalar_calls = 0
        self.scalars_calls = 0
        self.get_calls = 0
        self.add_calls = 0
        self.flush_calls = 0

    def begin(self) -> Any:
        self.begin_calls += 1
        raise _DatabaseBoundaryReached("begin")

    def scalar(self, *_args: object, **_kwargs: object) -> object:
        self.scalar_calls += 1
        raise _DatabaseBoundaryReached("scalar")

    def scalars(self, *_args: object, **_kwargs: object) -> object:
        self.scalars_calls += 1
        raise _DatabaseBoundaryReached("scalars")

    def get(self, *_args: object, **_kwargs: object) -> object:
        self.get_calls += 1
        raise _DatabaseBoundaryReached("get")

    def add(self, *_args: object, **_kwargs: object) -> None:
        self.add_calls += 1
        raise _DatabaseBoundaryReached("add")

    def flush(self, *_args: object, **_kwargs: object) -> None:
        self.flush_calls += 1
        raise _DatabaseBoundaryReached("flush")


def _user(kind: str) -> User:
    if kind == "demo_exact":
        return User(
            id=DEMO_ADMIN_ID,
            email=DEMO_ADMIN_EMAIL,
            password_hash=DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            role=UserRole.ADMIN,
            is_active=True,
        )

    values: dict[str, tuple[UUID, str, str, UserRole, bool]] = {
        "admin": (
            UUID("00000000-0000-4000-8000-00000000d101"),
            "ordinary-menu-admin@example.com",
            "synthetic-menu-admin-password-hash",
            UserRole.ADMIN,
            True,
        ),
        "super_admin": (
            UUID("00000000-0000-4000-8000-00000000d102"),
            "ordinary-menu-super-admin@example.com",
            "synthetic-menu-super-admin-password-hash",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "reserved_id": (
            DEMO_ADMIN_ID,
            "reserved-id-collision@example.com",
            "synthetic-menu-admin-password-hash",
            UserRole.ADMIN,
            True,
        ),
        "reserved_email": (
            UUID("00000000-0000-4000-8000-00000000d103"),
            DEMO_ADMIN_EMAIL,
            "synthetic-menu-admin-password-hash",
            UserRole.ADMIN,
            True,
        ),
        "inactive_admin": (
            UUID("00000000-0000-4000-8000-00000000d104"),
            "inactive-menu-admin@example.com",
            "synthetic-menu-admin-password-hash",
            UserRole.ADMIN,
            False,
        ),
        "customer": (
            UUID("00000000-0000-4000-8000-00000000d105"),
            "menu-customer@example.com",
            "synthetic-menu-customer-password-hash",
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
    )


def _call_mutation(
    mutation: MutationKind,
    *,
    session: _Session,
    current_user: User,
    portfolio_demo_mode: bool | None,
    payment_provider: str | None,
) -> object:
    common = {
        "current_user": current_user,
        "portfolio_demo_mode": portfolio_demo_mode,
        "payment_provider": payment_provider,
    }
    if mutation == "create_category":
        return create_admin_category(
            session,  # type: ignore[arg-type]
            request=AdminCategoryCreateRequest(name="Category"),
            **common,  # type: ignore[arg-type]
        )
    if mutation == "update_category":
        return update_admin_category(
            session,  # type: ignore[arg-type]
            category_id=CATEGORY_ID,
            request=AdminCategoryUpdateRequest(description="Updated"),
            **common,  # type: ignore[arg-type]
        )
    if mutation == "create_item":
        return create_admin_menu_item(
            session,  # type: ignore[arg-type]
            request=AdminMenuItemCreateRequest(
                category_id=CATEGORY_ID,
                name="Item",
                price_amount=100,
            ),
            **common,  # type: ignore[arg-type]
        )
    return update_admin_menu_item(
        session,  # type: ignore[arg-type]
        item_id=ITEM_ID,
        request=AdminMenuItemUpdateRequest(is_available=False),
        **common,  # type: ignore[arg-type]
    )


def _assert_session_untouched(session: _Session) -> None:
    assert session.begin_calls == 0
    assert session.scalar_calls == 0
    assert session.scalars_calls == 0
    assert session.get_calls == 0
    assert session.add_calls == 0
    assert session.flush_calls == 0


MUTATIONS: tuple[MutationKind, ...] = (
    "create_category",
    "update_category",
    "create_item",
    "update_item",
)

DENIED_POLICY_CASES = (
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


@pytest.mark.parametrize("mutation", MUTATIONS)
@pytest.mark.parametrize(
    ("actor", "demo_mode", "provider"),
    DENIED_POLICY_CASES,
)
def test_denied_policy_stops_before_transaction_or_domain_database_access(
    mutation: MutationKind,
    actor: str,
    demo_mode: bool | None,
    provider: str | None,
) -> None:
    session = _Session()

    with pytest.raises(AdminMenuMutationDeniedError):
        _call_mutation(
            mutation,
            session=session,
            current_user=_user(actor),
            portfolio_demo_mode=demo_mode,
            payment_provider=provider,
        )

    _assert_session_untouched(session)


@pytest.mark.parametrize("mutation", MUTATIONS)
@pytest.mark.parametrize("actor", ["admin", "super_admin"])
def test_normal_administrators_pass_policy_and_reach_transaction_boundary(
    mutation: MutationKind,
    actor: str,
) -> None:
    session = _Session()

    with pytest.raises(_DatabaseBoundaryReached, match="begin"):
        _call_mutation(
            mutation,
            session=session,
            current_user=_user(actor),
            portfolio_demo_mode=False,
            payment_provider=PaymentProvider.STRIPE_TEST.value,
        )

    assert session.begin_calls == 1
    assert session.scalar_calls == 0
    assert session.scalars_calls == 0
    assert session.get_calls == 0
    assert session.add_calls == 0
    assert session.flush_calls == 0


API_MUTATIONS = (
    pytest.param(
        "post",
        "/api/v1/admin/menu/categories",
        {"name": "Category"},
        id="create-category",
    ),
    pytest.param(
        "patch",
        f"/api/v1/admin/menu/categories/{CATEGORY_ID}",
        {"description": "Updated"},
        id="update-existing-category",
    ),
    pytest.param(
        "patch",
        f"/api/v1/admin/menu/categories/{MISSING_CATEGORY_ID}",
        {"description": "Updated"},
        id="update-missing-category",
    ),
    pytest.param(
        "post",
        "/api/v1/admin/menu/items",
        {
            "category_id": str(CATEGORY_ID),
            "name": "Item",
            "price_amount": 100,
        },
        id="create-item",
    ),
    pytest.param(
        "patch",
        f"/api/v1/admin/menu/items/{ITEM_ID}",
        {"is_available": False},
        id="update-existing-item",
    ),
    pytest.param(
        "patch",
        f"/api/v1/admin/menu/items/{MISSING_ITEM_ID}",
        {"is_available": False},
        id="update-missing-item",
    ),
)


def _request_mutation(
    *,
    method: str,
    path: str,
    payload: dict[str, object],
    current_user: User,
    demo_mode: bool | None,
    provider: str | None,
) -> tuple[int, dict[str, Any], _Session]:
    settings = Settings(
        _env_file=None,
        database_url=None,
        auth_jwt_secret="a" * 32,
    )
    app = create_app(settings=settings)
    app.state.portfolio_demo_mode = demo_mode
    app.state.payment_provider = provider
    session = _Session()

    def current_user_override() -> User:
        return current_user

    def session_override() -> Iterator[_Session]:
        yield session

    app.dependency_overrides[get_current_user] = current_user_override
    app.dependency_overrides[get_db_session] = session_override
    with TestClient(app) as client:
        response = client.request(method, path, json=payload)
    return response.status_code, response.json(), session


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", "/api/v1/admin/menu/categories", {}),
        ("post", "/api/v1/admin/menu/categories", {"name": "Category"}),
        (
            "patch",
            f"/api/v1/admin/menu/categories/{CATEGORY_ID}",
            {"name": "Category"},
        ),
        ("get", "/api/v1/admin/menu/items", {}),
        (
            "post",
            "/api/v1/admin/menu/items",
            {
                "category_id": str(CATEGORY_ID),
                "name": "Item",
                "price_amount": 100,
            },
        ),
        (
            "patch",
            f"/api/v1/admin/menu/items/{ITEM_ID}",
            {"name": "Item"},
        ),
    ],
)
def test_customer_role_is_forbidden_from_all_menu_admin_routes(
    method: str,
    path: str,
    payload: dict[str, object],
) -> None:
    status_code, body, session = _request_mutation(
        method=method,
        path=path,
        payload=payload,
        current_user=_user("customer"),
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert (status_code, body) == (
        403,
        {"detail": "Administrator access required"},
    )
    _assert_session_untouched(session)


@pytest.mark.parametrize(("method", "path", "payload"), API_MUTATIONS)
@pytest.mark.parametrize(
    "actor",
    ["demo_exact", "reserved_id", "reserved_email", "admin", "super_admin"],
)
def test_portfolio_runtime_returns_fixed_403_before_domain_database_access(
    method: str,
    path: str,
    payload: dict[str, object],
    actor: str,
) -> None:
    status_code, body, session = _request_mutation(
        method=method,
        path=path,
        payload=payload,
        current_user=_user(actor),
        demo_mode=True,
        provider=PaymentProvider.DEMO.value,
    )

    assert (status_code, body) == (
        403,
        {"detail": "Menu mutation is not allowed"},
    )
    _assert_session_untouched(session)


@pytest.mark.parametrize("actor", ["demo_exact", "reserved_id", "reserved_email"])
def test_normal_runtime_reserved_identity_returns_fixed_403(actor: str) -> None:
    status_code, body, session = _request_mutation(
        method="post",
        path="/api/v1/admin/menu/categories",
        payload={"name": "Category"},
        current_user=_user(actor),
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert (status_code, body) == (
        403,
        {"detail": "Menu mutation is not allowed"},
    )
    _assert_session_untouched(session)


@pytest.mark.parametrize(
    ("demo_mode", "provider"),
    [
        (True, PaymentProvider.STRIPE_TEST.value),
        (False, PaymentProvider.DEMO.value),
        (None, PaymentProvider.STRIPE_TEST.value),
        (False, None),
        (None, None),
    ],
)
def test_missing_or_mismatched_runtime_state_returns_fixed_403(
    demo_mode: bool | None,
    provider: str | None,
) -> None:
    status_code, body, session = _request_mutation(
        method="post",
        path="/api/v1/admin/menu/categories",
        payload={"name": "Category"},
        current_user=_user("admin"),
        demo_mode=demo_mode,
        provider=provider,
    )

    assert (status_code, body) == (
        403,
        {"detail": "Menu mutation is not allowed"},
    )
    _assert_session_untouched(session)


@pytest.mark.parametrize(
    ("path", "service_name"),
    [
        ("/api/v1/admin/menu/categories", "list_admin_categories"),
        ("/api/v1/admin/menu/items", "list_admin_menu_items"),
    ],
)
def test_portfolio_runtime_keeps_menu_reads_outside_mutation_guard(
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    service_name: str,
) -> None:
    settings = Settings(
        _env_file=None,
        database_url=None,
        auth_jwt_secret="a" * 32,
    )
    app = create_app(settings=settings)
    app.state.portfolio_demo_mode = True
    app.state.payment_provider = PaymentProvider.DEMO.value
    session = _Session()

    def current_user_override() -> User:
        return _user("demo_exact")

    def session_override() -> Iterator[_Session]:
        yield session

    def list_override(
        _session: object,
        *,
        limit: int,
        offset: int,
    ) -> dict[str, object]:
        return {"items": [], "total": 0, "limit": limit, "offset": offset}

    monkeypatch.setattr(admin_router, service_name, list_override)
    app.dependency_overrides[get_current_user] = current_user_override
    app.dependency_overrides[get_db_session] = session_override
    with TestClient(app) as client:
        response = client.get(path)

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0, "limit": 50, "offset": 0}
    _assert_session_untouched(session)
