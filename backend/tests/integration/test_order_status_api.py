"""Integration tests for authenticated public order status retrieval."""

from __future__ import annotations

import re
from collections.abc import Generator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.demo_admin import (
    DEMO_ADMIN_DISABLED_PASSWORD_HASH,
    DEMO_ADMIN_EMAIL,
    DEMO_ADMIN_ID,
)
from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.service import (
    ALGORITHM,
    ISSUER,
    USER_AUDIENCE,
    USER_TOKEN_TYPE,
    UserTokenService,
)
from app.categories.models import Category
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app
from app.menu.models import MenuItem
from app.orders.access import (
    OrderNotFoundError,
    generate_order_access_token,
    generate_public_order_number,
    get_order_status,
    hash_order_access_token,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.origins import OrderDataOrigin
from app.payments.providers import PaymentProvider
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration

STATUS_PATH = "/api/v1/orders/{public_order_number}"
QUOTE_PATH = "/api/v1/orders/quote"
SYNTHETIC_SECRET = "s" * 32
OTHER_SYNTHETIC_SECRET = "o" * 32
FIXED_NOW = datetime(2026, 8, 13, 12, tzinfo=UTC)
ISSUED_AT = int(FIXED_NOW.timestamp())
LEGACY_ADMIN_AUDIENCE = "restaurant-ordering-analytics-admin"
DATA_WRITING_SQL_VERBS = ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "MERGE")
DATA_WRITING_CTE_PATTERN = re.compile(
    rf"(?:\bAS\s*(?:(?:NOT\s+)?MATERIALIZED\s*)?\(\s*|\)\s*)"
    rf"(?:{'|'.join(DATA_WRITING_SQL_VERBS)})\b"
)


@dataclass(frozen=True)
class StoredOrder:
    """Hold detached identifiers needed by status integration tests."""

    public_order_number: str
    raw_access_token: str
    order_id: UUID
    first_menu_item_id: UUID
    second_menu_item_id: UUID
    table_id: UUID | None


