"""Unit coverage for the closed portfolio authentication boundary."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from typing import NoReturn
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.auth import users_router
from app.auth.models import User
from app.auth.roles import UserRole
from app.core.config import Settings
from app.main import create_app

REGISTER_PATH = "/api/v1/auth/register"
LOGIN_PATH = "/api/v1/auth/login"
ME_PATH = "/api/v1/auth/me"
DEMO_SESSION_PATH = "/api/v1/auth/demo-session"
CUSTOMER_DEMO_SESSION_PATH = "/api/v1/auth/customer-demo-session"
SYNTHETIC_SECRET = "b4-closed-boundary-secret-material"
SYNTHETIC_PASSWORD = "synthetic-user-password"


class _UserSession:
    def __init__(self, user: User) -> None:
        self._user = user

    def scalar(self, _statement: object) -> User:
        return self._user

    def expunge(self, _user: User) -> None:
        return None


def _session_factory(
    user: User,
) -> Callable[[], AbstractContextManager[_UserSession]]:
    @contextmanager
    def factory() -> Iterator[_UserSession]:
        yield _UserSession(user)

    return factory


def _user() -> User:
    return User(
        id=uuid4(),
        email="synthetic-admin@example.com",
        password_hash="not-used-by-these-tests",
        role=UserRole.ADMIN,
        is_active=True,
    )


def _registration_payload() -> dict[str, str]:
    return {
        "email": "new-user@example.com",
        "password": SYNTHETIC_PASSWORD,
    }


def _login_payload() -> dict[str, str]:
    return {
        "email": "synthetic-admin@example.com",
        "password": SYNTHETIC_PASSWORD,
    }


def _unexpected_access(*_args: object, **_kwargs: object) -> NoReturn:
    raise AssertionError("Portfolio auth boundary accessed protected auth state")


def _patch_auth_access_as_unexpected(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "_get_token_service",
        "_get_session_factory",
        "_enforce_rate_limit",
        "_enforce_demo_session_rate_limit",
        "_enforce_login_rate_limit",
        "verify_demo_admin",
        "verify_demo_customer",
        "_issue_token",
        "create_customer",
        "authenticate_user",
    ):
        monkeypatch.setattr(users_router, name, _unexpected_access)


def test_non_demo_mode_preserves_password_auth_and_me(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep canonical auth behavior for the exact non-demo runtime pair."""
    user = _user()
    monkeypatch.setattr(
        users_router,
        "create_customer",
        lambda *_args, **_kwargs: user,
    )
    monkeypatch.setattr(
        users_router,
        "authenticate_user",
        lambda *_args, **_kwargs: user,
    )
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SYNTHETIC_SECRET,
            portfolio_demo_mode=False,
            payment_provider="stripe_test",
        ),
        session_factory=_session_factory(user),  # type: ignore[arg-type]
    )

    with TestClient(application) as client:
        registered = client.post(REGISTER_PATH, json=_registration_payload())
        logged_in = client.post(LOGIN_PATH, json=_login_payload())
        demo_session = client.post(DEMO_SESSION_PATH)
        customer_demo_session = client.post(CUSTOMER_DEMO_SESSION_PATH)
        current = client.get(
            ME_PATH,
            headers={
                "Authorization": f"Bearer {logged_in.json()['access_token']}",
            },
        )

    assert registered.status_code == 201
    assert logged_in.status_code == 200
    assert demo_session.status_code == 404
    assert demo_session.json() == {"detail": "Not Found"}
    assert customer_demo_session.status_code == 404
    assert customer_demo_session.json() == {"detail": "Not Found"}
    assert current.status_code == 200
    assert current.json()["role"] == "admin"


