"""Integration coverage for bounded portfolio demo-session issuance."""

from __future__ import annotations

import re
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import NoReturn
from uuid import uuid4

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.auth import users_router
from app.auth.demo_admin import (
    DEMO_ADMIN_DISABLED_PASSWORD_HASH,
    DEMO_ADMIN_EMAIL,
    DEMO_ADMIN_ID,
)
from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.service import USER_AUDIENCE, USER_TOKEN_TYPE, UserTokenService
from app.core.config import Settings
from app.core.rate_limit import (
    DEMO_SESSION_CLIENT_IP_MODE_RENDER,
    FixedWindowRateLimiter,
)
from app.database.session import create_session_factory
from app.main import create_app

pytestmark = pytest.mark.integration

DEMO_SESSION_PATH = "/api/v1/auth/demo-session"
ME_PATH = "/api/v1/auth/me"
SYNTHETIC_SECRET = "d" * 32
FIXED_NOW = datetime(2026, 11, 4, 12, tzinfo=UTC)


@pytest.fixture(autouse=True)
def empty_users(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep demo-session cases isolated from every persisted User identity."""
    with test_database_engine.begin() as connection:
        connection.execute(delete(User))
    try:
        yield
    finally:
        with test_database_engine.begin() as connection:
            connection.execute(delete(User))


@pytest.fixture
def demo_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create sessions bound only to the guarded integration database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def demo_token_service() -> UserTokenService:
    """Create deterministic canonical signing with a seven-minute lifetime."""
    return UserTokenService(
        SYNTHETIC_SECRET,
        access_token_expire_minutes=7,
        now_provider=lambda: FIXED_NOW,
    )


def _application(
    factory: sessionmaker[Session],
    *,
    token_service: UserTokenService | None,
    limiter: FixedWindowRateLimiter | None = None,
    render_proxy: bool = False,
):
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
            portfolio_demo_mode=True,
            demo_session_issuance_enabled=True,
            payment_provider="demo",
        ),
        session_factory=factory,
        user_token_service=token_service,
        demo_session_rate_limiter=limiter,
    )
    if render_proxy:
        application.state.demo_session_client_ip_mode = (
            DEMO_SESSION_CLIENT_IP_MODE_RENDER
        )
    return application


def _demo_user(**overrides: object) -> User:
    values: dict[str, object] = {
        "id": DEMO_ADMIN_ID,
        "email": DEMO_ADMIN_EMAIL,
        "password_hash": DEMO_ADMIN_DISABLED_PASSWORD_HASH,
        "role": UserRole.ADMIN,
        "is_active": True,
    }
    values.update(overrides)
    return User(**values)  # type: ignore[arg-type]


def _store_identity_variant(
    factory: sessionmaker[Session],
    variant: str,
) -> None:
    if variant == "missing":
        return
    users = {
        "wrong-id": [_demo_user(id=uuid4())],
        "wrong-email": [_demo_user(email="drifted-demo-admin@example.com")],
        "wrong-hash": [_demo_user(password_hash="!drifted-disabled-marker")],
        "super-admin": [_demo_user(role=UserRole.SUPER_ADMIN)],
        "inactive": [_demo_user(is_active=False)],
        "collision": [
            _demo_user(email="reserved-id-collision@example.com"),
            _demo_user(id=uuid4()),
        ],
    }
    with factory.begin() as session:
        session.add_all(users[variant])


@contextmanager
def _captured_statements(engine: Engine) -> Iterator[list[str]]:
    statements: list[str] = []

    def capture(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", capture)


def _assert_one_read_only_user_select(statements: list[str]) -> None:
    assert len(statements) == 1
    normalized = " ".join(statements[0].lower().split())
    assert normalized.startswith("select ")
    assert " from users " in f" {normalized} "
    assert " join " not in f" {normalized} "
    assert "users.id" in normalized
    assert "users.email" in normalized
    assert re.search(r"\b(insert|update|delete|merge|truncate)\b", normalized) is None


def _unexpected_access(*_args: object, **_kwargs: object) -> NoReturn:
    raise AssertionError("Rate-limited demo session accessed protected state")


def test_exact_demo_admin_receives_canonical_short_lived_token(
    demo_session_factory: sessionmaker[Session],
    demo_token_service: UserTokenService,
    test_database_engine: Engine,
) -> None:
    """Issue one role-neutral canonical JWT after exactly one read-only User query."""
    with demo_session_factory.begin() as session:
        session.add(_demo_user())
    application = _application(
        demo_session_factory,
        token_service=demo_token_service,
    )

    with TestClient(application) as client:
        with _captured_statements(test_database_engine) as statements:
            response = client.post(DEMO_SESSION_PATH)
        current = client.get(
            ME_PATH,
            headers={"Authorization": f"Bearer {response.json()['access_token']}"},
        )

    assert response.status_code == 200
    assert set(response.json()) == {"access_token", "token_type", "expires_in"}
    assert response.json()["token_type"] == "bearer"
    assert response.json()["expires_in"] == 420
    claims = jwt.decode(
        response.json()["access_token"],
        options={"verify_signature": False},
    )
    assert set(claims) == {"sub", "type", "iat", "exp", "iss", "aud"}
    assert claims["sub"] == str(DEMO_ADMIN_ID)
    assert claims["type"] == USER_TOKEN_TYPE
    assert claims["aud"] == USER_AUDIENCE
    assert {"role", "email", "is_active", "password_hash"}.isdisjoint(claims)
    assert current.status_code == 200
    assert current.json() == {
        "id": str(DEMO_ADMIN_ID),
        "email": DEMO_ADMIN_EMAIL,
        "role": "admin",
        "is_active": True,
    }
    _assert_one_read_only_user_select(statements)
    with demo_session_factory() as session:
        stored = session.scalar(select(User))
        assert stored is not None
        assert stored.id == DEMO_ADMIN_ID
        assert stored.email == DEMO_ADMIN_EMAIL
        assert stored.password_hash == DEMO_ADMIN_DISABLED_PASSWORD_HASH
        assert stored.role is UserRole.ADMIN
        assert stored.is_active is True


@pytest.mark.parametrize(
    "variant",
    [
        "missing",
        "wrong-id",
        "wrong-email",
        "wrong-hash",
        "super-admin",
        "inactive",
        "collision",
    ],
)
def test_missing_conflicting_or_drifted_demo_identity_returns_same_safe_failure(
    variant: str,
    demo_session_factory: sessionmaker[Session],
    demo_token_service: UserTokenService,
    test_database_engine: Engine,
) -> None:
    """Refuse every reserved-identity drift without a token or database mutation."""
    _store_identity_variant(demo_session_factory, variant)
    application = _application(
        demo_session_factory,
        token_service=demo_token_service,
    )
    with TestClient(application) as client:
        with _captured_statements(test_database_engine) as statements:
            response = client.post(DEMO_SESSION_PATH)

    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}
    assert "access_token" not in response.text
    _assert_one_read_only_user_select(statements)


def test_database_failure_is_sanitized_without_issuing_a_token(
    demo_session_factory: sessionmaker[Session],
    demo_token_service: UserTokenService,
    test_database_engine: Engine,
) -> None:
    """Translate a raw PostgreSQL read failure to the stable public 503 response."""
    application = _application(
        demo_session_factory,
        token_service=demo_token_service,
    )

    def fail_read(
        _connection: object,
        _cursor: object,
        _statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> NoReturn:
        raise OperationalError(
            "hidden statement",
            {},
            RuntimeError("private database detail"),
        )

    event.listen(test_database_engine, "before_cursor_execute", fail_read)
    try:
        with TestClient(application) as client:
            response = client.post(DEMO_SESSION_PATH)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", fail_read)

    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}
    assert "private database detail" not in response.text
    assert "hidden statement" not in response.text
    assert "access_token" not in response.text


def test_missing_token_service_fails_before_demo_identity_read(
    demo_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Refuse unavailable signing configuration without touching User state."""
    with demo_session_factory.begin() as session:
        session.add(_demo_user())
    application = _application(demo_session_factory, token_service=None)
    with TestClient(application) as client:
        with _captured_statements(test_database_engine) as statements:
            response = client.post(DEMO_SESSION_PATH)
    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}
    assert statements == []
    assert "access_token" not in response.text


