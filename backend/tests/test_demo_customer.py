"""Unit coverage for the reserved portfolio demo-customer identity."""

from __future__ import annotations

from contextlib import AbstractContextManager
from uuid import uuid4

import pytest
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.auth import user_service as canonical_user_service
from app.auth.demo_admin import DEMO_ADMIN_EMAIL
from app.auth.demo_customer import (
    DEMO_CUSTOMER_DISABLED_PASSWORD_HASH,
    DEMO_CUSTOMER_EMAIL,
    DEMO_CUSTOMER_ID,
    DEMO_CUSTOMER_PROVISION_LOCK_KEY,
    DemoCustomerConflictError,
    DemoCustomerDatabaseError,
    DemoCustomerResult,
    deactivate_demo_customer,
    has_reserved_demo_customer_identifier,
    inspect_demo_customer,
    is_demo_customer_identity,
    provision_demo_customer,
    verify_demo_customer,
)
from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.user_service import (
    UserAuthenticationError,
    UserRegistrationConflictError,
    authenticate_user,
    create_customer,
)


class _ScalarRows:
    def __init__(self, rows: list[User]) -> None:
        self._rows = rows

    def all(self) -> list[User]:
        return list(self._rows)


class _FakeSession:
    def __init__(
        self,
        rows: list[User],
        calls: list[str],
        *,
        select_error: SQLAlchemyError | None = None,
        flush_error: SQLAlchemyError | None = None,
    ) -> None:
        self.rows = rows
        self.calls = calls
        self.added: list[User] = []
        self._select_error = select_error
        self._flush_error = flush_error

    def execute(self, statement: object, parameters: dict[str, int]) -> None:
        assert "pg_advisory_xact_lock" in str(statement)
        assert parameters == {"lock_key": DEMO_CUSTOMER_PROVISION_LOCK_KEY}
        self.calls.append("advisory-lock")

    def scalars(self, statement: object) -> _ScalarRows:
        rendered = str(statement)
        self.calls.append("select-for-update" if "FOR UPDATE" in rendered else "select")
        if self._select_error is not None:
            raise self._select_error
        return _ScalarRows(self.rows)

    def add(self, user: User) -> None:
        self.calls.append("add")
        self.added.append(user)

    def flush(self) -> None:
        self.calls.append("flush")
        if self._flush_error is not None:
            raise self._flush_error


class _Context(AbstractContextManager[_FakeSession]):
    def __init__(
        self,
        session: _FakeSession,
        calls: list[str],
        *,
        transactional: bool,
    ) -> None:
        self._session = session
        self._calls = calls
        self._transactional = transactional

    def __enter__(self) -> _FakeSession:
        self._calls.append("begin" if self._transactional else "open")
        return self._session

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback_object: object | None,
    ) -> None:
        del exc_value, traceback_object
        if self._transactional:
            self._calls.append("rollback" if exc_type is not None else "commit")
        else:
            self._calls.append("close")
        return None


class _FakeFactory:
    def __init__(self, session: _FakeSession, calls: list[str]) -> None:
        self._session = session
        self._calls = calls

    def begin(self) -> _Context:
        return _Context(self._session, self._calls, transactional=True)

    def __call__(self) -> _Context:
        return _Context(self._session, self._calls, transactional=False)


class _NoTransactionSession:
    def begin(self) -> None:
        pytest.fail("reserved registration reached the database transaction")


def _user(**changes: object) -> User:
    values: dict[str, object] = {
        "id": DEMO_CUSTOMER_ID,
        "email": DEMO_CUSTOMER_EMAIL,
        "password_hash": DEMO_CUSTOMER_DISABLED_PASSWORD_HASH,
        "role": UserRole.CUSTOMER,
        "is_active": True,
    }
    values.update(changes)
    return User(**values)  # type: ignore[arg-type]


def _factory(
    rows: list[User],
    *,
    select_error: SQLAlchemyError | None = None,
    flush_error: SQLAlchemyError | None = None,
) -> tuple[_FakeFactory, _FakeSession, list[str]]:
    calls: list[str] = []
    session = _FakeSession(
        rows,
        calls,
        select_error=select_error,
        flush_error=flush_error,
    )
    return _FakeFactory(session, calls), session, calls


