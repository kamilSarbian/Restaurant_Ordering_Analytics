"""Non-database tests for administrator Order-status mutation isolation."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
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
from app.core.config import Settings
from app.database.dependencies import get_db_session
from app.main import create_app
from app.orders.admin_service import (
    AdminOrderInvalidTransitionError,
    AdminOrderNotPaidError,
    AdminOrderStatusMutationDeniedError,
    transition_order_status,
)
from app.orders.models import Order
from app.orders.origins import OrderDataOrigin
from app.orders.statuses import OrderStatus
from app.payments.providers import PaymentProvider

PUBLIC_ORDER_NUMBER = "ROA-23456789ABCD"
ACCESS_HASH = "a" * 64


class _Rows:
    def all(self) -> list[object]:
        return []


class _Session:
    def __init__(self, order: Order | None) -> None:
        self.order = order
        self.scalar_calls = 0
        self.payment_reads = 0
        self.add_calls = 0
        self.flush_calls = 0

    @contextmanager
    def begin(self) -> Iterator[None]:
        yield

    def scalar(self, _statement: object) -> Order | None:
        self.scalar_calls += 1
        if self.scalar_calls == 1:
            return self.order
        return None

    def scalars(self, _statement: object) -> _Rows:
        self.payment_reads += 1
        return _Rows()

    def add(self, _value: object) -> None:
        self.add_calls += 1

    def flush(self) -> None:
        self.flush_calls += 1


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
            UUID("00000000-0000-4000-8000-00000000b001"),
            "ordinary-admin@example.com",
            "synthetic-admin-password-hash",
            UserRole.ADMIN,
            True,
        ),
        "super_admin": (
            UUID("00000000-0000-4000-8000-00000000b002"),
            "ordinary-super-admin@example.com",
            "synthetic-super-admin-password-hash",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "inactive_admin": (
            UUID("00000000-0000-4000-8000-00000000b003"),
            "inactive-admin@example.com",
            "synthetic-inactive-admin-password-hash",
            UserRole.ADMIN,
            False,
        ),
        "demo_uuid_drift": (
            UUID("00000000-0000-4000-8000-00000000b004"),
            DEMO_ADMIN_EMAIL,
            DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            UserRole.ADMIN,
            True,
        ),
        "demo_email_drift": (
            DEMO_ADMIN_ID,
            "drifted-demo-admin@example.com",
            DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            UserRole.ADMIN,
            True,
        ),
        "demo_hash_drift": (
            DEMO_ADMIN_ID,
            DEMO_ADMIN_EMAIL,
            "synthetic-drifted-password-hash",
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


def _order(origin: str) -> Order:
    return Order(
        id=UUID("00000000-0000-4000-8000-00000000c001"),
        public_order_number=PUBLIC_ORDER_NUMBER,
        order_access_token_hash=ACCESS_HASH,
        data_origin=origin,
        order_type="takeaway",
        table_id=None,
        table_number_snapshot=None,
        status=OrderStatus.CREATED.value,
        currency="NOK",
        subtotal_amount=100,
        total_amount=100,
    )


@pytest.mark.parametrize(
    ("actor", "demo_mode", "provider", "origin"),
    [
        (
            "admin",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "super_admin",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        ("demo_exact", True, PaymentProvider.DEMO.value, OrderDataOrigin.LIVE.value),
        (
            "demo_exact",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_SEED.value,
        ),
        (
            "demo_exact",
            False,
            PaymentProvider.STRIPE_TEST.value,
            OrderDataOrigin.LIVE.value,
        ),
        (
            "demo_uuid_drift",
            False,
            PaymentProvider.STRIPE_TEST.value,
            OrderDataOrigin.LIVE.value,
        ),
        (
            "demo_email_drift",
            False,
            PaymentProvider.STRIPE_TEST.value,
            OrderDataOrigin.LIVE.value,
        ),
        (
            "demo_uuid_drift",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "demo_email_drift",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "demo_hash_drift",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "demo_role_drift",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "demo_inactive",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "inactive_admin",
            False,
            PaymentProvider.STRIPE_TEST.value,
            OrderDataOrigin.LIVE.value,
        ),
        (
            "admin",
            False,
            PaymentProvider.STRIPE_TEST.value,
            OrderDataOrigin.PORTFOLIO_SEED.value,
        ),
        (
            "admin",
            False,
            PaymentProvider.STRIPE_TEST.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        ("admin", None, PaymentProvider.STRIPE_TEST.value, OrderDataOrigin.LIVE.value),
        ("admin", False, None, OrderDataOrigin.LIVE.value),
        ("admin", True, PaymentProvider.STRIPE_TEST.value, OrderDataOrigin.LIVE.value),
        ("admin", False, PaymentProvider.DEMO.value, OrderDataOrigin.LIVE.value),
        ("admin", False, PaymentProvider.STRIPE_TEST.value, "unknown-origin"),
    ],
)
def test_denied_policy_stops_after_locked_order_without_dml(
    actor: str,
    demo_mode: bool | None,
    provider: str | None,
    origin: str,
) -> None:
    stored_order = _order(origin)
    session = _Session(stored_order)

    with pytest.raises(AdminOrderStatusMutationDeniedError):
        transition_order_status(
            session,  # type: ignore[arg-type]
            public_order_number=PUBLIC_ORDER_NUMBER,
            target_status=OrderStatus.READY,
            current_user=_user(actor),
            portfolio_demo_mode=demo_mode,
            payment_provider=provider,
        )

    assert session.scalar_calls == 1
    assert session.payment_reads == 0
    assert session.add_calls == 0
    assert session.flush_calls == 0
    assert stored_order.status == OrderStatus.CREATED.value


@pytest.mark.parametrize(
    ("actor", "demo_mode", "provider", "origin"),
    [
        ("admin", False, PaymentProvider.STRIPE_TEST.value, OrderDataOrigin.LIVE.value),
        (
            "super_admin",
            False,
            PaymentProvider.STRIPE_TEST.value,
            OrderDataOrigin.LIVE.value,
        ),
        (
            "demo_exact",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
    ],
)
def test_allowed_policy_preserves_transition_graph(
    actor: str,
    demo_mode: bool,
    provider: str,
    origin: str,
) -> None:
    session = _Session(_order(origin))

    with pytest.raises(AdminOrderInvalidTransitionError):
        transition_order_status(
            session,  # type: ignore[arg-type]
            public_order_number=PUBLIC_ORDER_NUMBER,
            target_status=OrderStatus.READY,
            current_user=_user(actor),
            portfolio_demo_mode=demo_mode,
            payment_provider=provider,
        )

    assert session.scalar_calls == 1
    assert session.payment_reads == 0
    assert session.add_calls == 0
    assert session.flush_calls == 0


@pytest.mark.parametrize(
    ("actor", "demo_mode", "provider", "origin"),
    [
        ("admin", False, PaymentProvider.STRIPE_TEST.value, OrderDataOrigin.LIVE.value),
        (
            "demo_exact",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
    ],
)
def test_allowed_policy_preserves_payment_guard(
    actor: str,
    demo_mode: bool,
    provider: str,
    origin: str,
) -> None:
    session = _Session(_order(origin))

    with pytest.raises(AdminOrderNotPaidError):
        transition_order_status(
            session,  # type: ignore[arg-type]
            public_order_number=PUBLIC_ORDER_NUMBER,
            target_status=OrderStatus.ACCEPTED,
            current_user=_user(actor),
            portfolio_demo_mode=demo_mode,
            payment_provider=provider,
        )

    assert session.scalar_calls == 1
    assert session.payment_reads == 1
    assert session.add_calls == 0
    assert session.flush_calls == 0


def _request_status_update(
    *,
    current_user: User,
    order: Order | None,
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
    session = _Session(order)

    def current_user_override() -> User:
        return current_user

    def session_override() -> Iterator[_Session]:
        yield session

    app.dependency_overrides[get_current_user] = current_user_override
    app.dependency_overrides[get_db_session] = session_override
    with TestClient(app) as client:
        response = client.patch(
            f"/api/v1/admin/orders/{PUBLIC_ORDER_NUMBER}/status",
            json={"status": OrderStatus.READY.value},
        )
    return response.status_code, response.json(), session


@pytest.mark.parametrize(
    ("actor", "demo_mode", "provider", "origin"),
    [
        (
            "super_admin",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        ("demo_exact", True, PaymentProvider.DEMO.value, OrderDataOrigin.LIVE.value),
        (
            "demo_exact",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_SEED.value,
        ),
        (
            "demo_exact",
            False,
            PaymentProvider.STRIPE_TEST.value,
            OrderDataOrigin.LIVE.value,
        ),
        (
            "demo_uuid_drift",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "demo_email_drift",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "demo_hash_drift",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "demo_role_drift",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "demo_inactive",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
        (
            "admin",
            False,
            PaymentProvider.STRIPE_TEST.value,
            OrderDataOrigin.PORTFOLIO_SEED.value,
        ),
        ("admin", True, PaymentProvider.STRIPE_TEST.value, OrderDataOrigin.LIVE.value),
        ("admin", False, PaymentProvider.DEMO.value, OrderDataOrigin.LIVE.value),
        ("admin", False, PaymentProvider.STRIPE_TEST.value, "unknown-origin"),
    ],
)
def test_api_hides_policy_denial_behind_not_found_contract(
    actor: str,
    demo_mode: bool,
    provider: str,
    origin: str,
) -> None:
    denied_status, denied_body, denied_session = _request_status_update(
        current_user=_user(actor),
        order=_order(origin),
        demo_mode=demo_mode,
        provider=provider,
    )
    missing_status, missing_body, missing_session = _request_status_update(
        current_user=_user("admin"),
        order=None,
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert (denied_status, denied_body) == (404, {"detail": "Order not found"})
    assert (missing_status, missing_body) == (404, {"detail": "Order not found"})
    assert denied_session.add_calls == denied_session.flush_calls == 0
    assert missing_session.add_calls == missing_session.flush_calls == 0


@pytest.mark.parametrize(
    ("actor", "demo_mode", "provider", "origin"),
    [
        ("admin", False, PaymentProvider.STRIPE_TEST.value, OrderDataOrigin.LIVE.value),
        (
            "demo_exact",
            True,
            PaymentProvider.DEMO.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
    ],
)
def test_api_allows_policy_then_preserves_graph_conflict(
    actor: str,
    demo_mode: bool,
    provider: str,
    origin: str,
) -> None:
    status_code, body, session = _request_status_update(
        current_user=_user(actor),
        order=_order(origin),
        demo_mode=demo_mode,
        provider=provider,
    )

    assert (status_code, body) == (
        409,
        {"detail": "Invalid order status transition"},
    )
    assert session.scalar_calls == 1
    assert session.add_calls == session.flush_calls == 0


def test_api_missing_runtime_state_fails_closed() -> None:
    status_code, body, session = _request_status_update(
        current_user=_user("admin"),
        order=_order(OrderDataOrigin.LIVE.value),
        demo_mode=None,
        provider=None,
    )

    assert (status_code, body) == (404, {"detail": "Order not found"})
    assert session.scalar_calls == 1
    assert session.add_calls == session.flush_calls == 0