def test_demo_session_limiter_blocks_before_database_and_token_work(
    monkeypatch: pytest.MonkeyPatch,
    demo_session_factory: sessionmaker[Session],
    demo_token_service: UserTokenService,
) -> None:
    """Keep the dedicated bucket ahead of identity verification and signing."""
    with demo_session_factory.begin() as session:
        session.add(_demo_user())
    application = _application(
        demo_session_factory,
        token_service=demo_token_service,
        limiter=FixedWindowRateLimiter(limit=1, window_seconds=60),
    )
    with TestClient(application, client=("demo-peer", 50000)) as client:
        accepted = client.post(DEMO_SESSION_PATH)
        monkeypatch.setattr(users_router, "verify_demo_admin", _unexpected_access)
        monkeypatch.setattr(users_router, "_issue_token", _unexpected_access)
        blocked = client.post(DEMO_SESSION_PATH)

    assert accepted.status_code == 200
    assert blocked.status_code == 429
    assert blocked.json() == {"detail": "Too many authentication attempts"}
    assert int(blocked.headers["Retry-After"]) > 0
    assert "access_token" not in blocked.text


def test_render_visitors_behind_one_proxy_have_independent_limits(
    demo_session_factory: sessionmaker[Session],
    demo_token_service: UserTokenService,
) -> None:
    """Separate visitors by Render's canonical edge address, not proxy peer."""
    with demo_session_factory.begin() as session:
        session.add(_demo_user())
    application = _application(
        demo_session_factory,
        token_service=demo_token_service,
        limiter=FixedWindowRateLimiter(limit=1, window_seconds=60),
        render_proxy=True,
    )
    visitor_a_headers = {"CF-Connecting-IP": "203.0.113.10"}
    visitor_b_headers = {"CF-Connecting-IP": "2001:db8::20"}

    with TestClient(application, client=("render-proxy", 50000)) as visitor_a:
        first_a = visitor_a.post(DEMO_SESSION_PATH, headers=visitor_a_headers)
    with TestClient(application, client=("render-proxy", 50000)) as visitor_b:
        first_b = visitor_b.post(DEMO_SESSION_PATH, headers=visitor_b_headers)
    with TestClient(application, client=("render-proxy", 50000)) as visitor_a:
        second_a = visitor_a.post(DEMO_SESSION_PATH, headers=visitor_a_headers)
    with TestClient(application, client=("render-proxy", 50000)) as visitor_b:
        second_b = visitor_b.post(DEMO_SESSION_PATH, headers=visitor_b_headers)

    assert first_a.status_code == 200
    assert first_b.status_code == 200
    for blocked in (second_a, second_b):
        assert blocked.status_code == 429
        assert blocked.json() == {"detail": "Too many authentication attempts"}
        assert "access_token" not in blocked.text