def test_reserved_identity_is_exact_active_customer_only() -> None:
    exact_user = _user()

    assert is_demo_customer_identity(exact_user) is True
    assert is_demo_customer_identity(_user(role=UserRole.ADMIN)) is False
    assert is_demo_customer_identity(_user(role=UserRole.SUPER_ADMIN)) is False
    assert is_demo_customer_identity(_user(is_active=False)) is False
    assert is_demo_customer_identity(_user(password_hash="changed")) is False


def test_reserved_identifier_helper_matches_id_or_email() -> None:
    assert has_reserved_demo_customer_identifier(_user()) is True
    assert (
        has_reserved_demo_customer_identifier(
            _user(id=uuid4(), email=DEMO_CUSTOMER_EMAIL)
        )
        is True
    )
    assert (
        has_reserved_demo_customer_identifier(
            _user(id=DEMO_CUSTOMER_ID, email="another@example.com")
        )
        is True
    )
    assert (
        has_reserved_demo_customer_identifier(
            _user(id=uuid4(), email="another@example.com")
        )
        is False
    )


def test_provision_inserts_exact_identity_under_advisory_lock() -> None:
    factory, session, calls = _factory([])

    result = provision_demo_customer(factory)  # type: ignore[arg-type]

    assert result == DemoCustomerResult(
        id=DEMO_CUSTOMER_ID,
        email=DEMO_CUSTOMER_EMAIL,
        status="provisioned",
    )
    assert calls == [
        "begin",
        "advisory-lock",
        "select-for-update",
        "add",
        "flush",
        "commit",
    ]
    assert len(session.added) == 1
    assert is_demo_customer_identity(session.added[0]) is True


def test_provision_exact_rerun_is_zero_dml() -> None:
    factory, session, calls = _factory([_user()])

    result = provision_demo_customer(factory)  # type: ignore[arg-type]

    assert result.status == "already_exact"
    assert calls == ["begin", "advisory-lock", "select-for-update", "commit"]
    assert session.added == []


@pytest.mark.parametrize(
    "rows",
    [
        [_user(email="collision@example.com")],
        [_user(role=UserRole.ADMIN)],
        [_user(), _user(id=uuid4())],
    ],
)
def test_provision_rejects_collision_or_drift(rows: list[User]) -> None:
    factory, _, calls = _factory(rows)

    with pytest.raises(DemoCustomerConflictError):
        provision_demo_customer(factory)  # type: ignore[arg-type]

    assert calls[-1] == "rollback"


@pytest.mark.parametrize(
    ("rows", "expected_status"),
    [([], "missing"), ([_user()], "active"), ([_user(is_active=False)], "inactive")],
)
def test_inspect_reports_exact_state_without_dml(
    rows: list[User], expected_status: str
) -> None:
    factory, _, calls = _factory(rows)

    result = inspect_demo_customer(factory)  # type: ignore[arg-type]

    assert result.status == expected_status
    assert calls == ["open", "select", "close"]


def test_verify_requires_one_exact_active_customer() -> None:
    exact_factory, _, exact_calls = _factory([_user()])

    result = verify_demo_customer(exact_factory)  # type: ignore[arg-type]

    assert result.status == "verified"
    assert exact_calls == ["open", "select", "close"]

    for rows in ([], [_user(is_active=False)], [_user(role=UserRole.ADMIN)]):
        factory, _, _ = _factory(rows)
        with pytest.raises(DemoCustomerConflictError):
            verify_demo_customer(factory)  # type: ignore[arg-type]


def test_deactivate_changes_only_exact_active_identity() -> None:
    factory, _, calls = _factory([_user()])

    result = deactivate_demo_customer(factory)  # type: ignore[arg-type]

    assert result.status == "deactivated"
    assert calls == [
        "begin",
        "advisory-lock",
        "select-for-update",
        "flush",
        "commit",
    ]


def test_deactivate_exact_inactive_identity_is_zero_dml() -> None:
    factory, _, calls = _factory([_user(is_active=False)])

    result = deactivate_demo_customer(factory)  # type: ignore[arg-type]

    assert result.status == "already_inactive"
    assert calls == ["begin", "advisory-lock", "select-for-update", "commit"]


