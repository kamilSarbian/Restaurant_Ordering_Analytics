"""Non-database tests for administrator Analytics and CSV read isolation."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from inspect import Parameter, signature
from typing import Literal
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql

from app.analytics.schemas import (
    AnalyticsCategoryResponse,
    AnalyticsOrderTypeResponse,
    AnalyticsOverviewResponse,
    AnalyticsProductResponse,
)
from app.analytics.service import (
    build_product_sales_statement,
    build_qualified_succeeded_payments,
    get_analytics_overview,
    get_category_analytics,
    get_order_type_analytics,
    get_product_analytics,
)
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
from app.orders.admin_service import AdminOrderReadDeniedError
from app.orders.origins import OrderDataOrigin
from app.payments.providers import PaymentProvider
from app.reports.schemas import AnalyticsCsvExportQuery, OrdersCsvExportQuery
from app.reports.service import (
    ORDERS_CSV_HEADERS,
    PAYMENTS_CSV_HEADERS,
    PRODUCT_SALES_CSV_HEADERS,
    export_orders_csv,
    export_payments_csv,
    export_product_sales_csv,
)

ReadKind = Literal[
    "overview",
    "products",
    "categories",
    "order-types",
    "orders-csv",
    "product-sales-csv",
    "payments-csv",
]
READ_KINDS: tuple[ReadKind, ...] = (
    "overview",
    "products",
    "categories",
    "order-types",
    "orders-csv",
    "product-sales-csv",
    "payments-csv",
)
START = datetime(2026, 1, 1, tzinfo=UTC)
END = START + timedelta(days=1)


class _Rows:
    def all(self) -> list[object]:
        return []


class _Session:
    def __init__(self) -> None:
        self.operations: list[tuple[str, object]] = []

    def execute(self, statement: object) -> _Rows:
        self.operations.append(("execute", statement))
        return _Rows()

    def scalar(self, statement: object) -> object:
        self.operations.append(("scalar", statement))
        raise AssertionError("Unexpected scalar call")

    def scalars(self, statement: object) -> object:
        self.operations.append(("scalars", statement))
        raise AssertionError("Unexpected scalars call")

    def begin(self) -> object:
        self.operations.append(("begin", object()))
        raise AssertionError("Unexpected transaction boundary")

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
            UUID("00000000-0000-4000-8000-00000000e201"),
            "ordinary-reporting-admin@example.com",
            "synthetic-reporting-admin-password-hash",
            UserRole.ADMIN,
            True,
        ),
        "super_admin": (
            UUID("00000000-0000-4000-8000-00000000e202"),
            "ordinary-reporting-super-admin@example.com",
            "synthetic-reporting-super-admin-password-hash",
            UserRole.SUPER_ADMIN,
            True,
        ),
        "customer": (
            UUID("00000000-0000-4000-8000-00000000e203"),
            "reporting-customer@example.com",
            "synthetic-reporting-customer-password-hash",
            UserRole.CUSTOMER,
            True,
        ),
        "inactive_admin": (
            UUID("00000000-0000-4000-8000-00000000e204"),
            "inactive-reporting-admin@example.com",
            "synthetic-reporting-admin-password-hash",
            UserRole.ADMIN,
            False,
        ),
        "demo_uuid_drift": (
            UUID("00000000-0000-4000-8000-00000000e205"),
            DEMO_ADMIN_EMAIL,
            DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            UserRole.ADMIN,
            True,
        ),
        "demo_email_drift": (
            DEMO_ADMIN_ID,
            "drifted-demo-reporting-admin@example.com",
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
    context = {
        "current_user": actor,
        "portfolio_demo_mode": demo_mode,
        "payment_provider": provider,
    }
    if read_kind == "overview":
        return get_analytics_overview(
            session,  # type: ignore[arg-type]
            start=START,
            end=END,
            currency=None,
            **context,  # type: ignore[arg-type]
        )
    if read_kind == "products":
        return get_product_analytics(
            session,  # type: ignore[arg-type]
            start=START,
            end=END,
            currency=None,
            limit=50,
            **context,  # type: ignore[arg-type]
        )
    if read_kind == "categories":
        return get_category_analytics(
            session,  # type: ignore[arg-type]
            start=START,
            end=END,
            currency=None,
            limit=50,
            **context,  # type: ignore[arg-type]
        )
    if read_kind == "order-types":
        return get_order_type_analytics(
            session,  # type: ignore[arg-type]
            start=START,
            end=END,
            currency=None,
            **context,  # type: ignore[arg-type]
        )
    if read_kind == "orders-csv":
        return export_orders_csv(
            session,  # type: ignore[arg-type]
            OrdersCsvExportQuery(start=START, end=END),
            **context,  # type: ignore[arg-type]
        )
    query = AnalyticsCsvExportQuery(start=START, end=END)
    if read_kind == "product-sales-csv":
        return export_product_sales_csv(
            session,  # type: ignore[arg-type]
            query,
            **context,  # type: ignore[arg-type]
        )
    return export_payments_csv(
        session,  # type: ignore[arg-type]
        query,
        **context,  # type: ignore[arg-type]
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


@pytest.mark.parametrize("read_kind", READ_KINDS)
@pytest.mark.parametrize(("actor", "demo_mode", "provider"), DENIED_POLICY_CASES)
def test_denied_reporting_policy_stops_before_every_domain_session_operation(
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


@pytest.mark.parametrize("read_kind", READ_KINDS)
def test_exact_demo_admin_scopes_every_reporting_statement_to_portfolio_origins(
    read_kind: ReadKind,
) -> None:
    session = _Session()

    _call_read(
        session,
        read_kind=read_kind,
        actor=_user("demo_exact"),
        demo_mode=True,
        provider=PaymentProvider.DEMO.value,
    )

    assert len(session.operations) == 1
    operation, statement = session.operations[0]
    assert operation == "execute"
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
@pytest.mark.parametrize("read_kind", READ_KINDS)
def test_normal_runtime_preserves_all_origin_reporting_reads(
    read_kind: ReadKind,
    actor: str,
) -> None:
    session = _Session()

    _call_read(
        session,
        read_kind=read_kind,
        actor=_user(actor),
        demo_mode=False,
        provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert len(session.operations) == 1
    _, statement = session.operations[0]
    assert "orders.data_origin IN" not in str(
        statement.compile(dialect=postgresql.dialect())
    )


def test_normal_overview_keeps_payment_only_qualified_source() -> None:
    statement = build_qualified_succeeded_payments(
        start_utc=START,
        end_utc=END,
        currency=None,
        order_origin_scope=None,
    )

    sql = str(statement.compile(dialect=postgresql.dialect())).lower()

    assert "from payments" in sql
    assert "join orders" not in sql


def test_demo_product_builder_inherits_shared_qualified_origin_scope() -> None:
    statement = build_product_sales_statement(
        start_utc=START,
        end_utc=END,
        currency=None,
        limit_per_currency=50,
        order_origin_scope=(
            OrderDataOrigin.PORTFOLIO_SEED.value,
            OrderDataOrigin.PORTFOLIO_RUNTIME.value,
        ),
    )

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


@pytest.mark.parametrize(
    "service",
    [
        get_analytics_overview,
        get_product_analytics,
        get_category_analytics,
        get_order_type_analytics,
        export_orders_csv,
        export_product_sales_csv,
        export_payments_csv,
    ],
)
def test_every_reporting_service_requires_explicit_trusted_context(
    service: object,
) -> None:
    parameters = signature(service).parameters  # type: ignore[arg-type]

    for name in ("current_user", "portfolio_demo_mode", "payment_provider"):
        assert parameters[name].default is Parameter.empty


@pytest.mark.parametrize(
    "builder",
    [build_qualified_succeeded_payments, build_product_sales_statement],
)
def test_shared_builders_require_explicit_origin_scope(builder: object) -> None:
    assert (
        signature(builder).parameters["order_origin_scope"].default  # type: ignore[arg-type]
        is Parameter.empty
    )


def test_public_reporting_contract_does_not_expose_data_origin() -> None:
    schemas = (
        AnalyticsOverviewResponse,
        AnalyticsProductResponse,
        AnalyticsCategoryResponse,
        AnalyticsOrderTypeResponse,
    )
    assert all("data_origin" not in str(model.model_json_schema()) for model in schemas)
    assert all(
        "data_origin" not in headers
        for headers in (
            ORDERS_CSV_HEADERS,
            PRODUCT_SALES_CSV_HEADERS,
            PAYMENTS_CSV_HEADERS,
        )
    )


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/admin/analytics/overview",
        "/api/v1/admin/analytics/products",
        "/api/v1/admin/analytics/categories",
        "/api/v1/admin/analytics/order-types",
        "/api/v1/admin/exports/orders.csv",
        "/api/v1/admin/exports/product-sales.csv",
        "/api/v1/admin/exports/payments.csv",
    ],
)
def test_endpoint_returns_fixed_403_before_domain_reporting_access(path: str) -> None:
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
        return _user("admin")

    def session_override() -> Iterator[_Session]:
        yield session

    app.dependency_overrides[get_current_user] = current_user_override
    app.dependency_overrides[get_db_session] = session_override
    with TestClient(app) as client:
        response = client.get(
            path,
            params={
                "start": START.isoformat(),
                "end": END.isoformat(),
            },
        )

    assert (response.status_code, response.json()) == (
        403,
        {"detail": "Administrator reporting access is not allowed"},
    )
    assert session.operations == []
