"""Integration-boundary coverage for portfolio customer demo-session issuance."""

from collections.abc import Callable, Generator, Iterator
from contextlib import AbstractContextManager, contextmanager

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, or_
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.auth import users_router
from app.auth.demo_customer import (
    DEMO_CUSTOMER_DISABLED_PASSWORD_HASH,
    DEMO_CUSTOMER_EMAIL,
    DEMO_CUSTOMER_ID,
    DemoCustomerResult,
)
from app.auth.models import User
from app.auth.roles import UserRole
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app

pytestmark = pytest.mark.integration

PATH = "/api/v1/auth/customer-demo-session"
SECRET = "customer-demo-session-test-secret-material"


class _Session:
    def __init__(self, user: User) -> None:
        self.user = user

    def scalar(self, _statement: object) -> User:
        return self.user

    def expunge(self, _user: User) -> None:
        return None


def _factory(user: User) -> Callable[[], AbstractContextManager[_Session]]:
    @contextmanager
    def factory() -> Iterator[_Session]:
        yield _Session(user)

    return factory


def _customer() -> User:
    return User(
        id=DEMO_CUSTOMER_ID,
        email=DEMO_CUSTOMER_EMAIL,
        password_hash=DEMO_CUSTOMER_DISABLED_PASSWORD_HASH,
        role=UserRole.CUSTOMER,
        is_active=True,
    )


@pytest.fixture
def persisted_customer_factory(
    test_database_engine: Engine,
) -> Generator[sessionmaker[Session], None, None]:
    """Provide an isolated PostgreSQL factory without retaining demo identity rows."""
    factory = create_session_factory(test_database_engine)
    predicate = or_(User.id == DEMO_CUSTOMER_ID, User.email == DEMO_CUSTOMER_EMAIL)
    with factory.begin() as session:
        session.execute(delete(User).where(predicate))
    try:
        yield factory
    finally:
        with factory.begin() as session:
            session.execute(delete(User).where(predicate))


def test_exact_customer_demo_session_issues_customer_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Issue one standard token and reload the exact customer through /auth/me."""
    customer = _customer()
    monkeypatch.setattr(
        users_router,
        "verify_demo_customer",
        lambda _factory: DemoCustomerResult(
            id=DEMO_CUSTOMER_ID,
            email=DEMO_CUSTOMER_EMAIL,
            status="verified",
        ),
    )
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SECRET,
            portfolio_demo_mode=True,
            payment_provider="demo",
            customer_demo_session_issuance_enabled=True,
        ),
        session_factory=_factory(customer),  # type: ignore[arg-type]
    )

    with TestClient(application) as client:
        issued = client.post(PATH)
        current = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {issued.json()['access_token']}"},
        )

    assert issued.status_code == 200
    assert issued.json()["expires_in"] == 1_800
    assert current.status_code == 200
    assert current.json()["role"] == "customer"


def test_customer_demo_session_is_bodyless_and_closed_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject disabled issuance before any customer identity verification."""
    monkeypatch.setattr(
        users_router,
        "verify_demo_customer",
        lambda _factory: pytest.fail("disabled route reached identity verification"),
    )
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SECRET,
            portfolio_demo_mode=True,
            payment_provider="demo",
            customer_demo_session_issuance_enabled=False,
        ),
        session_factory=_factory(_customer()),  # type: ignore[arg-type]
    )

    with TestClient(application) as client:
        response = client.post(PATH)

    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}


def test_persisted_exact_customer_issues_token_with_select_only(
    persisted_customer_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Bind HTTP issuance to the exact persisted customer without database DML."""
    with persisted_customer_factory.begin() as session:
        session.add(_customer())
    statements: list[str] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(" ".join(statement.split()))

    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SECRET,
            portfolio_demo_mode=True,
            payment_provider="demo",
            customer_demo_session_issuance_enabled=True,
        ),
        session_factory=persisted_customer_factory,
    )
    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with TestClient(application) as client:
            issued = client.post(PATH)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    assert issued.status_code == 200
    assert issued.json()["expires_in"] == 1_800
    user_selects = [statement for statement in statements if "FROM users" in statement]
    assert len(user_selects) == 1
    assert "users.id" in user_selects[0]
    assert "users.email" in user_selects[0]
    assert not any(
        statement.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
        for statement in statements
    )


@pytest.mark.parametrize("persisted_state", ("missing", "wrong-role", "inactive"))
def test_persisted_customer_missing_or_drift_returns_safe_503_without_dml(
    persisted_customer_factory: sessionmaker[Session],
    test_database_engine: Engine,
    persisted_state: str,
) -> None:
    """Fail closed when the reserved PostgreSQL identity is absent or drifted."""
    if persisted_state != "missing":
        customer = _customer()
        if persisted_state == "wrong-role":
            customer.role = UserRole.ADMIN
        else:
            customer.is_active = False
        with persisted_customer_factory.begin() as session:
            session.add(customer)
    statements: list[str] = []

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(" ".join(statement.split()))

    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SECRET,
            portfolio_demo_mode=True,
            payment_provider="demo",
            customer_demo_session_issuance_enabled=True,
        ),
        session_factory=persisted_customer_factory,
    )
    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with TestClient(application) as client:
            response = client.post(PATH)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}
    assert (
        len([statement for statement in statements if "FROM users" in statement]) == 1
    )
    assert not any(
        statement.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
        for statement in statements
    )
