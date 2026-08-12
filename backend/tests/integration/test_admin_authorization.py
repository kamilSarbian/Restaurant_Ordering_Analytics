"""Representative integration matrix for role-aware administrator authorization."""

from __future__ import annotations

from collections.abc import Generator
from datetime import UTC, datetime
from uuid import UUID, uuid4

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.service import USER_AUDIENCE, USER_TOKEN_TYPE, UserTokenService
from app.auth.tokens import (
    ALGORITHM,
    AUDIENCE,
    ISSUER,
    TOKEN_TYPE,
    AdminTokenService,
)
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app

pytestmark = pytest.mark.integration

SYNTHETIC_SECRET = "r" * 32
FIXED_NOW = datetime(2026, 8, 12, 12, tzinfo=UTC)
ISSUED_AT = int(FIXED_NOW.timestamp())
RANGE_PARAMS = {
    "start": "2026-01-01T00:00:00Z",
    "end": "2026-01-02T00:00:00Z",
}
ADMIN_READS = (
    ("orders", "/api/v1/admin/orders", {}),
    ("menu", "/api/v1/admin/menu/categories", {}),
    ("analytics", "/api/v1/admin/analytics/overview", RANGE_PARAMS),
    ("exports", "/api/v1/admin/exports/orders.csv", RANGE_PARAMS),
)


