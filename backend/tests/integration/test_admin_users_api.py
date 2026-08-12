"""Integration tests for super-administrator user and role management."""

from __future__ import annotations

from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.dependencies import require_super_admin
from app.auth.models import User
from app.auth.roles import UserRole
from app.auth.schemas import AdminPrincipal
from app.auth.service import UserTokenService
from app.auth.tokens import AdminTokenService
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app

pytestmark = pytest.mark.integration

USERS_PATH = "/api/v1/admin/users"
ADMIN_ORDERS_PATH = "/api/v1/admin/orders"
ME_PATH = "/api/v1/auth/me"
SYNTHETIC_SECRET = "m" * 32
FIXED_NOW = datetime(2026, 8, 12, 12, tzinfo=UTC)
SAFE_LIST_FIELDS = {
    "id",
    "email",
    "role",
    "is_active",
    "created_at",
    "updated_at",
}
SAFE_UPDATE_FIELDS = {"id", "email", "role", "updated_at"}


@pytest.fixture(autouse=True)
def empty_users(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep role-management identities isolated in the guarded test database."""
    with test_database_engine.begin() as connection:
        connection.execute(delete(User))
    try:
        yield
    finally:
        with test_database_engine.begin() as connection:
            connection.execute(delete(User))


@pytest.fixture
def user_session_factory(test_database_engine: Engine) -> sessionmaker[Session]:
    """Create sessions bound only to isolated PostgreSQL."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def user_token_service() -> UserTokenService:
    """Create deterministic canonical signing for user-management tests."""
    return UserTokenService(SYNTHETIC_SECRET, now_provider=lambda: FIXED_NOW)


@pytest.fixture
def legacy_token_service() -> AdminTokenService:
    """Create deterministic legacy token validation for compatibility tests."""
    return AdminTokenService(SYNTHETIC_SECRET, now_provider=lambda: FIXED_NOW)


@pytest.fixture
def application(
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    legacy_token_service: AdminTokenService,
):
    """Build the API with isolated persistence and both strict token families."""
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            admin_jwt_secret=None,
        ),
        session_factory=user_session_factory,
        user_token_service=user_token_service,
        admin_token_service=legacy_token_service,
    )


@pytest.fixture
def client(application) -> Generator[TestClient, None, None]:
    """Run user-management routes through the complete FastAPI boundary."""
    with TestClient(application) as test_client:
        yield test_client


def _store_user(
    factory: sessionmaker[Session],
    *,
    role: UserRole,
    email: str | None = None,
    is_active: bool = True,
    created_at: datetime | None = None,
    user_id: UUID | None = None,
) -> UUID:
    with factory.begin() as session:
        user = User(
            id=user_id or uuid4(),
            email=email or f"user-{uuid4().hex}@example.com",
            password_hash="synthetic-role-management-password-hash",
            role=role,
            is_active=is_active,
        )
        if created_at is not None:
            user.created_at = created_at
            user.updated_at = created_at
        session.add(user)
        session.flush()
        return user.id


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _role_path(user_id: UUID) -> str:
    return f"{USERS_PATH}/{user_id}/role"


def _super_admin_token(
    factory: sessionmaker[Session],
    service: UserTokenService,
) -> str:
    user_id = _store_user(factory, role=UserRole.SUPER_ADMIN)
    return service.create_access_token(user_id)


@pytest.mark.parametrize("token", [None, "not-a-jwt"])
def test_list_rejects_missing_and_malformed_credentials(
    client: TestClient,
    token: str | None,
) -> None:
    """Return the generic authentication contract before listing identities."""
    headers = {} if token is None else _authorization(token)
    response = client.get(USERS_PATH, headers=headers)
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication credentials"}


@pytest.mark.parametrize(
    ("role", "expected_status"),
    [
        (UserRole.CUSTOMER, 403),
        (UserRole.ADMIN, 403),
        (UserRole.SUPER_ADMIN, 200),
    ],
)
def test_canonical_token_uses_exact_current_super_admin_role(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    role: UserRole,
    expected_status: int,
) -> None:
    """Authorize user_access from the current database role only."""
    user_id = _store_user(user_session_factory, role=role)
    token = user_token_service.create_access_token(user_id)
    response = client.get(USERS_PATH, headers=_authorization(token))
    assert response.status_code == expected_status