@pytest.mark.parametrize("operation", [inspect_demo_customer, verify_demo_customer])
def test_read_database_error_is_sanitized(operation: object) -> None:
    secret = "postgresql://secret-never-expose"
    factory, _, _ = _factory([], select_error=SQLAlchemyError(secret))

    captured_error: DemoCustomerDatabaseError | None = None
    try:
        operation(factory)  # type: ignore[operator]
    except DemoCustomerDatabaseError as error:
        captured_error = error

    assert captured_error is not None
    assert secret not in str(captured_error)
    assert captured_error.__cause__ is None
    assert captured_error.__context__ is None


def test_write_database_error_is_sanitized_without_raw_context() -> None:
    secret = "postgresql://secret-never-expose"
    factory, _, _ = _factory([], flush_error=SQLAlchemyError(secret))

    captured_error: DemoCustomerDatabaseError | None = None
    try:
        provision_demo_customer(factory)  # type: ignore[arg-type]
    except DemoCustomerDatabaseError as error:
        captured_error = error

    assert captured_error is not None
    assert secret not in str(captured_error)
    assert captured_error.__cause__ is None
    assert captured_error.__context__ is None


def test_integrity_error_is_sanitized_as_conflict() -> None:
    secret = "database-secret"
    integrity_error = IntegrityError("statement", {}, Exception(secret))
    factory, _, _ = _factory([], flush_error=integrity_error)

    captured_error: DemoCustomerConflictError | None = None
    try:
        provision_demo_customer(factory)  # type: ignore[arg-type]
    except DemoCustomerConflictError as error:
        captured_error = error

    assert captured_error is not None
    assert secret not in str(captured_error)
    assert captured_error.__cause__ is None
    assert captured_error.__context__ is None


@pytest.mark.parametrize("email", [DEMO_ADMIN_EMAIL, DEMO_CUSTOMER_EMAIL])
def test_password_registration_reserves_demo_identity_emails(
    email: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hash_calls: list[str] = []
    monkeypatch.setattr(
        canonical_user_service,
        "hash_password",
        lambda password: hash_calls.append(password) or "synthetic-hash",
    )

    with pytest.raises(UserRegistrationConflictError, match="Account already exists"):
        create_customer(
            _NoTransactionSession(),  # type: ignore[arg-type]
            email=email.upper(),
            password="synthetic-password",
        )

    assert hash_calls == ["synthetic-password"]


def test_password_authentication_rejects_reserved_customer_before_real_hash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dummy_calls: list[str] = []
    monkeypatch.setattr(
        canonical_user_service,
        "find_user_by_email",
        lambda _session, *, email: _user(email=email),
    )
    monkeypatch.setattr(
        canonical_user_service,
        "verify_dummy_password",
        lambda password: dummy_calls.append(password),
    )
    monkeypatch.setattr(
        canonical_user_service,
        "verify_password",
        lambda *_args: pytest.fail("reserved identity reached password verification"),
    )

    with pytest.raises(UserAuthenticationError, match="Credentials are invalid"):
        authenticate_user(
            object(),  # type: ignore[arg-type]
            email=DEMO_CUSTOMER_EMAIL,
            password="synthetic-password",
        )

    assert dummy_calls == ["synthetic-password"]


def test_password_authentication_preserves_ordinary_customer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ordinary = _user(
        id=uuid4(),
        email="ordinary-customer@example.com",
        password_hash="ordinary-hash",
    )
    monkeypatch.setattr(
        canonical_user_service,
        "find_user_by_email",
        lambda _session, *, email: ordinary,
    )
    monkeypatch.setattr(
        canonical_user_service,
        "verify_password",
        lambda password, password_hash: (
            password == "synthetic-password" and password_hash == "ordinary-hash"
        ),
    )
    monkeypatch.setattr(
        canonical_user_service,
        "verify_dummy_password",
        lambda _password: pytest.fail("ordinary identity used dummy verification"),
    )

    authenticated = authenticate_user(
        object(),  # type: ignore[arg-type]
        email=ordinary.email,
        password="synthetic-password",
    )

    assert authenticated is ordinary