@pytest.fixture(autouse=True)
def empty_users(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep RBAC identities isolated in the exact guarded test database."""
    with test_database_engine.begin() as connection:
        connection.execute(delete(User))
    try:
        yield
    finally:
        with test_database_engine.begin() as connection:
            connection.execute(delete(User))


@pytest.fixture
def authorization_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create sessions bound only to isolated PostgreSQL."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def user_token_service() -> UserTokenService:
    """Create deterministic canonical signing for RBAC tests."""
    return UserTokenService(SYNTHETIC_SECRET, now_provider=lambda: FIXED_NOW)


@pytest.fixture
def legacy_token_service() -> AdminTokenService:
    """Create deterministic legacy validation tokens for transition tests."""
    return AdminTokenService(SYNTHETIC_SECRET, now_provider=lambda: FIXED_NOW)


@pytest.fixture
def client(
    authorization_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    legacy_token_service: AdminTokenService,
) -> Generator[TestClient, None, None]:
    """Run unchanged domain routers behind the centralized dependency."""
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
        ),
        session_factory=authorization_session_factory,
        user_token_service=user_token_service,
        admin_token_service=legacy_token_service,
    )
    with TestClient(application) as test_client:
        yield test_client


def _store_user(
    factory: sessionmaker[Session],
    *,
    role: UserRole,
    is_active: bool = True,
) -> UUID:
    with factory.begin() as session:
        user = User(
            email=f"rbac-{uuid4().hex}@example.com",
            password_hash="synthetic-rbac-password-hash",
            role=role,
            is_active=is_active,
        )
        session.add(user)
        session.flush()
        return user.id


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _read_admin(
    client: TestClient,
    path: str,
    params: dict[str, str],
    token: str | None,
):
    headers = {} if token is None else _authorization(token)
    return client.get(path, params=params, headers=headers)


@pytest.mark.parametrize(("family", "path", "params"), ADMIN_READS)
@pytest.mark.parametrize(
    ("role", "expected_status"),
    [
        (UserRole.CUSTOMER, 403),
        (UserRole.ADMIN, 200),
        (UserRole.SUPER_ADMIN, 200),
    ],
)
def test_canonical_user_access_uses_current_role_for_each_admin_family(
    client: TestClient,
    authorization_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    family: str,
    path: str,
    params: dict[str, str],
    role: UserRole,
    expected_status: int,
) -> None:
    """Apply customer/admin/super_admin policy centrally to unchanged routers."""
    user_id = _store_user(authorization_session_factory, role=role)
    token = user_token_service.create_access_token(user_id)
    response = _read_admin(client, path, params, token)
    assert response.status_code == expected_status, family


@pytest.mark.parametrize(
    ("role", "expected_status"),
    [
        (UserRole.CUSTOMER, 403),
        (UserRole.ADMIN, 200),
        (UserRole.SUPER_ADMIN, 200),
    ],
)
def test_legacy_admin_access_uses_current_database_role(
    client: TestClient,
    authorization_session_factory: sessionmaker[Session],
    legacy_token_service: AdminTokenService,
    role: UserRole,
    expected_status: int,
) -> None:
    """Treat legacy token type as identity only, never as administrator proof."""
    user_id = _store_user(authorization_session_factory, role=role)
    token = legacy_token_service.create_access_token(user_id)
    response = _read_admin(client, ADMIN_READS[0][1], {}, token)
    assert response.status_code == expected_status


@pytest.mark.parametrize(
    ("token_type", "audience", "issuer"),
    [
        (USER_TOKEN_TYPE, AUDIENCE, ISSUER),
        (TOKEN_TYPE, USER_AUDIENCE, ISSUER),
        (None, USER_AUDIENCE, ISSUER),
        ("unknown_access", USER_AUDIENCE, ISSUER),
        (USER_TOKEN_TYPE, USER_AUDIENCE, "wrong-issuer"),
    ],
)
def test_confused_or_incomplete_token_contracts_are_rejected(
    client: TestClient,
    authorization_session_factory: sessionmaker[Session],
    token_type: str | None,
    audience: str,
    issuer: str,
) -> None:
    """Reject signed family mixing, absent types, and the wrong issuer."""
    user_id = _store_user(authorization_session_factory, role=UserRole.ADMIN)
    claims: dict[str, object] = {
        "sub": str(user_id),
        "iat": ISSUED_AT,
        "exp": ISSUED_AT + 1800,
        "iss": issuer,
        "aud": audience,
    }
    if token_type is not None:
        claims["type"] = token_type
    token = jwt.encode(
        claims,
        SYNTHETIC_SECRET,
        algorithm=ALGORITHM,
    )
    response = _read_admin(client, ADMIN_READS[0][1], {}, token)
    assert response.status_code == 401


def test_canonical_auth_config_builds_both_strict_role_aware_validators(
    authorization_session_factory: sessionmaker[Session],
) -> None:
    """Use one canonical key while retaining isolated token-family contracts."""
    user_id = _store_user(
        authorization_session_factory,
        role=UserRole.SUPER_ADMIN,
    )
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SYNTHETIC_SECRET,
            auth_access_token_expire_minutes=30,
        ),
        session_factory=authorization_session_factory,
    )
    canonical = application.state.user_token_service.create_access_token(user_id)
    legacy = application.state.admin_token_service.create_access_token(user_id)
    with TestClient(application) as client:
        for token in (canonical, legacy):
            assert _read_admin(client, ADMIN_READS[0][1], {}, token).status_code == 200


@pytest.mark.parametrize("token", [None, "not-a-jwt"])
def test_missing_and_malformed_admin_credentials_return_401(
    client: TestClient,
    token: str | None,
) -> None:
    """Return one authentication failure before domain authorization."""
    response = _read_admin(client, ADMIN_READS[0][1], {}, token)
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication credentials"}


def test_inactive_and_missing_users_return_401(
    client: TestClient,
    authorization_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Require a current active database identity after token validation."""
    inactive_id = _store_user(
        authorization_session_factory,
        role=UserRole.ADMIN,
        is_active=False,
    )
    tokens = (
        user_token_service.create_access_token(inactive_id),
        user_token_service.create_access_token(uuid4()),
    )
    for token in tokens:
        response = _read_admin(client, ADMIN_READS[0][1], {}, token)
        assert response.status_code == 401


@pytest.mark.parametrize("legacy", [False, True])
def test_same_token_loses_access_immediately_after_database_demotion(
    client: TestClient,
    authorization_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    legacy_token_service: AdminTokenService,
    legacy: bool,
) -> None:
    """Prove current DB role authority for canonical and legacy token families."""
    user_id = _store_user(authorization_session_factory, role=UserRole.ADMIN)
    service = legacy_token_service if legacy else user_token_service
    token = service.create_access_token(user_id)
    assert _read_admin(client, ADMIN_READS[0][1], {}, token).status_code == 200

    with authorization_session_factory.begin() as session:
        user = session.get(User, user_id)
        assert user is not None
        user.role = UserRole.CUSTOMER

    response = _read_admin(client, ADMIN_READS[0][1], {}, token)
    assert response.status_code == 403
    assert response.json() == {"detail": "Administrator access required"}


def test_database_failure_returns_safe_503(
    client: TestClient,
    authorization_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    test_database_engine: Engine,
) -> None:
    """Hide SQL and driver details from the administrator auth boundary."""
    user_id = _store_user(authorization_session_factory, role=UserRole.ADMIN)
    token = user_token_service.create_access_token(user_id)

    def fail_statement(*_: object, **__: object) -> None:
        raise OperationalError("synthetic statement", {}, RuntimeError("synthetic"))

    event.listen(test_database_engine, "before_cursor_execute", fail_statement)
    try:
        response = _read_admin(client, ADMIN_READS[0][1], {}, token)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", fail_statement)
    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}
    assert "synthetic" not in response.text