def test_normal_runtime_closes_demo_session_before_protected_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Return 404 before limiter, database, or JWT access in normal runtime."""
    _patch_auth_access_as_unexpected(monkeypatch)
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SYNTHETIC_SECRET,
            portfolio_demo_mode=False,
            payment_provider="stripe_test",
        ),
        session_factory=_session_factory(_user()),  # type: ignore[arg-type]
    )

    with TestClient(application) as client:
        response = client.post(DEMO_SESSION_PATH)

    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}
    assert "access_token" not in response.text


def test_disabled_customer_demo_session_closes_before_protected_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Return 404 before limiter, database, or JWT work when disabled."""
    _patch_auth_access_as_unexpected(monkeypatch)
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SYNTHETIC_SECRET,
            portfolio_demo_mode=True,
            payment_provider="demo",
            customer_demo_session_issuance_enabled=False,
        ),
        session_factory=_session_factory(_user()),  # type: ignore[arg-type]
    )

    with TestClient(application) as client:
        response = client.post(CUSTOMER_DEMO_SESSION_PATH)

    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}
    assert "access_token" not in response.text


@pytest.mark.parametrize("issuance_state", [False, None, "true"])
def test_noncanonical_issuance_state_closes_demo_session_before_protected_access(
    monkeypatch: pytest.MonkeyPatch,
    issuance_state: object,
) -> None:
    """Require the exact trusted boolean before any protected session work."""
    _patch_auth_access_as_unexpected(monkeypatch)
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SYNTHETIC_SECRET,
            portfolio_demo_mode=True,
            demo_session_issuance_enabled=False,
            payment_provider="demo",
        ),
        session_factory=_session_factory(_user()),  # type: ignore[arg-type]
    )
    if issuance_state is None:
        del application.state.demo_session_issuance_enabled
    else:
        application.state.demo_session_issuance_enabled = issuance_state

    with TestClient(application) as client:
        response = client.post(DEMO_SESSION_PATH)

    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}
    assert "access_token" not in response.text


def test_demo_mode_closes_password_auth_before_protected_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Return constant 404s without reading identity, password, token, or DB state."""
    _patch_auth_access_as_unexpected(monkeypatch)
    user = _user()
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SYNTHETIC_SECRET,
            portfolio_demo_mode=True,
            payment_provider="demo",
        ),
        session_factory=_session_factory(user),  # type: ignore[arg-type]
    )
    token = application.state.user_token_service.create_access_token(user.id)

    with TestClient(application) as client:
        blocked_password_auth = [
            client.post(REGISTER_PATH, json=_registration_payload()),
            client.post(REGISTER_PATH, json={}),
            client.post(
                REGISTER_PATH,
                content="{",
                headers={"Content-Type": "application/json"},
            ),
            client.post(LOGIN_PATH, json=_login_payload()),
            client.post(LOGIN_PATH, json={}),
            client.post(
                LOGIN_PATH,
                content="{",
                headers={"Content-Type": "application/json"},
            ),
        ]
        current = client.get(
            ME_PATH,
            headers={"Authorization": f"Bearer {token}"},
        )

    for response in blocked_password_auth:
        assert response.status_code == 404
        assert response.json() == {"detail": "Not Found"}
        assert "access_token" not in response.text
    assert current.status_code == 200
    assert current.json()["role"] == "admin"


@pytest.mark.parametrize(
    ("portfolio_demo_mode", "payment_provider"),
    [(True, "stripe_test"), (False, "demo"), (None, None)],
)
def test_public_auth_routes_fail_closed_for_inconsistent_runtime_state(
    monkeypatch: pytest.MonkeyPatch,
    portfolio_demo_mode: bool | None,
    payment_provider: str | None,
) -> None:
    """Refuse both public auth surfaces if trusted runtime state is inconsistent."""
    _patch_auth_access_as_unexpected(monkeypatch)
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SYNTHETIC_SECRET,
        ),
        session_factory=_session_factory(_user()),  # type: ignore[arg-type]
    )
    if portfolio_demo_mode is None:
        del application.state.portfolio_demo_mode
    else:
        application.state.portfolio_demo_mode = portfolio_demo_mode
    if payment_provider is None:
        del application.state.payment_provider
    else:
        application.state.payment_provider = payment_provider

    with TestClient(application) as client:
        registration = client.post(REGISTER_PATH, json=_registration_payload())
        login = client.post(LOGIN_PATH, json=_login_payload())
        demo_session = client.post(DEMO_SESSION_PATH)

    for response in (registration, login, demo_session):
        assert response.status_code == 404
        assert response.json() == {"detail": "Not Found"}
        assert "access_token" not in response.text