def test_spoofed_x_forwarded_for_does_not_change_render_visitor_limit(
    demo_session_factory: sessionmaker[Session],
    demo_token_service: UserTokenService,
) -> None:
    """Ignore attacker-controlled X-Forwarded-For for the Render bucket."""
    with demo_session_factory.begin() as session:
        session.add(_demo_user())
    application = _application(
        demo_session_factory,
        token_service=demo_token_service,
        limiter=FixedWindowRateLimiter(limit=1, window_seconds=60),
        render_proxy=True,
    )
    with TestClient(application, client=("render-proxy", 50000)) as client:
        accepted = client.post(
            DEMO_SESSION_PATH,
            headers={
                "CF-Connecting-IP": "203.0.113.10",
                "X-Forwarded-For": "198.51.100.20",
            },
        )
        blocked = client.post(
            DEMO_SESSION_PATH,
            headers={
                "CF-Connecting-IP": "203.0.113.10",
                "X-Forwarded-For": "192.0.2.30",
            },
        )

    assert accepted.status_code == 200
    assert blocked.status_code == 429
    assert blocked.json() == {"detail": "Too many authentication attempts"}
    assert "access_token" not in blocked.text


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"CF-Connecting-IP": "not-an-ip"},
        {"CF-Connecting-IP": "203.0.113.10, 198.51.100.20"},
        {"X-Forwarded-For": "203.0.113.10"},
        {
            "CF-Connecting-IP": "not-an-ip",
            "X-Forwarded-For": "203.0.113.10",
        },
    ],
)
def test_missing_or_invalid_render_client_ip_fails_before_database_and_jwt(
    monkeypatch: pytest.MonkeyPatch,
    headers: dict[str, str],
    demo_session_factory: sessionmaker[Session],
    demo_token_service: UserTokenService,
    test_database_engine: Engine,
) -> None:
    """Reject an unusable trusted edge identity before protected work."""
    with demo_session_factory.begin() as session:
        session.add(_demo_user())
    application = _application(
        demo_session_factory,
        token_service=demo_token_service,
        render_proxy=True,
    )
    monkeypatch.setattr(users_router, "_get_token_service", _unexpected_access)
    monkeypatch.setattr(users_router, "_get_session_factory", _unexpected_access)
    monkeypatch.setattr(users_router, "verify_demo_admin", _unexpected_access)
    monkeypatch.setattr(users_router, "_issue_token", _unexpected_access)

    with TestClient(application, client=("render-proxy", 50000)) as client:
        with _captured_statements(test_database_engine) as statements:
            response = client.post(DEMO_SESSION_PATH, headers=headers)

    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}
    assert "access_token" not in response.text
    assert statements == []