@pytest.mark.parametrize(
    ("role", "expected_status"),
    [
        (UserRole.CUSTOMER, 403),
        (UserRole.ADMIN, 403),
        (UserRole.SUPER_ADMIN, 200),
    ],
)
def test_legacy_token_uses_exact_current_super_admin_role(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    legacy_token_service: AdminTokenService,
    role: UserRole,
    expected_status: int,
) -> None:
    """Accept strict admin_access only for a current super-administrator."""
    user_id = _store_user(user_session_factory, role=role)
    token = legacy_token_service.create_access_token(user_id)
    response = client.get(USERS_PATH, headers=_authorization(token))
    assert response.status_code == expected_status


@pytest.mark.parametrize("missing", [False, True])
def test_inactive_or_missing_super_admin_returns_401(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    missing: bool,
) -> None:
    """Require a current active identity after strict token validation."""
    user_id = (
        uuid4()
        if missing
        else _store_user(
            user_session_factory,
            role=UserRole.SUPER_ADMIN,
            is_active=False,
        )
    )
    token = user_token_service.create_access_token(user_id)
    assert client.get(USERS_PATH, headers=_authorization(token)).status_code == 401


def test_authorization_database_failure_returns_safe_503(
    client: TestClient,
    user_token_service: UserTokenService,
    test_database_engine: Engine,
) -> None:
    """Hide database failure details at the super-admin dependency boundary."""
    token = user_token_service.create_access_token(uuid4())

    def fail_statement(*_: object, **__: object) -> None:
        raise OperationalError("synthetic statement", {}, RuntimeError("synthetic"))

    event.listen(test_database_engine, "before_cursor_execute", fail_statement)
    try:
        response = client.get(USERS_PATH, headers=_authorization(token))
    finally:
        event.remove(test_database_engine, "before_cursor_execute", fail_statement)
    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}
    assert "synthetic" not in response.text


def test_list_defaults_metadata_safe_fields_and_all_roles(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Return exact safe fields and default pagination for every role."""
    token = _super_admin_token(user_session_factory, user_token_service)
    for role in (UserRole.CUSTOMER, UserRole.ADMIN):
        _store_user(user_session_factory, role=role)
    response = client.get(USERS_PATH, headers=_authorization(token))
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"items", "total", "limit", "offset"}
    assert (body["total"], body["limit"], body["offset"]) == (3, 50, 0)
    assert {item["role"] for item in body["items"]} == {
        "customer",
        "admin",
        "super_admin",
    }
    assert all(set(item) == SAFE_LIST_FIELDS for item in body["items"])
    assert all(
        {"password_hash", "access_token", "token_type", "login_history"}.isdisjoint(
            item
        )
        for item in body["items"]
    )


def test_list_empty_page_behavior(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Return an empty item page while retaining the full matching total."""
    token = _super_admin_token(user_session_factory, user_token_service)
    response = client.get(
        USERS_PATH,
        params={"offset": 10},
        headers=_authorization(token),
    )
    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 1, "limit": 50, "offset": 10}


@pytest.mark.parametrize(
    ("params", "expected_status"),
    [
        ({"limit": 1, "offset": 0}, 200),
        ({"limit": 100, "offset": 0}, 200),
        ({"limit": 0}, 422),
        ({"limit": 101}, 422),
        ({"offset": -1}, 422),
    ],
)
def test_list_validates_pagination_bounds(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    params: dict[str, int],
    expected_status: int,
) -> None:
    """Enforce the exact limit and offset query boundaries."""
    token = _super_admin_token(user_session_factory, user_token_service)
    response = client.get(USERS_PATH, params=params, headers=_authorization(token))
    assert response.status_code == expected_status


