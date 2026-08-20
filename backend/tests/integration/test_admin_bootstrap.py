"""Integration tests for explicit administrator bootstrap behavior."""

from __future__ import annotations

from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import MagicMock, sentinel

import jwt
import pytest
from sqlalchemy import delete, event, func, select
from sqlalchemy.engine import URL, Engine, make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.auth import bootstrap as bootstrap_module
from app.auth.bootstrap import (
    AdminBootstrapConflictError,
    AdminBootstrapInputError,
    create_admin,
)
from app.auth.models import User
from app.auth.passwords import verify_password
from app.auth.roles import UserRole
from app.auth.schemas import AdminPrincipal
from app.database.session import create_session_factory

pytestmark = pytest.mark.integration

ADMIN_EMAIL = "admin@example.com"
SYNTHETIC_PASSWORD = "synthetic bootstrap password"
OTHER_SYNTHETIC_PASSWORD = "different synthetic password"
SYNTHETIC_HASH = "synthetic-hash-output"
REQUIRED_DRIVER = "postgresql+psycopg"


@pytest.fixture(autouse=True)
def empty_admin_users(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep bootstrap tests isolated from persisted administrator identities."""
    with test_database_engine.begin() as connection:
        connection.execute(delete(User))
    try:
        yield
    finally:
        with test_database_engine.begin() as connection:
            connection.execute(delete(User))


@pytest.fixture
def admin_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create independent sessions bound to the isolated test database."""
    return create_session_factory(test_database_engine)


def _load_admin(session_factory: sessionmaker[Session]) -> User:
    with session_factory() as session:
        return session.scalars(select(User)).one()


def _store_existing_user(
    session_factory: sessionmaker[Session],
    *,
    role: UserRole,
    is_active: bool = True,
) -> None:
    with session_factory.begin() as session:
        session.add(
            User(
                email=f"existing-{role.value}@example.com",
                password_hash="synthetic-existing-password-hash",
                role=role,
                is_active=is_active,
            )
        )


def test_create_admin_normalizes_hashes_activates_and_returns_safe_principal(
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Persist only normalized active identity data and an Argon2id hash."""
    with admin_session_factory() as session:
        result = create_admin(
            session,
            email="  Admin@EXAMPLE.COM  ",
            password=SYNTHETIC_PASSWORD,
        )

    admin = _load_admin(admin_session_factory)
    assert admin.email == ADMIN_EMAIL
    assert admin.is_active is True
    assert admin.role is UserRole.SUPER_ADMIN
    assert type(admin) is User
    assert admin.__table__.name == "users"
    assert admin.password_hash
    assert admin.password_hash != SYNTHETIC_PASSWORD
    assert verify_password(SYNTHETIC_PASSWORD, admin.password_hash) is True
    assert result == AdminPrincipal(id=admin.id, email=ADMIN_EMAIL)
    assert set(result.model_dump()) == {"id", "email"}
    assert {"password", "password_hash"}.isdisjoint(result.model_dump())


def test_invalid_email_is_rejected_before_hash_or_database(
    admin_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Map invalid email input without hashing or opening a transaction."""
    hash_calls = 0

    def fail_hash(_password: str) -> str:
        nonlocal hash_calls
        hash_calls += 1
        raise AssertionError("Hashing must not run")

    monkeypatch.setattr(bootstrap_module, "hash_password", fail_hash)
    with admin_session_factory() as session:
        with pytest.raises(AdminBootstrapInputError, match="email is invalid"):
            create_admin(session, email="invalid", password=SYNTHETIC_PASSWORD)
    assert hash_calls == 0
    with admin_session_factory() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 0


@pytest.mark.parametrize("length", [14, 129])
def test_invalid_password_boundaries_are_rejected_before_hash_or_database(
    admin_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    length: int,
) -> None:
    """Reject passwords outside the approved 15 through 128 range."""
    monkeypatch.setattr(
        bootstrap_module,
        "hash_password",
        lambda _password: pytest.fail("Hashing must not run"),
    )
    with admin_session_factory() as session:
        with pytest.raises(AdminBootstrapInputError):
            create_admin(session, email=ADMIN_EMAIL, password="x" * length)
    with admin_session_factory() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 0


@pytest.mark.parametrize(
    "password",
    [
        "x" * 15,
        "x" * 128,
        "synthetic Unicode 密碼 value",
        "  synthetic spaced password  ",
    ],
)
def test_valid_password_boundaries_unicode_and_whitespace_are_preserved(
    admin_session_factory: sessionmaker[Session],
    password: str,
) -> None:
    """Accept exact valid Unicode text without trimming its whitespace."""
    with admin_session_factory() as session:
        create_admin(session, email=ADMIN_EMAIL, password=password)
    admin = _load_admin(admin_session_factory)
    assert verify_password(password, admin.password_hash) is True
    if password != password.strip():
        assert verify_password(password.strip(), admin.password_hash) is False


@pytest.mark.parametrize(
    "duplicate_email",
    [ADMIN_EMAIL, "Admin@Example.com", " admin@example.com "],
)
def test_duplicate_normalized_identity_conflicts_without_overwrite(
    admin_session_factory: sessionmaker[Session],
    duplicate_email: str,
) -> None:
    """Keep hash, activation, and timestamps unchanged for duplicate variants."""
    with admin_session_factory() as session:
        create_admin(
            session,
            email=ADMIN_EMAIL,
            password=SYNTHETIC_PASSWORD,
        )
    with admin_session_factory.begin() as session:
        existing = session.scalars(select(User)).one()
        existing.is_active = False
    original = _load_admin(admin_session_factory)
    original_state = (
        original.id,
        original.password_hash,
        original.is_active,
        original.created_at,
        original.updated_at,
    )

    with admin_session_factory() as session:
        with pytest.raises(
            AdminBootstrapConflictError,
            match="identity already exists",
        ):
            create_admin(
                session,
                email=duplicate_email,
                password=OTHER_SYNTHETIC_PASSWORD,
            )

    current = _load_admin(admin_session_factory)
    assert (
        current.id,
        current.password_hash,
        current.is_active,
        current.created_at,
        current.updated_at,
    ) == original_state
    assert verify_password(SYNTHETIC_PASSWORD, current.password_hash) is True
    assert verify_password(OTHER_SYNTHETIC_PASSWORD, current.password_hash) is False


@pytest.mark.parametrize("role", [UserRole.CUSTOMER, UserRole.ADMIN])
def test_bootstrap_is_allowed_when_only_non_super_admin_users_exist(
    admin_session_factory: sessionmaker[Session],
    role: UserRole,
) -> None:
    """Allow the first super-administrator after ordinary identities exist."""
    _store_existing_user(admin_session_factory, role=role)
    with admin_session_factory() as session:
        create_admin(session, email=ADMIN_EMAIL, password=SYNTHETIC_PASSWORD)
    with admin_session_factory() as session:
        roles = session.scalars(select(User.role).order_by(User.role)).all()
    assert roles.count(UserRole.SUPER_ADMIN) == 1
    assert role in roles


@pytest.mark.parametrize("is_active", [True, False])
def test_bootstrap_refuses_any_existing_super_admin(
    admin_session_factory: sessionmaker[Session],
    is_active: bool,
) -> None:
    """Refuse a second highest-trust identity regardless of active state."""
    _store_existing_user(
        admin_session_factory,
        role=UserRole.SUPER_ADMIN,
        is_active=is_active,
    )
    with admin_session_factory() as session:
        with pytest.raises(
            AdminBootstrapConflictError,
            match="identity already exists",
        ):
            create_admin(
                session,
                email=ADMIN_EMAIL,
                password=SYNTHETIC_PASSWORD,
            )
    with admin_session_factory() as session:
        assert (
            session.scalar(
                select(func.count())
                .select_from(User)
                .where(User.role == UserRole.SUPER_ADMIN)
            )
            == 1
        )


def test_unrelated_integrity_error_propagates_after_rollback(
    admin_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Map only the named email constraint and preserve unrelated DB failures."""
    monkeypatch.setattr(bootstrap_module, "hash_password", lambda _password: " ")
    with admin_session_factory() as session:
        with pytest.raises(IntegrityError) as captured:
            create_admin(session, email=ADMIN_EMAIL, password=SYNTHETIC_PASSWORD)
        assert "password_hash_not_blank" in str(captured.value.orig)
        assert session.execute(select(1)).scalar_one() == 1
    with admin_session_factory() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 0


def test_unexpected_programming_error_propagates_and_rolls_back(
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Rollback and propagate an unexpected insert failure unchanged."""

    def fail_insert(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("controlled bootstrap insert failure")

    event.listen(User, "before_insert", fail_insert)
    try:
        with admin_session_factory() as session:
            with pytest.raises(
                RuntimeError, match="controlled bootstrap insert failure"
            ):
                create_admin(
                    session,
                    email=ADMIN_EMAIL,
                    password=SYNTHETIC_PASSWORD,
                )
            assert session.execute(select(1)).scalar_one() == 1
    finally:
        event.remove(User, "before_insert", fail_insert)
    with admin_session_factory() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 0


def test_create_admin_controls_one_commit_and_generates_no_jwt(
    admin_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Commit exactly once without invoking the JWT integration."""
    commits = 0
    rollbacks = 0

    def count_commit(_session: Session) -> None:
        nonlocal commits
        commits += 1

    def count_rollback(_session: Session) -> None:
        nonlocal rollbacks
        rollbacks += 1

    monkeypatch.setattr(
        jwt,
        "encode",
        lambda *_args, **_kwargs: pytest.fail("JWT generation must not run"),
    )
    with admin_session_factory() as session:
        event.listen(session, "after_commit", count_commit)
        event.listen(session, "after_rollback", count_rollback)
        create_admin(session, email=ADMIN_EMAIL, password=SYNTHETIC_PASSWORD)
    assert (commits, rollbacks) == (1, 0)


def test_concurrent_same_identity_allows_one_insert_and_one_safe_conflict(
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Use PostgreSQL uniqueness to resolve a simultaneous duplicate race."""
    barrier = Barrier(2)

    def attempt(password: str) -> AdminPrincipal:
        barrier.wait(timeout=10)
        with admin_session_factory() as session:
            return create_admin(session, email=ADMIN_EMAIL, password=password)

    outcomes: list[AdminPrincipal | Exception] = []
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(attempt, SYNTHETIC_PASSWORD),
            executor.submit(attempt, OTHER_SYNTHETIC_PASSWORD),
        ]
        for future in futures:
            try:
                outcomes.append(future.result(timeout=20))
            except AdminBootstrapConflictError as exc:
                outcomes.append(exc)

    assert sum(isinstance(value, AdminPrincipal) for value in outcomes) == 1
    assert (
        sum(isinstance(value, AdminBootstrapConflictError) for value in outcomes) == 1
    )
    with admin_session_factory() as session:
        assert session.scalar(select(func.count()).select_from(User)) == 1
        assert session.execute(select(1)).scalar_one() == 1


def test_concurrent_different_identities_create_exactly_one_super_admin(
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Serialize bootstrap globally so different emails cannot race highest trust."""
    barrier = Barrier(2)

    def attempt(email: str) -> AdminPrincipal:
        barrier.wait(timeout=10)
        with admin_session_factory() as session:
            return create_admin(
                session,
                email=email,
                password=SYNTHETIC_PASSWORD,
            )

    outcomes: list[AdminPrincipal | Exception] = []
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(attempt, "first-super@example.com"),
            executor.submit(attempt, "second-super@example.com"),
        ]
        for future in futures:
            try:
                outcomes.append(future.result(timeout=20))
            except AdminBootstrapConflictError as exc:
                outcomes.append(exc)

    assert sum(isinstance(value, AdminPrincipal) for value in outcomes) == 1
    assert (
        sum(isinstance(value, AdminBootstrapConflictError) for value in outcomes) == 1
    )
    with admin_session_factory() as session:
        assert (
            session.scalar(
                select(func.count())
                .select_from(User)
                .where(User.role == UserRole.SUPER_ADMIN)
            )
            == 1
        )


def _configure_cli(
    monkeypatch: pytest.MonkeyPatch,
    *,
    create_result: AdminPrincipal | Exception,
) -> tuple[MagicMock, MagicMock, object]:
    engine = MagicMock(spec=Engine)
    validated_url = URL.create(
        REQUIRED_DRIVER,
        database="restaurant_ordering_analytics_dev",
    )
    session_context = MagicMock()
    session = sentinel.session
    session_context.__enter__.return_value = session
    session_factory = MagicMock(return_value=session_context)
    create_admin_mock = MagicMock()
    if isinstance(create_result, Exception):
        create_admin_mock.side_effect = create_result
    else:
        create_admin_mock.return_value = create_result

    monkeypatch.setattr(
        bootstrap_module,
        "Settings",
        lambda: SimpleNamespace(database_url=sentinel.database_url),
    )
    monkeypatch.setattr(
        bootstrap_module,
        "_validate_application_database_url",
        lambda _value: validated_url,
    )
    monkeypatch.setattr(
        bootstrap_module,
        "create_database_engine",
        MagicMock(return_value=engine),
    )
    monkeypatch.setattr(
        bootstrap_module,
        "create_session_factory",
        MagicMock(return_value=session_factory),
    )
    monkeypatch.setattr(bootstrap_module, "create_admin", create_admin_mock)
    return create_admin_mock, engine, session


def test_cli_requires_email_and_rejects_password_argument_before_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expose only the required email option and no password option."""
    prompt = MagicMock(side_effect=AssertionError("Prompt must not run"))
    with pytest.raises(SystemExit) as missing:
        bootstrap_module.main([], getpass_fn=prompt)
    assert missing.value.code == 2
    with pytest.raises(SystemExit) as password_option:
        bootstrap_module.main(
            ["--email", ADMIN_EMAIL, "--password", SYNTHETIC_PASSWORD],
            getpass_fn=prompt,
        )
    assert password_option.value.code == 2
    prompt.assert_not_called()


def test_cli_prompts_twice_and_mismatch_fails_before_configuration(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Reject one confirmation mismatch before settings or database access."""
    prompts: list[str] = []
    answers = iter([SYNTHETIC_PASSWORD, OTHER_SYNTHETIC_PASSWORD])

    def prompt(label: str) -> str:
        prompts.append(label)
        return next(answers)

    monkeypatch.setattr(
        bootstrap_module,
        "Settings",
        lambda: pytest.fail("Configuration must not load"),
    )
    result = bootstrap_module.main(
        ["--email", ADMIN_EMAIL],
        getpass_fn=prompt,
    )
    captured = capsys.readouterr()
    assert result == 1
    assert prompts == ["Password: ", "Confirm password: "]
    assert captured.out == ""
    assert "passwords do not match" in captured.err
    assert SYNTHETIC_PASSWORD not in captured.err
    assert OTHER_SYNTHETIC_PASSWORD not in captured.err


def test_cli_success_calls_core_once_and_prints_only_safe_output(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Pass confirmed input once to the core and dispose the application engine."""
    principal = AdminPrincipal(
        id="bd0fe9fd-e810-4e7f-8c85-2e581cc03162",
        email=ADMIN_EMAIL,
    )
    create_admin_mock, engine, session = _configure_cli(
        monkeypatch,
        create_result=principal,
    )
    result = bootstrap_module.main(
        ["--email", " Admin@EXAMPLE.COM "],
        getpass_fn=lambda _prompt: SYNTHETIC_PASSWORD,
    )
    captured = capsys.readouterr()

    assert result == 0
    create_admin_mock.assert_called_once_with(
        session,
        email=" Admin@EXAMPLE.COM ",
        password=SYNTHETIC_PASSWORD,
    )
    engine.dispose.assert_called_once_with()
    assert captured.out == "Administrator created.\n"
    assert captured.err == ""
    assert SYNTHETIC_PASSWORD not in captured.out
    assert SYNTHETIC_HASH not in captured.out


def test_cli_real_session_flow_preserves_database_credentials(
    test_database_url: URL,
    admin_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Create through the real CLI/session flow on only the isolated test DB."""
    development_url = test_database_url.set(
        database="restaurant_ordering_analytics_dev"
    )
    real_create_database_engine = bootstrap_module.create_database_engine

    def create_isolated_engine(database_url: str | URL) -> Engine:
        serialized_url = str(database_url)
        isolated_url = make_url(serialized_url).set(database=test_database_url.database)
        return real_create_database_engine(
            isolated_url.render_as_string(hide_password=False)
        )

    monkeypatch.setattr(
        bootstrap_module,
        "Settings",
        lambda: SimpleNamespace(
            database_url=development_url.render_as_string(hide_password=False)
        ),
    )
    monkeypatch.setattr(
        bootstrap_module,
        "create_database_engine",
        create_isolated_engine,
    )

    result = bootstrap_module.main(
        ["--email", ADMIN_EMAIL],
        getpass_fn=lambda _prompt: SYNTHETIC_PASSWORD,
    )
    captured = capsys.readouterr()

    assert result == 0
    assert captured.out == "Administrator created.\n"
    assert captured.err == ""
    assert SYNTHETIC_PASSWORD not in captured.out
    admin = _load_admin(admin_session_factory)
    assert admin.email == ADMIN_EMAIL
    assert verify_password(SYNTHETIC_PASSWORD, admin.password_hash) is True


@pytest.mark.parametrize(
    "failure",
    [
        AdminBootstrapConflictError("Administrator identity already exists"),
        AdminBootstrapInputError("Administrator email is invalid"),
    ],
)
def test_cli_maps_expected_core_failures_without_credential_leakage(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    failure: Exception,
) -> None:
    """Return a safe nonzero result for duplicate and invalid input failures."""
    _create_admin_mock, engine, _session = _configure_cli(
        monkeypatch,
        create_result=failure,
    )
    result = bootstrap_module.main(
        ["--email", ADMIN_EMAIL],
        getpass_fn=lambda _prompt: SYNTHETIC_PASSWORD,
    )
    captured = capsys.readouterr()
    combined_output = captured.out + captured.err
    assert result == 1
    assert captured.out == ""
    assert "Administrator creation failed" in captured.err
    assert SYNTHETIC_PASSWORD not in combined_output
    assert SYNTHETIC_HASH not in combined_output
    assert "postgresql" not in combined_output
    assert "Bearer " not in combined_output
    engine.dispose.assert_called_once_with()


@pytest.mark.parametrize(
    "database_name",
    ["postgres", "restaurant_ordering_analytics_test"],
)
def test_cli_database_safety_rejects_admin_and_test_targets(
    database_name: str,
) -> None:
    """Reject known administrative and isolated-test database names safely."""
    url = URL.create(REQUIRED_DRIVER, database=database_name)
    with pytest.raises(
        AdminBootstrapInputError,
        match="requires an application database",
    ):
        bootstrap_module._validate_application_database_url(
            url.render_as_string(hide_password=False)
        )


def test_bootstrap_error_text_contains_no_sensitive_material(
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Keep expected exceptions free of passwords, hashes, URLs, and tokens."""
    with admin_session_factory() as session:
        create_admin(session, email=ADMIN_EMAIL, password=SYNTHETIC_PASSWORD)
    with admin_session_factory() as session:
        with pytest.raises(AdminBootstrapConflictError) as captured:
            create_admin(
                session,
                email=ADMIN_EMAIL,
                password=OTHER_SYNTHETIC_PASSWORD,
            )
    message = str(captured.value)
    assert SYNTHETIC_PASSWORD not in message
    assert OTHER_SYNTHETIC_PASSWORD not in message
    assert "$argon2" not in message
    assert "postgresql" not in message
    assert "Bearer " not in message
