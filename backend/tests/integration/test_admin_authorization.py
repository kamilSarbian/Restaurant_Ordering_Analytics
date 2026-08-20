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
from app.auth.service import (
    ALGORITHM,
    ISSUER,
    USER_AUDIENCE,
    USER_TOKEN_TYPE,
    UserTokenService,
)
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app

pytestmark = pytest.mark.integration

SYNTHETIC_SECRET = "r" * 32
FIXED_NOW = datetime(2026, 8, 12, 12, tzinfo=UTC)
ISSUED_AT = int(FIXED_NOW.timestamp())
LEGACY_AUDIENCE = "restaurant-ordering-analytics-admin"
LEGACY_TOKEN_TYPE = "admin_access"
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
def client(
    authorization_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
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
    "role",
    [UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN],
)
def test_legacy_admin_access_is_rejected_for_every_database_role(
    client: TestClient,
    authorization_session_factory: sessionmaker[Session],
    role: UserRole,
) -> None:
    """Reject signed admin_access without consulting its stored User role."""
    user_id = _store_user(authorization_session_factory, role=role)
    token = jwt.encode(
        {
            "sub": str(user_id),
            "type": LEGACY_TOKEN_TYPE,
            "iat": ISSUED_AT,
            "exp": ISSUED_AT + 1800,
            "iss": ISSUER,
            "aud": LEGACY_AUDIENCE,
        },
        SYNTHETIC_SECRET,
        algorithm=ALGORITHM,
    )
    response = _read_admin(client, ADMIN_READS[0][1], {}, token)
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication credentials"}


@pytest.mark.parametrize(
    ("token_type", "audience", "issuer"),
    [
        (USER_TOKEN_TYPE, LEGACY_AUDIENCE, ISSUER),
        (LEGACY_TOKEN_TYPE, USER_AUDIENCE, ISSUER),
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


def test_canonical_auth_config_builds_only_the_user_access_validator(
    authorization_session_factory: sessionmaker[Session],
) -> None:
    """Build one canonical validator without restoring legacy runtime state."""
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
    assert not hasattr(application.state, "admin_token_service")
    with TestClient(application) as client:
        assert _read_admin(client, ADMIN_READS[0][1], {}, canonical).status_code == 200


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


@pytest.mark.parametrize(
    ("new_role", "is_active", "expected_status", "expected_detail"),
    [
        (UserRole.CUSTOMER, True, 403, "Administrator access required"),
        (UserRole.ADMIN, False, 401, "Invalid authentication credentials"),
    ],
)
def test_same_token_reflects_database_role_and_activity_changes(
    client: TestClient,
    authorization_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    new_role: UserRole,
    is_active: bool,
    expected_status: int,
    expected_detail: str,
) -> None:
    """Prove current DB role and activity authority for canonical tokens."""
    user_id = _store_user(authorization_session_factory, role=UserRole.ADMIN)
    token = user_token_service.create_access_token(user_id)
    assert _read_admin(client, ADMIN_READS[0][1], {}, token).status_code == 200

    with authorization_session_factory.begin() as session:
        user = session.get(User, user_id)
        assert user is not None
        user.role = new_role
        user.is_active = is_active

    response = _read_admin(client, ADMIN_READS[0][1], {}, token)
    assert response.status_code == expected_status
    assert response.json() == {"detail": expected_detail}


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