@pytest.fixture(autouse=True)
def empty_order_status_tables(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep status tests isolated in the exact approved test database."""
    with test_database_engine.begin() as connection:
        connection.execute(delete(OrderStatusHistory))
        connection.execute(delete(OrderItem))
        connection.execute(delete(Order))
        connection.execute(delete(User))
        connection.execute(delete(RestaurantTable))
        connection.execute(delete(MenuItem))
        connection.execute(delete(Category))
    try:
        yield
    finally:
        with test_database_engine.begin() as connection:
            connection.execute(delete(OrderStatusHistory))
            connection.execute(delete(OrderItem))
            connection.execute(delete(Order))
            connection.execute(delete(User))
            connection.execute(delete(RestaurantTable))
            connection.execute(delete(MenuItem))
            connection.execute(delete(Category))


@pytest.fixture
def status_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create status sessions bound only to the isolated test database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def client(
    status_session_factory: sessionmaker[Session],
) -> Generator[TestClient, None, None]:
    """Run the app with the isolated test session factory."""
    application = _application(status_session_factory)
    with TestClient(application) as test_client:
        yield test_client


@pytest.fixture
def user_token_service() -> UserTokenService:
    """Create deterministic canonical signing for status access tests."""
    return UserTokenService(SYNTHETIC_SECRET, now_provider=lambda: FIXED_NOW)


def _application(
    session_factory: sessionmaker[Session],
    *,
    user_token_service: UserTokenService | None = None,
    portfolio_demo_mode: bool = False,
    payment_provider: PaymentProvider = PaymentProvider.STRIPE_TEST,
):
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
            portfolio_demo_mode=portfolio_demo_mode,
            payment_provider=payment_provider.value,
        ),
        session_factory=session_factory,
        user_token_service=user_token_service,
    )


def _store_order(
    session_factory: sessionmaker[Session],
    *,
    dine_in: bool = False,
    customer_user_id: UUID | None = None,
    data_origin: OrderDataOrigin = OrderDataOrigin.LIVE,
) -> StoredOrder:
    public_order_number = generate_public_order_number()
    raw_access_token = generate_order_access_token()
    with session_factory.begin() as session:
        category = Category(name=f"Status Category {uuid4().hex}")
        first_menu_item = MenuItem(
            category=category,
            name="Current First Name",
            price_amount=125,
            cost_amount=70,
        )
        second_menu_item = MenuItem(
            category=category,
            name="Current Second Name",
            price_amount=300,
            cost_amount=150,
        )
        table = RestaurantTable(number=7) if dine_in else None
        session.add_all(
            [category, first_menu_item, second_menu_item]
            + ([table] if table is not None else [])
        )
        session.flush()

        order = Order(
            public_order_number=public_order_number,
            order_access_token_hash=hash_order_access_token(raw_access_token),
            customer_user_id=customer_user_id,
            data_origin=data_origin.value,
            order_type="dine_in" if dine_in else "takeaway",
            table_id=table.id if table is not None else None,
            table_number_snapshot=table.number if table is not None else None,
            currency="NOK",
            subtotal_amount=500,
            total_amount=500,
        )
        session.add(order)
        session.flush()

        first_item = OrderItem(
            order=order,
            menu_item_id=first_menu_item.id,
            position=0,
            category_name_snapshot="Historical Category",
            name_snapshot="Historical First",
            quantity=2,
            unit_price_amount=100,
            unit_cost_amount=70,
            tax_rate_bps_snapshot=None,
            discount_amount_snapshot=0,
            line_total_amount=200,
        )
        second_item = OrderItem(
            order=order,
            menu_item_id=second_menu_item.id,
            position=1,
            category_name_snapshot="Historical Category",
            name_snapshot="Historical Second",
            quantity=1,
            unit_price_amount=300,
            unit_cost_amount=150,
            tax_rate_bps_snapshot=None,
            discount_amount_snapshot=0,
            line_total_amount=300,
        )
        history = OrderStatusHistory(
            order=order,
            sequence=0,
            previous_status=None,
            new_status="created",
        )
        # Reverse insertion proves public ordering comes from the position column.
        session.add_all([second_item, first_item, history])
        session.flush()

        result = StoredOrder(
            public_order_number=public_order_number,
            raw_access_token=raw_access_token,
            order_id=order.id,
            first_menu_item_id=first_menu_item.id,
            second_menu_item_id=second_menu_item.id,
            table_id=table.id if table is not None else None,
        )
    return result


def _status_url(stored: StoredOrder) -> str:
    return STATUS_PATH.format(public_order_number=stored.public_order_number)


def _headers(stored: StoredOrder) -> dict[str, str]:
    return {"X-Order-Access-Token": stored.raw_access_token}


def _store_user(
    session_factory: sessionmaker[Session],
    *,
    is_active: bool = True,
) -> UUID:
    with session_factory.begin() as session:
        user = User(
            email=f"status-owner-{uuid4().hex}@example.com",
            password_hash="synthetic-status-owner-password-hash",
            role=UserRole.CUSTOMER,
            is_active=is_active,
        )
        session.add(user)
        session.flush()
        return user.id


def _store_demo_admin(session_factory: sessionmaker[Session]) -> UUID:
    with session_factory.begin() as session:
        user = User(
            id=DEMO_ADMIN_ID,
            email=DEMO_ADMIN_EMAIL,
            password_hash=DEMO_ADMIN_DISABLED_PASSWORD_HASH,
            role=UserRole.ADMIN,
            is_active=True,
        )
        session.add(user)
    return DEMO_ADMIN_ID


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _get_status_with_statement_capture(
    engine: Engine,
    client: TestClient,
    public_order_number: str,
    headers: dict[str, str],
):
    statements: list[str] = []
    parameter_sets: list[object] = []

    def capture_statement(*args: object) -> None:
        statements.append(str(args[2]))
        parameter_sets.append(args[3])

    event.listen(engine, "before_cursor_execute", capture_statement)
    try:
        response = client.get(
            STATUS_PATH.format(public_order_number=public_order_number),
            headers=headers,
        )
    finally:
        event.remove(engine, "before_cursor_execute", capture_statement)
    return response, statements, parameter_sets


def _is_data_writing_statement(statement: str) -> bool:
    normalized = " ".join(statement.upper().split())
    if any(
        normalized == verb or normalized.startswith(f"{verb} ")
        for verb in DATA_WRITING_SQL_VERBS
    ):
        return True
    if not normalized.startswith(("WITH ", "WITH RECURSIVE ")):
        return False
    return DATA_WRITING_CTE_PATTERN.search(normalized) is not None


def _captured_records_without_exact_probe(
    statements: list[str],
    parameter_sets: list[object],
) -> list[tuple[str, object]]:
    if len(statements) != len(parameter_sets):
        raise AssertionError("Status SQL capture lost statement parameters")
    return [
        (statement, parameters)
        for statement, parameters in zip(statements, parameter_sets, strict=True)
        if " ".join(statement.upper().split()) != "SELECT 1"
    ]


def _assert_runtime_scoped_order_read(
    *,
    statement: str,
    parameters: object,
    public_order_number: str,
) -> None:
    normalized = " ".join(statement.upper().split())
    where_clause = normalized.partition(" WHERE ")[2]
    if "ORDERS.PUBLIC_ORDER_NUMBER =" not in where_clause:
        raise AssertionError("Status Order read lacks its public-number predicate")
    if "ORDERS.DATA_ORIGIN =" not in where_clause:
        raise AssertionError("Status Order read lacks its runtime-origin predicate")
    if not isinstance(parameters, Mapping):
        raise AssertionError("Status Order read did not use named bound parameters")
    if public_order_number not in parameters.values():
        raise AssertionError("Status Order read bound the wrong public number")
    if OrderDataOrigin.PORTFOLIO_RUNTIME.value not in parameters.values():
        raise AssertionError("Status Order read bound the wrong data origin")


def _assert_demo_status_sql(
    *,
    statements: list[str],
    parameter_sets: list[object],
    public_order_number: str,
    authenticated: bool,
    child_read_expected: bool,
) -> None:
    records = _captured_records_without_exact_probe(statements, parameter_sets)
    if any(_is_data_writing_statement(statement) for statement, _ in records):
        raise AssertionError("Demo status request performed data-writing SQL")
    normalized_records = [
        (" ".join(statement.upper().split()), statement, parameters)
        for statement, parameters in records
    ]
    if any(
        not normalized.startswith("SELECT ") for normalized, _, _ in normalized_records
    ):
        raise AssertionError("Demo status request performed unexpected non-SELECT SQL")

    user_reads = [
        (statement, parameters)
        for normalized, statement, parameters in normalized_records
        if "FROM USERS" in normalized
    ]
    order_reads = [
        (statement, parameters)
        for normalized, statement, parameters in normalized_records
        if "FROM ORDERS" in normalized
    ]
    item_reads = [
        (statement, parameters)
        for normalized, statement, parameters in normalized_records
        if "FROM ORDER_ITEMS" in normalized
    ]
    expected_user_reads = 1 if authenticated else 0
    expected_item_reads = 1 if child_read_expected else 0
    expected_total = expected_user_reads + 1 + expected_item_reads
    if len(records) != expected_total:
        raise AssertionError("Demo status request performed unexpected SQL")
    if len(user_reads) != expected_user_reads:
        raise AssertionError("Demo status request used an unexpected auth query count")
    if len(order_reads) != 1:
        raise AssertionError("Demo status request used an unexpected Order query count")
    if len(item_reads) != expected_item_reads:
        raise AssertionError("Demo status request used an unexpected child query count")

    forbidden_domain_tables = (
        "ORDER_STATUS_HISTORY",
        "PAYMENTS",
        "STRIPE_EVENTS",
    )
    if not child_read_expected:
        forbidden_domain_tables = ("ORDER_ITEMS", *forbidden_domain_tables)
    if any(
        any(table_name in normalized for table_name in forbidden_domain_tables)
        for normalized, _, _ in normalized_records
    ):
        raise AssertionError("Demo status request performed a forbidden domain read")

    expected_order_index = 1 if authenticated else 0
    if authenticated and "FROM USERS" not in normalized_records[0][0]:
        raise AssertionError("Demo status did not authenticate before its Order read")
    if "FROM ORDERS" not in normalized_records[expected_order_index][0]:
        raise AssertionError(
            "Demo status did not start domain work with its Order read"
        )
    if child_read_expected and "FROM ORDER_ITEMS" not in normalized_records[-1][0]:
        raise AssertionError(
            "Demo status did not defer its child read until after access"
        )

    if authenticated:
        user_statement, user_parameters = user_reads[0]
        normalized_user_statement = " ".join(user_statement.upper().split())
        if "USERS.ID =" not in normalized_user_statement.partition(" WHERE ")[2]:
            raise AssertionError("Demo status auth read lacks its User-id predicate")
        if any(
            marker in normalized_user_statement
            for marker in ("COUNT(", "ORDER BY", "FOR UPDATE", " JOIN ")
        ):
            raise AssertionError("Demo status auth read was not canonical")
        if not isinstance(user_parameters, Mapping):
            raise AssertionError("Demo status auth read did not bind named parameters")
        if DEMO_ADMIN_ID not in user_parameters.values():
            raise AssertionError("Demo status auth read bound the wrong User")

    order_statement, order_parameters = order_reads[0]
    _assert_runtime_scoped_order_read(
        statement=order_statement,
        parameters=order_parameters,
        public_order_number=public_order_number,
    )


def _signed_canonical_token(
    user_id: UUID,
    *,
    secret: str = SYNTHETIC_SECRET,
    **overrides: object,
) -> str:
    claims: dict[str, object] = {
        "sub": str(user_id),
        "type": USER_TOKEN_TYPE,
        "iat": ISSUED_AT,
        "exp": ISSUED_AT + 1800,
        "iss": ISSUER,
        "aud": USER_AUDIENCE,
    }
    claims.update(overrides)
    return jwt.encode(claims, secret, algorithm=ALGORITHM)


def test_status_get_returns_exact_public_snapshot(
    client: TestClient,
    status_session_factory: sessionmaker[Session],
) -> None:
    """Return only detached snapshot fields for a valid guest credential."""
    stored = _store_order(status_session_factory)
    response = client.get(_status_url(stored), headers=_headers(stored))
    assert response.status_code == 200
    assert response.json() == {
        "public_order_number": stored.public_order_number,
        "status": "created",
        "order_type": "takeaway",
        "table_number": None,
        "currency": "NOK",
        "items": [
            {
                "menu_item_id": str(stored.first_menu_item_id),
                "name": "Historical First",
                "quantity": 2,
                "unit_price_amount": 100,
                "line_total_amount": 200,
            },
            {
                "menu_item_id": str(stored.second_menu_item_id),
                "name": "Historical Second",
                "quantity": 1,
                "unit_price_amount": 300,
                "line_total_amount": 300,
            },
        ],
        "subtotal_amount": 500,
        "total_amount": 500,
        "created_at": response.json()["created_at"],
        "updated_at": response.json()["updated_at"],
    }
    response_text = response.text.lower()
    assert all(
        forbidden not in response_text
        for forbidden in (
            "order_access_token",
            "token_hash",
            "customer_user_id",
            "owner_id",
            "user_id",
            "email",
            "role",
            "cost",
            "tax",
            "discount",
            "payment_summary",
        )
    )
    assert str(stored.order_id) not in response.text


@pytest.mark.parametrize(
    ("number_kind", "token_kind"),
    [
        ("unknown", "valid"),
        ("existing", "wrong"),
        ("existing", "missing"),
        ("malformed", "valid"),
    ],
)
def test_status_get_hides_all_access_failures(
    client: TestClient,
    status_session_factory: sessionmaker[Session],
    number_kind: str,
    token_kind: str,
) -> None:
    """Return one 404 contract for every invalid number/token combination."""
    stored = _store_order(status_session_factory)
    number = {
        "existing": stored.public_order_number,
        "unknown": "ROA-ZZZZZZZZZZZZ",
        "malformed": "not-a-public-number",
    }[number_kind]
    headers = {
        "valid": _headers(stored),
        "wrong": {"X-Order-Access-Token": "wrong-token"},
        "missing": {},
    }[token_kind]
    response = client.get(
        STATUS_PATH.format(public_order_number=number),
        headers=headers,
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "Order not found"}


def test_status_owner_or_capability_access_matrix(
    status_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Allow the owner or capability while hiding every other access failure."""
    owner_id = _store_user(status_session_factory)
    other_id = _store_user(status_session_factory)
    owned = _store_order(status_session_factory, customer_user_id=owner_id)
    unowned = _store_order(status_session_factory)
    owner_auth = _authorization(user_token_service.create_access_token(owner_id))
    other_auth = _authorization(user_token_service.create_access_token(other_id))
    application = _application(
        status_session_factory,
        user_token_service=user_token_service,
    )
    cases = [
        (owned, owner_auth, None, 200),
        (owned, owner_auth, "wrong-token", 200),
        (owned, owner_auth, owned.raw_access_token, 200),
        (owned, other_auth, owned.raw_access_token, 200),
        (owned, other_auth, None, 404),
        (owned, other_auth, "wrong-token", 404),
        (unowned, other_auth, unowned.raw_access_token, 200),
        (unowned, other_auth, None, 404),
        (unowned, other_auth, "wrong-token", 404),
    ]

    with TestClient(application) as test_client:
        for stored, authorization, capability, expected_status in cases:
            headers = dict(authorization)
            if capability is not None:
                headers["X-Order-Access-Token"] = capability
            response = test_client.get(_status_url(stored), headers=headers)
            assert response.status_code == expected_status
            if expected_status == 200:
                assert response.json()["public_order_number"] == (
                    stored.public_order_number
                )
                assert {
                    "customer_user_id",
                    "owner_id",
                    "user_id",
                    "email",
                    "role",
                }.isdisjoint(response.json())
            else:
                assert response.json() == {"detail": "Order not found"}

        unknown = test_client.get(
            STATUS_PATH.format(public_order_number="ROA-ZZZZZZZZZZZZ"),
            headers=owner_auth,
        )
    assert unknown.status_code == 404
    assert unknown.json() == {"detail": "Order not found"}


@pytest.mark.parametrize(
    "data_origin",
    [
        OrderDataOrigin.LIVE,
        OrderDataOrigin.PORTFOLIO_SEED,
        OrderDataOrigin.PORTFOLIO_RUNTIME,
    ],
)
def test_normal_status_preserves_all_origin_capability_reads(
    status_session_factory: sessionmaker[Session],
    data_origin: OrderDataOrigin,
) -> None:
    """Preserve the existing normal-runtime public status origin behavior."""
    stored = _store_order(status_session_factory, data_origin=data_origin)
    application = _application(status_session_factory)

    with TestClient(application) as test_client:
        response = test_client.get(_status_url(stored), headers=_headers(stored))

    assert response.status_code == 200
    assert response.json()["public_order_number"] == stored.public_order_number


def test_demo_status_requires_capability_and_scopes_the_first_order_select(
    status_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    user_token_service: UserTokenService,
) -> None:
    """Keep shared demo identity access capability-only and runtime-scoped."""
    demo_admin_id = _store_demo_admin(status_session_factory)
    runtime_order_a = _store_order(
        status_session_factory,
        data_origin=OrderDataOrigin.PORTFOLIO_RUNTIME,
    )
    runtime_order_b = _store_order(
        status_session_factory,
        data_origin=OrderDataOrigin.PORTFOLIO_RUNTIME,
    )
    legacy_owned_runtime_order = _store_order(
        status_session_factory,
        customer_user_id=demo_admin_id,
        data_origin=OrderDataOrigin.PORTFOLIO_RUNTIME,
    )
    live_order = _store_order(
        status_session_factory,
        data_origin=OrderDataOrigin.LIVE,
    )
    seed_order = _store_order(
        status_session_factory,
        data_origin=OrderDataOrigin.PORTFOLIO_SEED,
    )
    if hash_order_access_token(
        runtime_order_a.raw_access_token
    ) == hash_order_access_token(runtime_order_b.raw_access_token):
        raise AssertionError("Independent demo Orders received colliding capabilities")
    with status_session_factory() as session:
        runtime_owners = list(
            session.scalars(
                select(Order.customer_user_id).where(
                    Order.public_order_number.in_(
                        [
                            runtime_order_a.public_order_number,
                            runtime_order_b.public_order_number,
                        ]
                    )
                )
            ).all()
        )
    if len(runtime_owners) != 2 or any(
        owner_id is not None for owner_id in runtime_owners
    ):
        raise AssertionError("Demo runtime Orders unexpectedly gained an owner")
    demo_auth = _authorization(user_token_service.create_access_token(demo_admin_id))
    visitor_a_application = _application(
        status_session_factory,
        user_token_service=user_token_service,
        portfolio_demo_mode=True,
        payment_provider=PaymentProvider.DEMO,
    )
    visitor_b_application = _application(
        status_session_factory,
        user_token_service=user_token_service,
        portfolio_demo_mode=True,
        payment_provider=PaymentProvider.DEMO,
    )
    guest_application = _application(
        status_session_factory,
        user_token_service=user_token_service,
        portfolio_demo_mode=True,
        payment_provider=PaymentProvider.DEMO,
    )

    with TestClient(
        visitor_a_application,
        client=("198.51.100.10", 50000),
    ) as visitor_a:
        visitor_a_success, statements, parameter_sets = (
            _get_status_with_statement_capture(
                test_database_engine,
                visitor_a,
                runtime_order_a.public_order_number,
                {
                    **demo_auth,
                    "X-Order-Access-Token": runtime_order_a.raw_access_token,
                },
            )
        )
        if visitor_a_success.status_code != 200:
            raise AssertionError("Visitor A could not access its capability Order")
        if (
            visitor_a_success.json().get("public_order_number")
            != runtime_order_a.public_order_number
        ):
            raise AssertionError("Visitor A received the wrong Order snapshot")
        _assert_demo_status_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_order_number=runtime_order_a.public_order_number,
            authenticated=True,
            child_read_expected=True,
        )

        visitor_a_cross, statements, parameter_sets = (
            _get_status_with_statement_capture(
                test_database_engine,
                visitor_a,
                runtime_order_b.public_order_number,
                {
                    **demo_auth,
                    "X-Order-Access-Token": runtime_order_a.raw_access_token,
                },
            )
        )
        if visitor_a_cross.status_code != 404 or visitor_a_cross.json() != {
            "detail": "Order not found"
        }:
            raise AssertionError("Visitor A cross-capability status denial changed")
        _assert_demo_status_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_order_number=runtime_order_b.public_order_number,
            authenticated=True,
            child_read_expected=False,
        )

        jwt_only, statements, parameter_sets = _get_status_with_statement_capture(
            test_database_engine,
            visitor_a,
            legacy_owned_runtime_order.public_order_number,
            demo_auth,
        )
        if jwt_only.status_code != 404 or jwt_only.json() != {
            "detail": "Order not found"
        }:
            raise AssertionError("Shared demo JWT unexpectedly gained owner authority")
        _assert_demo_status_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_order_number=legacy_owned_runtime_order.public_order_number,
            authenticated=True,
            child_read_expected=False,
        )

    with TestClient(
        visitor_b_application,
        client=("198.51.100.11", 50000),
    ) as visitor_b:
        visitor_b_success, statements, parameter_sets = (
            _get_status_with_statement_capture(
                test_database_engine,
                visitor_b,
                runtime_order_b.public_order_number,
                {
                    **demo_auth,
                    "X-Order-Access-Token": runtime_order_b.raw_access_token,
                },
            )
        )
        if visitor_b_success.status_code != 200:
            raise AssertionError("Visitor B could not access its capability Order")
        if (
            visitor_b_success.json().get("public_order_number")
            != runtime_order_b.public_order_number
        ):
            raise AssertionError("Visitor B received the wrong Order snapshot")
        _assert_demo_status_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_order_number=runtime_order_b.public_order_number,
            authenticated=True,
            child_read_expected=True,
        )

        visitor_b_cross, statements, parameter_sets = (
            _get_status_with_statement_capture(
                test_database_engine,
                visitor_b,
                runtime_order_a.public_order_number,
                {
                    **demo_auth,
                    "X-Order-Access-Token": runtime_order_b.raw_access_token,
                },
            )
        )
        if visitor_b_cross.status_code != 404 or visitor_b_cross.json() != {
            "detail": "Order not found"
        }:
            raise AssertionError("Visitor B cross-capability status denial changed")
        _assert_demo_status_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_order_number=runtime_order_a.public_order_number,
            authenticated=True,
            child_read_expected=False,
        )

    with TestClient(
        guest_application,
        client=("198.51.100.12", 50000),
    ) as guest_client:
        anonymous_success, statements, parameter_sets = (
            _get_status_with_statement_capture(
                test_database_engine,
                guest_client,
                runtime_order_a.public_order_number,
                {"X-Order-Access-Token": runtime_order_a.raw_access_token},
            )
        )
        if anonymous_success.status_code != 200:
            raise AssertionError("Anonymous capability status access failed")
        _assert_demo_status_sql(
            statements=statements,
            parameter_sets=parameter_sets,
            public_order_number=runtime_order_a.public_order_number,
            authenticated=False,
            child_read_expected=True,
        )

        anonymous_denied_cases = [
            (runtime_order_a.public_order_number, {}),
            (
                runtime_order_a.public_order_number,
                {"X-Order-Access-Token": "wrong-token"},
            ),
            (
                live_order.public_order_number,
                {"X-Order-Access-Token": live_order.raw_access_token},
            ),
            (
                seed_order.public_order_number,
                {"X-Order-Access-Token": seed_order.raw_access_token},
            ),
            (
                "ROA-ZZZZZZZZZZZZ",
                {"X-Order-Access-Token": runtime_order_a.raw_access_token},
            ),
        ]
        for public_order_number, headers in anonymous_denied_cases:
            denied, statements, parameter_sets = _get_status_with_statement_capture(
                test_database_engine,
                guest_client,
                public_order_number,
                headers,
            )
            if denied.status_code != 404 or denied.json() != {
                "detail": "Order not found"
            }:
                raise AssertionError("Anonymous demo status privacy response changed")
            _assert_demo_status_sql(
                statements=statements,
                parameter_sets=parameter_sets,
                public_order_number=public_order_number,
                authenticated=False,
                child_read_expected=False,
            )

    invalid_bearer = None
    with TestClient(guest_application) as test_client:
        invalid_bearer = test_client.get(
            _status_url(runtime_order_a),
            headers={
                "Authorization": "Bearer invalid-present-token",
                "X-Order-Access-Token": runtime_order_a.raw_access_token,
            },
        )
    assert invalid_bearer.status_code == 401
    assert invalid_bearer.json() == {"detail": "Invalid authentication credentials"}