def test_list_orders_by_created_at_then_id(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Use stable ascending creation time and UUID ordering."""
    token = _super_admin_token(user_session_factory, user_token_service)
    shared_time = FIXED_NOW - timedelta(days=1)
    later_time = FIXED_NOW + timedelta(days=1)
    high_id = UUID("ffffffff-ffff-4fff-8fff-ffffffffffff")
    low_id = UUID("00000000-0000-4000-8000-000000000001")
    _store_user(
        user_session_factory,
        role=UserRole.CUSTOMER,
        created_at=shared_time,
        user_id=high_id,
    )
    _store_user(
        user_session_factory,
        role=UserRole.ADMIN,
        created_at=shared_time,
        user_id=low_id,
    )
    _store_user(
        user_session_factory,
        role=UserRole.CUSTOMER,
        created_at=later_time,
    )
    response = client.get(USERS_PATH, headers=_authorization(token))
    ids = [item["id"] for item in response.json()["items"]]
    assert ids[:2] == [str(low_id), str(high_id)]


@pytest.mark.parametrize(
    ("current_role", "target_role"),
    [
        (UserRole.CUSTOMER, "admin"),
        (UserRole.ADMIN, "customer"),
    ],
)
def test_patch_allows_only_ordinary_cross_role_transitions(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    current_role: UserRole,
    target_role: str,
) -> None:
    """Persist and return each allowed ordinary role transition safely."""
    token = _super_admin_token(user_session_factory, user_token_service)
    target_id = _store_user(user_session_factory, role=current_role)
    response = client.patch(
        _role_path(target_id),
        json={"role": target_role},
        headers=_authorization(token),
    )
    assert response.status_code == 200
    assert set(response.json()) == SAFE_UPDATE_FIELDS
    assert response.json()["role"] == target_role
    with user_session_factory() as session:
        assert session.get(User, target_id).role.value == target_role


@pytest.mark.parametrize("role", [UserRole.CUSTOMER, UserRole.ADMIN])
def test_patch_rejects_same_role_with_409(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    role: UserRole,
) -> None:
    """Reject ineffective transitions without changing the target."""
    token = _super_admin_token(user_session_factory, user_token_service)
    target_id = _store_user(user_session_factory, role=role)
    response = client.patch(
        _role_path(target_id),
        json={"role": role.value},
        headers=_authorization(token),
    )
    assert response.status_code == 409
    assert response.json() == {"detail": "Role transition is not allowed"}


@pytest.mark.parametrize("target_role", ["customer", "admin"])
def test_patch_cannot_modify_a_super_admin_target(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    target_role: str,
) -> None:
    """Keep every highest-trust identity immutable through this endpoint."""
    caller_token = _super_admin_token(user_session_factory, user_token_service)
    target_id = _store_user(user_session_factory, role=UserRole.SUPER_ADMIN)
    response = client.patch(
        _role_path(target_id),
        json={"role": target_role},
        headers=_authorization(caller_token),
    )
    assert response.status_code == 409


@pytest.mark.parametrize(
    "payload",
    [
        {"role": "super_admin"},
        {"role": "owner"},
        {"role": "admin", "is_active": False},
        {},
    ],
)
def test_patch_rejects_super_admin_unknown_extra_and_missing_payloads(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    payload: dict[str, object],
) -> None:
    """Reject every payload outside the exact ordinary role schema."""
    token = _super_admin_token(user_session_factory, user_token_service)
    target_id = _store_user(user_session_factory, role=UserRole.CUSTOMER)
    assert (
        client.patch(
            _role_path(target_id),
            json=payload,
            headers=_authorization(token),
        ).status_code
        == 422
    )


def test_patch_missing_target_returns_404(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Map a locked missing-row lookup to the stable not-found contract."""
    token = _super_admin_token(user_session_factory, user_token_service)
    response = client.patch(
        _role_path(uuid4()),
        json={"role": "admin"},
        headers=_authorization(token),
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "User not found"}


@pytest.mark.parametrize("caller_role", [UserRole.CUSTOMER, UserRole.ADMIN])
def test_patch_rejects_non_super_admin_callers(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    caller_role: UserRole,
) -> None:
    """Deny role management to customers and ordinary administrators."""
    caller_id = _store_user(user_session_factory, role=caller_role)
    target_id = _store_user(user_session_factory, role=UserRole.CUSTOMER)
    response = client.patch(
        _role_path(target_id),
        json={"role": "admin"},
        headers=_authorization(user_token_service.create_access_token(caller_id)),
    )
    assert response.status_code == 403


def test_changed_role_is_immediately_visible_in_list_and_me(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Expose the committed role through list and canonical me with one token."""
    caller_token = _super_admin_token(user_session_factory, user_token_service)
    target_id = _store_user(user_session_factory, role=UserRole.CUSTOMER)
    target_token = user_token_service.create_access_token(target_id)
    changed = client.patch(
        _role_path(target_id),
        json={"role": "admin"},
        headers=_authorization(caller_token),
    )
    assert changed.status_code == 200
    listed = client.get(USERS_PATH, headers=_authorization(caller_token)).json()
    assert (
        next(item for item in listed["items"] if item["id"] == str(target_id))["role"]
        == "admin"
    )
    me = client.get(ME_PATH, headers=_authorization(target_token))
    assert me.status_code == 200
    assert me.json()["role"] == "admin"


def test_demotion_revokes_admin_access_with_same_token(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Apply administrator demotion immediately without token revocation state."""
    caller_token = _super_admin_token(user_session_factory, user_token_service)
    target_id = _store_user(user_session_factory, role=UserRole.ADMIN)
    target_token = user_token_service.create_access_token(target_id)
    assert (
        client.get(ADMIN_ORDERS_PATH, headers=_authorization(target_token)).status_code
        == 200
    )
    assert (
        client.patch(
            _role_path(target_id),
            json={"role": "customer"},
            headers=_authorization(caller_token),
        ).status_code
        == 200
    )
    assert (
        client.get(ADMIN_ORDERS_PATH, headers=_authorization(target_token)).status_code
        == 403
    )


def test_promotion_grants_admin_access_with_same_token(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Apply customer promotion immediately from current database authority."""
    caller_token = _super_admin_token(user_session_factory, user_token_service)
    target_id = _store_user(user_session_factory, role=UserRole.CUSTOMER)
    target_token = user_token_service.create_access_token(target_id)
    assert (
        client.get(ADMIN_ORDERS_PATH, headers=_authorization(target_token)).status_code
        == 403
    )
    assert (
        client.patch(
            _role_path(target_id),
            json={"role": "admin"},
            headers=_authorization(caller_token),
        ).status_code
        == 200
    )
    assert (
        client.get(ADMIN_ORDERS_PATH, headers=_authorization(target_token)).status_code
        == 200
    )


def test_role_update_uses_for_update_and_one_commit(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    test_database_engine: Engine,
) -> None:
    """Exercise a row lock and one atomic commit for the role mutation."""
    caller_token = _super_admin_token(user_session_factory, user_token_service)
    target_id = _store_user(user_session_factory, role=UserRole.CUSTOMER)
    statements: list[str] = []

    def record_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement.upper())

    event.listen(test_database_engine, "before_cursor_execute", record_statement)
    try:
        response = client.patch(
            _role_path(target_id),
            json={"role": "admin"},
            headers=_authorization(caller_token),
        )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", record_statement)
    assert response.status_code == 200
    assert any("FOR UPDATE" in statement for statement in statements)


def test_service_database_failure_returns_safe_503(
    application,
    test_database_engine: Engine,
) -> None:
    """Hide role-service SQL details after authorization succeeds."""
    application.dependency_overrides[require_super_admin] = lambda: AdminPrincipal(
        id=uuid4(), email="synthetic-super@example.com"
    )

    def fail_statement(*_: object, **__: object) -> None:
        raise OperationalError("synthetic statement", {}, RuntimeError("synthetic"))

    event.listen(test_database_engine, "before_cursor_execute", fail_statement)
    try:
        with TestClient(application) as client:
            response = client.get(USERS_PATH)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", fail_statement)
        application.dependency_overrides.clear()
    assert response.status_code == 503
    assert response.json() == {"detail": "User management service unavailable"}
    assert "synthetic" not in response.text


def test_openapi_adds_exactly_two_user_management_operations(application) -> None:
    """Expose list and role patch without additional user-management routes."""
    document = application.openapi()
    operations = {
        (method.upper(), path)
        for path, methods in document["paths"].items()
        if path.startswith(USERS_PATH)
        for method in methods
    }
    assert operations == {
        ("GET", USERS_PATH),
        ("PATCH", f"{USERS_PATH}/{{user_id}}/role"),
    }
