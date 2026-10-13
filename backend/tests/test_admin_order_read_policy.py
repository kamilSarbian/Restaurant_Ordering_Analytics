"""Non-database tests for administrator Order-read isolation."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any, Literal
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql

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
from app.orders.admin_service import (
    AdminOrderNotFoundError,
    AdminOrderReadDeniedError,
    get_admin_order,
    list_admin_orders,
)
from app.orders.origins import OrderDataOrigin
from app.payments.providers import PaymentProvider

PUBLIC_ORDER_NUMBER = "ROA-23456789ABCD"
ReadKind = Literal["list", "detail"]


class _Rows:
    def all(self) -> list[object]:
        return []


class _Session:
    def __init__(self) -> None:
        self.operations: list[tuple[str, object]] = []

    def scalar(self, statement: object) -> object | None:
        self.operations.append(("scalar", statement))
        return 0 if "count" in str(statement).lower() else None

    def scalars(self, statement: object) -> _Rows:
        self.operations.append(("scalars", statement))
        return _Rows()

    def begin(self) -> object:
        self.operations.append(("begin", object()))
        raise AssertionError("Unexpected transaction boundary")

    def execute(self, statement: object) -> object:
        self.operations.append(("execute", statement))
        raise AssertionError("Unexpected execute call")

    def get(self, model: object, identity: object) -> object:
        self.operations.append(("get", (model, identity)))
        raise AssertionError("Unexpected get call")

    def add(self, value: object) -> None:
        self.operations.append(("add", value))
        raise AssertionError("Unexpected add call")

    def flush(self) -> None:
        self.operations.append(("flush", object()))
        raise AssertionError("Unexpected flush call")


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
            UUID("00000000-0000-4000-8000-00000000f101"),
            "ordinary-read-admin@example.com",
            "synthetic-read-admin-password-hash",
            UserRole.ADMIN,
            True,
        ),
        "super_admin": (
            UUID("00000000-0000-4000-8000-00000000f102"),
            "ordinary-read-super-admin@example.com",
            "synthetic-read-super-admin-password-hash",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "customer": (
            UUID("00000000-0000-4000-8000-00000000f103"),
            "read-customer@example.com",
            "synthetic-read-customer-password-hash",
            UserRole.CUSTOMER,
            True,
        ),
        "inactive_admin": (
            UUID("00000000-0000-4000-8000-00000000f104"),
            "inactive-read-admin@example.com",
            "synthetic-read-admin-password-hash",
            UserRole.ADMIN,
            False,
        ),
        "demo_uuid_drift": (
            UUID("00000000-0000-4000-8000-00000000f105"),
            DEMO_ADMIN_EMAIL,
            DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            UserRole.ADMIN,
            True,
        ),
        "demo_email_drift": (
            DEMO_ADMIN_ID,
            "drifted-demo-read-admin@example.com",
            DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            UserRole.ADMIN,
            True,
        ),
        "demo_hash_drift": (
            DEMO_ADMIN_ID,
            DEMO_ADMIN_EMAIL,
            "synthetic-drifted-demo-password-hash",
            UserRole.ADMIN,
            True,
        ),
        "demo_role_drift": (
            DEMO_ADMIN_ID,
            DEMO_ADMIN_EMAIL,
            DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            UserRole.SUPER_ADMIN,
            True,
        ),
        "demo_inactive": (
            DEMO_ADMIN_ID,
            DEMO_ADMIN_EMAIL,
            DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            UserRole.ADMIN,
            False,
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


def _call_read(
    session: _Session,
    *,
    read_kind: ReadKind,
    actor: User,
    demo_mode: bool | None,
    provider: str | None,
) -> object:
    if read_kind == "list":
        return list_admin_orders(
            session,  # type: ignore[arg-type]
            current_user=actor,
            portfolio_demo_mode=demo_mode,
            payment_provider=provider,
            status=None,
            order_type=None,
            limit=50,
            offset=0,
        )
    return get_admin_order(
        session,  # type: ignore[arg-type]
        public_order_number=PUBLIC_ORDER_NUMBER,
        current_user=actor,
        portfolio_demo_mode=demo_mode,
        payment_provider=provider,
    )


DENIED_POLICY_CASES = (
    pytest.param("admin", True, PaymentProvider.DEMO.value, id="demo-admin"),
    pytest.param(
        "super_admin", True, PaymentProvider.DEMO.value, id="demo-super-admin"
    ),
    pytest.param("customer", True, PaymentProvider.DEMO.value, id="demo-customer"),
    pytest.param(
        "inactive_admin", True, PaymentProvider.DEMO.value, id="demo-inactive-admin"
    ),
    pytest.param(
        "demo_uuid_drift", True, PaymentProvider.DEMO.value, id="demo-uuid-drift"
    ),
    pytest.param(
        "demo_email_drift", True, PaymentProvider.DEMO.value, id="demo-email-drift"
    ),
    pytest.param(
        "demo_hash_drift", True, PaymentProvider.DEMO.value, id="demo-hash-drift"
    ),
    pytest.param(
        "demo_role_drift", True, PaymentProvider.DEMO.value, id="demo-role-drift"
    ),
    pytest.param("demo_inactive", True, PaymentProvider.DEMO.value, id="demo-inactive"),
    pytest.param(
        "demo_exact",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="reserved-exact-normal",
    ),
    pytest.param(
        "demo_email_drift",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="reserved-id-normal",
    ),
    pytest.param(
        "demo_uuid_drift",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="reserved-email-normal",
    ),
    pytest.param(
        "customer",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-customer",
    ),
    pytest.param(
        "inactive_admin",
        False,
        PaymentProvider.STRIPE_TEST.value,
        id="normal-inactive-admin",
    ),
    pytest.param(
        "admin", True, PaymentProvider.STRIPE_TEST.value, id="demo-stripe-mismatch"
    ),
    pytest.param("admin", False, PaymentProvider.DEMO.value, id="normal-demo-mismatch"),
    pytest.param("admin", None, PaymentProvider.STRIPE_TEST.value, id="missing-mode"),
    pytest.param("admin", False, None, id="missing-provider"),
    pytest.param("admin", None, None, id="missing-runtime"),
)


@pytest.mark.parametrize("read_kind", ["list", "detail"])
@pytest.mark.parametrize(("actor", "demo_mode", "provider"), DENIED_POLICY_CASES)
def test_denied_read_policy_stops_before_every_domain_session_operation(
    read_kind: ReadKind,
    actor: str,
    demo_mode: bool | None,
    provider: str | None,
) -> None:
    session = _Session()

    with pytest.raises(AdminOrderReadDeniedError):
        _call_read(
            session,
            read_kind=read_kind,
            actor=_user(actor),
            demo_mode=demo_mode,
            provider=provider,
        )

    assert session.operations == []


@pytest.mark.parametrize("read_kind", ["list", "detail"])
def test_exact_demo_admin_scopes_every_order_query_to_portfolio_origins(
    read_kind: ReadKind,
) -> None:
    session = _Session()

    if read_kind == "detail":
        with pytest.raises(AdminOrderNotFoundError):
            _call_read(
                session,
                read_kind=read_kind,
                actor=_user("demo_exact"),
                demo_mode=True,
                provider=PaymentProvider.DEMO.value,
            )
    else:
        result = _call_read(
            session,
            read_kind=read_kind,
            actor=_user("demo_exact"),
            demo_mode=True,
            provider=PaymentProvider.DEMO.value,
        )
        assert result.total == 0

    assert len(session.operations) == (2 if read_kind == "list" else 1)
    for _, statement in session.operations:
        compiled = statement.compile(dialect=postgresql.dialect())
        assert "orders.data_origin IN" in str(compiled)
        assert any(
            set(value)
            == {
                OrderDataOrigin.PORTFOLIO_SEED.value,
                OrderDataOrigin.PORTFOLIO_RUNTIME.value,
            }
            for value in compiled.params.values()
            if isinstance(value, (list, tuple))
        )


@pytest.mark.parametrize("actor", ["admin", "super_admin"])
@pytest.mark.parametrize("read_kind", ["list", "detail"])
def test_normal_runtime_preserves_unfiltered_order_reads(
    read_kind: ReadKind,
    actor: str,
) -> None:
    session = _Session()

    if read_kind == "detail":
        with pytest.raises(AdminOrderNotFoundError):
            _call_read(
                session,
                read_kind=read_kind,
                actor=_user(actor),
                demo_mode=False,
                provider=PaymentProvider.STRIPE_TEST.value,
            )
    else:
        result = _call_read(
            session,
            read_kind=read_kind,
            actor=_user(actor),
            demo_mode=False,
            provider=PaymentProvider.STRIPE_TEST.value,
        )
        assert result.total == 0

    assert len(session.operations) == (2 if read_kind == "list" else 1)
    for _, statement in session.operations:
        assert "orders.data_origin IN" not in str(
            statement.compile(dialect=postgresql.dialect())
        )


def _request_list(
    *,
    actor: User,
    demo_mode: bool | None,
    provider: str | None,
) -> tuple[int, dict[str, Any], _Session]:
    app = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret="a" * 32,
        )
    )
    app.state.portfolio_demo_mode = demo_mode
    app.state.payment_provider = provider
    session = _Session()

    def current_user_override() -> User:
        return actor

    def session_override() -> Iterator[_Session]:
        yield session

    app.dependency_overrides[get_current_user] = current_user_override
    app.dependency_overrides[get_db_session] = session_override
    with TestClient(app) as client:
        response = client.get("/api/v1/admin/orders")
    return response.status_code, response.json(), session


def test_endpoint_returns_fixed_403_before_domain_order_access() -> None:
    status_code, body, session = _request_list(
        actor=_user("admin"),
        demo_mode=True,
        provider=PaymentProvider.DEMO.value,
    )

    assert (status_code, body) == (
        403,
        {"detail": "Administrator order access is not allowed"},
    )
    assert session.operations == []


def test_endpoint_keeps_existing_role_authorization_boundary() -> None:
    status_code, body, session = _request_list(
        actor=_user("customer"),
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert (status_code, body) == (
        403,
        {"detail": "Administrator access required"},
    )
    assert session.operations == []