def test_invalid_present_authorization_never_falls_back_to_valid_capability(
    status_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Reject every unusable token family before evaluating guest capability."""
    user_id = _store_user(status_session_factory)
    stored = _store_order(status_session_factory, customer_user_id=user_id)
    authorization_values = [
        "",
        "Bearer",
        "Basic credentials",
        "Custom credentials",
        "Bearer not-a-jwt",
        f"Bearer {_signed_canonical_token(user_id, exp=ISSUED_AT)}",
        f"Bearer {_signed_canonical_token(user_id, secret=OTHER_SYNTHETIC_SECRET)}",
        f"Bearer {_signed_canonical_token(user_id, iss='wrong-issuer')}",
        f"Bearer {_signed_canonical_token(user_id, aud='wrong-audience')}",
        f"Bearer {_signed_canonical_token(user_id, type='admin_access')}",
        f"Bearer {_signed_canonical_token(user_id, type='admin_access', aud=LEGACY_ADMIN_AUDIENCE)}",
    ]
    application = _application(
        status_session_factory,
        user_token_service=user_token_service,
    )

    with TestClient(application) as test_client:
        for authorization in authorization_values:
            response = test_client.get(
                _status_url(stored),
                headers={
                    "Authorization": authorization,
                    "X-Order-Access-Token": stored.raw_access_token,
                },
            )
            assert response.status_code == 401
            assert response.json() == {"detail": "Invalid authentication credentials"}
            assert response.headers["WWW-Authenticate"] == "Bearer"


def test_inactive_and_missing_users_never_fall_back_to_valid_capability(
    status_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Require the supplied canonical identity to remain active and present."""
    inactive_id = _store_user(status_session_factory, is_active=False)
    stored = _store_order(status_session_factory)
    application = _application(
        status_session_factory,
        user_token_service=user_token_service,
    )

    with TestClient(application) as test_client:
        for user_id in (inactive_id, uuid4()):
            response = test_client.get(
                _status_url(stored),
                headers={
                    **_authorization(user_token_service.create_access_token(user_id)),
                    "X-Order-Access-Token": stored.raw_access_token,
                },
            )
            assert response.status_code == 401
            assert response.json() == {"detail": "Invalid authentication credentials"}
            assert response.headers["WWW-Authenticate"] == "Bearer"


@pytest.mark.parametrize("failure_kind", ["missing_service", "database"])
def test_status_authentication_failures_are_safe_503_before_capability(
    status_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    user_token_service: UserTokenService,
    failure_kind: str,
) -> None:
    """Map authentication infrastructure failures safely without guest fallback."""
    user_id = _store_user(status_session_factory)
    stored = _store_order(status_session_factory)
    application = _application(
        status_session_factory,
        user_token_service=(
            None if failure_kind == "missing_service" else user_token_service
        ),
    )

    def fail_auth_query(*_: object) -> None:
        raise OperationalError(
            "synthetic authentication query",
            {},
            RuntimeError("synthetic authentication failure"),
        )

    if failure_kind == "database":
        event.listen(test_database_engine, "before_cursor_execute", fail_auth_query)
    try:
        with TestClient(application) as test_client:
            response = test_client.get(
                _status_url(stored),
                headers={
                    **_authorization(user_token_service.create_access_token(user_id)),
                    "X-Order-Access-Token": stored.raw_access_token,
                },
            )
    finally:
        if failure_kind == "database":
            event.remove(
                test_database_engine,
                "before_cursor_execute",
                fail_auth_query,
            )

    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}
    assert "synthetic" not in response.text.lower()


def test_setup_stores_only_sha256_token_hash(
    status_session_factory: sessionmaker[Session],
) -> None:
    """Keep the raw guest token out of every persistent Order column."""
    stored = _store_order(status_session_factory)
    with status_session_factory() as session:
        stored_hash = session.scalar(
            select(Order.order_access_token_hash).where(Order.id == stored.order_id)
        )
    assert stored_hash is not None
    assert stored_hash != stored.raw_access_token
    assert len(stored_hash) == 64
    assert re.fullmatch(r"[0-9a-f]{64}", stored_hash)
    assert "order_access_token" not in Order.__table__.columns


def test_status_uses_historical_item_and_table_snapshots(
    client: TestClient,
    status_session_factory: sessionmaker[Session],
) -> None:
    """Ignore later MenuItem and RestaurantTable changes."""
    stored = _store_order(status_session_factory, dine_in=True)
    with status_session_factory.begin() as session:
        first_item = session.get(MenuItem, stored.first_menu_item_id)
        table = session.get(RestaurantTable, stored.table_id)
        assert first_item is not None
        assert table is not None
        first_item.name = "Changed Current Name"
        first_item.price_amount = 999
        table.number = 77

    response = client.get(_status_url(stored), headers=_headers(stored))
    assert response.status_code == 200
    payload = response.json()
    assert payload["items"][0]["name"] == "Historical First"
    assert payload["items"][0]["unit_price_amount"] == 100
    assert payload["table_number"] == 7


def test_valid_status_access_executes_two_selects_and_zero_dml(
    status_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Measure the explicit order and ordered-item read queries."""
    stored = _store_order(status_session_factory)
    statements: list[str] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with status_session_factory() as session:
            response = get_order_status(
                session,
                stored.public_order_number,
                stored.raw_access_token,
                current_user_id=None,
                required_data_origin=None,
            )
    finally:
        event.remove(
            test_database_engine,
            "before_cursor_execute",
            capture_statement,
        )

    verbs = [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ]
    assert verbs.count("SELECT") == 2
    assert all(verb not in {"INSERT", "UPDATE", "DELETE"} for verb in verbs)
    assert [item.name for item in response.items] == [
        "Historical First",
        "Historical Second",
    ]


def test_wrong_token_executes_one_select_and_zero_dml(
    status_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Reject a wrong token before querying item snapshots."""
    stored = _store_order(status_session_factory)
    statements: list[str] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with status_session_factory() as session:
            with pytest.raises(OrderNotFoundError):
                get_order_status(
                    session,
                    stored.public_order_number,
                    "wrong-token",
                    current_user_id=None,
                    required_data_origin=None,
                )
    finally:
        event.remove(
            test_database_engine,
            "before_cursor_execute",
            capture_statement,
        )

    verbs = [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ]
    assert verbs == ["SELECT"]


def test_unknown_order_executes_one_select(
    status_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Reject an unknown number after one order lookup."""
    statements: list[str] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with status_session_factory() as session:
            with pytest.raises(OrderNotFoundError):
                get_order_status(
                    session,
                    "ROA-ZZZZZZZZZZZZ",
                    "token",
                    current_user_id=None,
                    required_data_origin=None,
                )
    finally:
        event.remove(
            test_database_engine,
            "before_cursor_execute",
            capture_statement,
        )
    assert [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ] == ["SELECT"]


def test_status_response_serializes_after_session_close(
    status_session_factory: sessionmaker[Session],
) -> None:
    """Build a response without retaining ORM objects or lazy relationships."""
    stored = _store_order(status_session_factory)
    with status_session_factory() as session:
        response = get_order_status(
            session,
            stored.public_order_number,
            stored.raw_access_token,
            current_user_id=None,
            required_data_origin=None,
        )
    payload = response.model_dump(mode="json")
    assert payload["public_order_number"] == stored.public_order_number
    assert [item["name"] for item in payload["items"]] == [
        "Historical First",
        "Historical Second",
    ]


def test_get_quote_remains_405_and_post_quote_still_works(
    client: TestClient,
    status_session_factory: sessionmaker[Session],
) -> None:
    """Keep the static Stage 7 quote contract ahead of the dynamic route."""
    stored = _store_order(status_session_factory)
    assert client.get(QUOTE_PATH).status_code == 405
    response = client.post(
        QUOTE_PATH,
        json={
            "items": [
                {
                    "menu_item_id": str(stored.first_menu_item_id),
                    "quantity": 2,
                }
            ]
        },
    )
    assert response.status_code == 200


def test_openapi_documents_optional_owner_or_capability_status_access(
    client: TestClient,
) -> None:
    """Expose exact optional UserBearer semantics and the safe status schema."""
    document = client.get("/openapi.json").json()
    assert set(document["paths"][QUOTE_PATH]) == {"post"}
    assert "/api/v1/orders/{public_order_number}" in document["paths"]
    operation = document["paths"]["/api/v1/orders/{public_order_number}"]["get"]
    assert operation["tags"] == ["orders"]
    assert {"200", "401", "403", "404", "422", "503"} <= set(operation["responses"])
    assert operation["responses"]["200"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/OrderStatusResponse")
    header = next(
        parameter
        for parameter in operation["parameters"]
        if parameter["name"] == "X-Order-Access-Token"
    )
    assert header["in"] == "header"
    assert header["required"] is False
    assert operation["security"] == [{"UserBearer": []}, {}]
    assert {"AdminBearer": []} not in operation["security"]
    assert "post" in document["paths"]["/api/v1/orders"]
    properties = document["components"]["schemas"]["OrderStatusResponse"]["properties"]
    assert set(properties) == {
        "public_order_number",
        "status",
        "order_type",
        "table_number",
        "currency",
        "items",
        "subtotal_amount",
        "total_amount",
        "created_at",
        "updated_at",
    }
    assert {
        "id",
        "order_access_token",
        "order_access_token_hash",
        "customer_user_id",
        "owner_id",
        "user_id",
        "email",
        "role",
        "payment_summary",
        "cost",
        "tax",
        "discount",
    }.isdisjoint(properties)
    status_schema_text = str(document["components"]["schemas"]["OrderStatusResponse"])
    assert "Payment" not in status_schema_text
    assert "Stripe" not in status_schema_text
    assert set(document["components"]["securitySchemes"]) == {"UserBearer"}


def test_post_order_creation_is_documented(client: TestClient) -> None:
    """Document the Stage 8B-3 creation route without duplicating its API suite."""
    document = client.get("/openapi.json").json()
    operation = document["paths"]["/api/v1/orders"]["post"]

    assert operation["tags"] == ["orders"]
    assert operation["summary"] == "Create an order"
    assert operation["requestBody"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/OrderCreateRequest")
    assert operation["responses"]["201"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/OrderCreateResponse")
    assert {"201", "404", "409", "422", "429"} <= set(operation["responses"])
    schema_text = str(document["components"]["schemas"]["OrderCreateResponse"])
    assert "Payment" not in schema_text
    assert "Stripe" not in schema_text
