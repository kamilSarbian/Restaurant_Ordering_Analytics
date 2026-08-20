"""Integration tests for canonical registration, login, and current User auth."""

from __future__ import annotations

from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User
from app.auth.passwords import hash_password, verify_password
from app.auth.roles import UserRole
from app.auth.service import (
    ALGORITHM,
    ISSUER,
    USER_AUDIENCE,
    USER_TOKEN_TYPE,
    UserTokenService,
)
from app.core.config import Settings
from app.core.rate_limit import FixedWindowRateLimiter
from app.database.session import create_session_factory
from app.main import create_app

pytestmark = pytest.mark.integration

REGISTER_PATH = "/api/v1/auth/register"
LOGIN_PATH = "/api/v1/auth/login"
ME_PATH = "/api/v1/auth/me"
LEGACY_LOGIN_PATH = "/api/v1/admin/auth/login"
LEGACY_ME_PATH = "/api/v1/admin/auth/me"
ADMIN_ORDERS_PATH = "/api/v1/admin/orders"
SYNTHETIC_SECRET = "u" * 32
SYNTHETIC_PASSWORD = "synthetic-user-password"
WRONG_PASSWORD = "wrong-synthetic-password"
FIXED_NOW = datetime(2026, 8, 12, 12, tzinfo=UTC)
ISSUED_AT = int(FIXED_NOW.timestamp())
LEGACY_ADMIN_AUDIENCE = "restaurant-ordering-analytics-admin"
LEGACY_ADMIN_TOKEN_TYPE = "admin_access"


@pytest.fixture(autouse=True)
def empty_users(test_database_engine: Engine) -> Generator[None, None, None]:
    """Keep canonical authentication tests isolated from persisted identities."""
    with test_database_engine.begin() as connection:
        connection.execute(delete(User))
    try:
        yield
    finally:
        with test_database_engine.begin() as connection:
            connection.execute(delete(User))


@pytest.fixture
def user_session_factory(test_database_engine: Engine) -> sessionmaker[Session]:
    """Create sessions bound only to the guarded integration database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def user_token_service() -> UserTokenService:
    """Create deterministic canonical signing with a seven-minute lifetime."""
    return UserTokenService(
        SYNTHETIC_SECRET,
        access_token_expire_minutes=7,
        now_provider=lambda: FIXED_NOW,
    )


@pytest.fixture
def client(
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> Generator[TestClient, None, None]:
    """Run canonical authentication against isolated PostgreSQL and synthetic JWTs."""
    application = _application(
        user_session_factory,
        user_token_service=user_token_service,
    )
    with TestClient(application) as test_client:
        yield test_client


def _application(
    factory: sessionmaker[Session],
    *,
    user_token_service: UserTokenService | None,
    register_limiter: FixedWindowRateLimiter | None = None,
    login_limiter: FixedWindowRateLimiter | None = None,
):
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
        ),
        session_factory=factory,
        user_token_service=user_token_service,
        user_register_rate_limiter=register_limiter,
        user_login_rate_limiter=login_limiter,
    )


def _store_user(
    factory: sessionmaker[Session],
    *,
    role: UserRole = UserRole.CUSTOMER,
    email: str = "user@example.com",
    password: str = SYNTHETIC_PASSWORD,
    is_active: bool = True,
) -> UUID:
    with factory.begin() as session:
        user = User(
            email=email,
            password_hash=hash_password(password),
            role=role,
            is_active=is_active,
        )
        session.add(user)
        session.flush()
        return user.id


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _signed_legacy_admin_token(user_id: UUID) -> str:
    claims = {
        "sub": str(user_id),
        "type": LEGACY_ADMIN_TOKEN_TYPE,
        "iat": ISSUED_AT,
        "exp": ISSUED_AT + 420,
        "iss": ISSUER,
        "aud": LEGACY_ADMIN_AUDIENCE,
    }
    return jwt.encode(claims, SYNTHETIC_SECRET, algorithm=ALGORITHM)


def _registration_payload(
    *,
    email: str = "new-user@example.com",
    password: str = SYNTHETIC_PASSWORD,
) -> dict[str, str]:
    return {"email": email, "password": password}


def test_registration_returns_token_and_creates_only_active_customer(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Create a customer, return the shared token shape, and authorize `/me`."""
    response = client.post(REGISTER_PATH, json=_registration_payload())
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"access_token", "token_type", "expires_in"}
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 420
    assert "password" not in body
    assert "password_hash" not in body
    assert "role" not in body

    claims = jwt.decode(body["access_token"], options={"verify_signature": False})
    assert set(claims) == {"sub", "type", "iat", "exp", "iss", "aud"}
    assert claims["type"] == USER_TOKEN_TYPE
    assert claims["aud"] == USER_AUDIENCE
    assert {"role", "email", "is_active", "password_hash"}.isdisjoint(claims)
    assert user_token_service.decode_access_token(body["access_token"]).user_id

    with user_session_factory() as session:
        user = session.scalar(select(User))
        assert user is not None
        assert user.email == "new-user@example.com"
        assert user.role is UserRole.CUSTOMER
        assert user.is_active is True
        assert verify_password(SYNTHETIC_PASSWORD, user.password_hash)

    me_response = client.get(ME_PATH, headers=_authorization(body["access_token"]))
    assert me_response.status_code == 200
    assert me_response.json()["role"] == "customer"


def test_canonical_auth_config_drives_register_login_and_me(
    user_session_factory: sessionmaker[Session],
) -> None:
    """Use only canonical AUTH settings for every canonical token operation."""
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SYNTHETIC_SECRET,
            auth_access_token_expire_minutes=7,
        ),
        session_factory=user_session_factory,
    )
    with TestClient(application) as client:
        registered = client.post(REGISTER_PATH, json=_registration_payload())
        assert registered.status_code == 201
        logged_in = client.post(
            LOGIN_PATH,
            json={
                "email": "new-user@example.com",
                "password": SYNTHETIC_PASSWORD,
            },
        )
        assert logged_in.status_code == 200
        for response in (registered, logged_in):
            body = response.json()
            assert body["expires_in"] == 420
            claims = jwt.decode(
                body["access_token"], options={"verify_signature": False}
            )
            assert claims["type"] == USER_TOKEN_TYPE
            assert claims["aud"] == USER_AUDIENCE
            assert "role" not in claims
            assert application.state.user_token_service.decode_access_token(
                body["access_token"]
            )
        me = client.get(
            ME_PATH,
            headers=_authorization(logged_in.json()["access_token"]),
        )
        assert me.status_code == 200
        assert me.json()["role"] == "customer"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("role", "admin"),
        ("is_active", True),
        ("id", "f47ac10b-58cc-4372-a567-0e02b2c3d479"),
        ("password_hash", "synthetic-hash"),
        ("unknown", "value"),
    ],
)
def test_registration_rejects_privilege_and_unknown_fields(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    field: str,
    value: object,
) -> None:
    """Reject every field beyond email and password instead of ignoring it."""
    payload: dict[str, object] = _registration_payload()
    payload[field] = value
    response = client.post(REGISTER_PATH, json=payload)
    assert response.status_code == 422
    with user_session_factory() as session:
        assert session.scalar(select(User)) is None


def test_duplicate_normalized_registration_returns_safe_conflict(
    client: TestClient,
) -> None:
    """Map the unique-email arbiter to one state-independent 409 response."""
    first = client.post(
        REGISTER_PATH,
        json=_registration_payload(email="Duplicate@Example.com"),
    )
    second = client.post(
        REGISTER_PATH,
        json=_registration_payload(email=" duplicate@example.com "),
    )
    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json() == {"detail": "Account already exists"}


@pytest.mark.parametrize(
    "payload",
    [
        {"email": "not-an-email", "password": SYNTHETIC_PASSWORD},
        {"email": "short@example.com", "password": "x" * 14},
        {"email": "long@example.com", "password": "x" * 129},
    ],
)
def test_registration_rejects_invalid_email_and_password_boundaries(
    client: TestClient,
    payload: dict[str, str],
) -> None:
    """Enforce validated email and the 15 through 128 code-point policy."""
    assert client.post(REGISTER_PATH, json=payload).status_code == 422


def test_registration_password_whitespace_is_not_trimmed(client: TestClient) -> None:
    """Hash and later verify the exact whitespace-only boundary value."""
    password = " " * 15
    assert (
        client.post(
            REGISTER_PATH,
            json=_registration_payload(password=password),
        ).status_code
        == 201
    )
    assert (
        client.post(
            LOGIN_PATH,
            json={"email": "new-user@example.com", "password": password},
        ).status_code
        == 200
    )
    wrong = client.post(
        LOGIN_PATH,
        json={"email": "new-user@example.com", "password": " "},
    )
    assert wrong.status_code == 401


@pytest.mark.parametrize("length", [15, 128])
def test_registration_counts_unicode_code_points(
    client: TestClient,
    length: int,
) -> None:
    """Accept Unicode passwords at both code-point boundaries."""
    response = client.post(
        REGISTER_PATH,
        json=_registration_payload(
            email=f"unicode-{length}@example.com",
            password="\N{LOCK}" * length,
        ),
    )
    assert response.status_code == 201


def test_register_limiter_is_dedicated_and_uses_retry_after(
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Limit registration independently without consuming canonical login."""
    application = _application(
        user_session_factory,
        user_token_service=user_token_service,
        register_limiter=FixedWindowRateLimiter(limit=1, window_seconds=60),
    )
    with TestClient(application) as client:
        first = client.post(REGISTER_PATH, json=_registration_payload())
        blocked = client.post(
            REGISTER_PATH,
            json=_registration_payload(email="second@example.com"),
        )
        login = client.post(
            LOGIN_PATH,
            json={"email": "new-user@example.com", "password": SYNTHETIC_PASSWORD},
        )
    assert first.status_code == 201
    assert blocked.status_code == 429
    assert int(blocked.headers["Retry-After"]) > 0
    assert login.status_code == 200


@pytest.mark.parametrize(
    "role",
    [UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN],
)
def test_canonical_login_accepts_every_active_registered_role(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    role: UserRole,
) -> None:
    """Authenticate all active roles through one role-neutral credential path."""
    user_id = _store_user(user_session_factory, role=role)
    response = client.post(
        LOGIN_PATH,
        json={"email": "user@example.com", "password": SYNTHETIC_PASSWORD},
    )
    assert response.status_code == 200
    assert set(response.json()) == {"access_token", "token_type", "expires_in"}
    claims = user_token_service.decode_access_token(response.json()["access_token"])
    assert claims.user_id == user_id


@pytest.mark.parametrize("failure", ["wrong-password", "missing", "inactive"])
def test_login_credential_failures_are_generic(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    failure: str,
) -> None:
    """Hide identity existence, role, active state, and password outcome."""
    email = "missing@example.com"
    password = WRONG_PASSWORD
    if failure == "wrong-password":
        _store_user(user_session_factory)
        email = "user@example.com"
    elif failure == "inactive":
        _store_user(user_session_factory, is_active=False)
        email = "user@example.com"
        password = SYNTHETIC_PASSWORD
    response = client.post(LOGIN_PATH, json={"email": email, "password": password})
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid credentials"}
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_missing_user_login_executes_dummy_verification(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Retain one dummy Argon2 verification for an unknown normalized email."""
    calls: list[str] = []

    def record_dummy(password: str) -> None:
        calls.append(password)

    monkeypatch.setattr("app.auth.user_service.verify_dummy_password", record_dummy)
    response = client.post(
        LOGIN_PATH,
        json={"email": "missing@example.com", "password": WRONG_PASSWORD},
    )
    assert response.status_code == 401
    assert calls == [WRONG_PASSWORD]


@pytest.mark.parametrize("password", ["", "x" * 129])
def test_login_rejects_password_outside_input_boundaries(
    client: TestClient,
    password: str,
) -> None:
    """Reject empty or oversized login input before authentication work."""
    response = client.post(
        LOGIN_PATH,
        json={"email": "user@example.com", "password": password},
    )
    assert response.status_code == 422


@pytest.mark.parametrize("field", ["role", "unknown"])
def test_login_rejects_fields_outside_email_and_password(
    client: TestClient,
    field: str,
) -> None:
    """Keep the canonical login request contract exact."""
    payload = {"email": "user@example.com", "password": SYNTHETIC_PASSWORD}
    payload[field] = "customer"
    assert client.post(LOGIN_PATH, json=payload).status_code == 422


def test_login_limiter_is_dedicated_and_uses_retry_after(
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Limit canonical login independently from the registration bucket."""
    _store_user(user_session_factory)
    application = _application(
        user_session_factory,
        user_token_service=user_token_service,
        login_limiter=FixedWindowRateLimiter(limit=1, window_seconds=60),
    )
    with TestClient(application) as client:
        first = client.post(
            LOGIN_PATH,
            json={"email": "user@example.com", "password": WRONG_PASSWORD},
        )
        blocked = client.post(
            LOGIN_PATH,
            json={"email": "user@example.com", "password": SYNTHETIC_PASSWORD},
        )
    assert first.status_code == 401
    assert blocked.status_code == 429
    assert int(blocked.headers["Retry-After"]) > 0


@pytest.mark.parametrize(
    "role",
    [UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN],
)
def test_me_returns_exact_current_database_fields_for_every_role(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    role: UserRole,
) -> None:
    """Expose only identity, current role, and active state from PostgreSQL."""
    user_id = _store_user(user_session_factory, role=role)
    token = user_token_service.create_access_token(user_id)
    response = client.get(ME_PATH, headers=_authorization(token))
    assert response.status_code == 200
    assert response.json() == {
        "id": str(user_id),
        "email": "user@example.com",
        "role": role.value,
        "is_active": True,
    }


@pytest.mark.parametrize("token", ["not-a-jwt", "a.b.c"])
def test_me_rejects_malformed_tokens(client: TestClient, token: str) -> None:
    """Return the same Bearer challenge for malformed canonical credentials."""
    response = client.get(ME_PATH, headers=_authorization(token))
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication credentials"}


def test_me_rejects_missing_bearer_credentials(client: TestClient) -> None:
    """Require the canonical UserBearer credential on `/me`."""
    response = client.get(ME_PATH)
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_me_rejects_expired_user_token(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
) -> None:
    """Reject a correctly signed canonical token at its expiration boundary."""
    user_id = _store_user(user_session_factory)
    expired_service = UserTokenService(
        SYNTHETIC_SECRET,
        access_token_expire_minutes=7,
        now_provider=lambda: FIXED_NOW - timedelta(minutes=7),
    )
    response = client.get(
        ME_PATH,
        headers=_authorization(expired_service.create_access_token(user_id)),
    )
    assert response.status_code == 401


def test_synthetic_admin_access_token_is_rejected_by_canonical_me(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
) -> None:
    """Keep the removed token family outside the canonical Bearer boundary."""
    user_id = _store_user(user_session_factory, role=UserRole.SUPER_ADMIN)
    token = _signed_legacy_admin_token(user_id)
    unverified = jwt.decode(token, options={"verify_signature": False})
    assert unverified["type"] == LEGACY_ADMIN_TOKEN_TYPE
    assert unverified["aud"] == LEGACY_ADMIN_AUDIENCE
    assert client.get(ME_PATH, headers=_authorization(token)).status_code == 401


def test_me_reflects_database_role_change_with_the_same_token(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Use current database role as authority instead of a JWT snapshot."""
    user_id = _store_user(user_session_factory)
    token = user_token_service.create_access_token(user_id)
    with user_session_factory.begin() as session:
        user = session.get(User, user_id)
        assert user is not None
        user.role = UserRole.ADMIN
    response = client.get(ME_PATH, headers=_authorization(token))
    assert response.status_code == 200
    assert response.json()["role"] == "admin"


def test_me_rejects_database_deactivation_with_the_same_token(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Apply deactivation immediately without token revocation state."""
    user_id = _store_user(user_session_factory)
    token = user_token_service.create_access_token(user_id)
    with user_session_factory.begin() as session:
        user = session.get(User, user_id)
        assert user is not None
        user.is_active = False
    response = client.get(ME_PATH, headers=_authorization(token))
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication credentials"}


def test_me_rejects_missing_user_after_token_issue(
    client: TestClient,
    user_token_service: UserTokenService,
) -> None:
    """Reject a valid token whose canonical database identity no longer exists."""
    token = user_token_service.create_access_token(uuid4())
    assert client.get(ME_PATH, headers=_authorization(token)).status_code == 401


@pytest.mark.parametrize("path", [REGISTER_PATH, LOGIN_PATH, ME_PATH])
def test_canonical_auth_returns_safe_503_without_token_service(
    user_session_factory: sessionmaker[Session],
    path: str,
) -> None:
    """Map missing canonical authentication configuration to one safe 503."""
    application = _application(user_session_factory, user_token_service=None)
    with TestClient(application) as client:
        if path == REGISTER_PATH:
            response = client.post(path, json=_registration_payload())
        elif path == LOGIN_PATH:
            response = client.post(path, json=_registration_payload())
        else:
            response = client.get(path, headers=_authorization("synthetic-token"))
    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}


@pytest.mark.parametrize("path", [REGISTER_PATH, LOGIN_PATH, ME_PATH])
def test_canonical_auth_maps_database_failures_to_safe_503(
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    test_database_engine: Engine,
    path: str,
) -> None:
    """Hide SQL and driver details for each canonical database boundary."""
    application = _application(
        user_session_factory,
        user_token_service=user_token_service,
    )

    def fail_statement(*_: object, **__: object) -> None:
        raise OperationalError("synthetic statement", {}, RuntimeError("synthetic"))

    event.listen(test_database_engine, "before_cursor_execute", fail_statement)
    try:
        with TestClient(application) as client:
            if path == REGISTER_PATH:
                response = client.post(path, json=_registration_payload())
            elif path == LOGIN_PATH:
                response = client.post(path, json=_registration_payload())
            else:
                token = user_token_service.create_access_token(uuid4())
                response = client.get(path, headers=_authorization(token))
    finally:
        event.remove(test_database_engine, "before_cursor_execute", fail_statement)
    assert response.status_code == 503
    assert response.json() == {"detail": "Authentication service unavailable"}
    assert "synthetic" not in response.text


@pytest.mark.parametrize(
    ("role", "expected_status"),
    [
        (UserRole.CUSTOMER, 403),
        (UserRole.ADMIN, 200),
        (UserRole.SUPER_ADMIN, 200),
    ],
)
def test_user_access_role_controls_operational_admin_api(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    role: UserRole,
    expected_status: int,
) -> None:
    """Apply current unified role policy to the unchanged admin route."""
    user_id = _store_user(user_session_factory, role=role)
    token = user_token_service.create_access_token(user_id)
    response = client.get(ADMIN_ORDERS_PATH, headers=_authorization(token))
    assert response.status_code == expected_status


def test_legacy_admin_login_and_me_are_removed_without_token_issuance(
    client: TestClient,
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Return exact 404s and issue no credential from removed auth routes."""
    user_id = _store_user(user_session_factory, role=UserRole.SUPER_ADMIN)
    login = client.post(
        LEGACY_LOGIN_PATH,
        json={"email": "user@example.com", "password": SYNTHETIC_PASSWORD},
    )
    assert login.status_code == 404
    assert login.json() == {"detail": "Not Found"}
    assert "access_token" not in login.text
    me = client.get(
        LEGACY_ME_PATH,
        headers=_authorization(user_token_service.create_access_token(user_id)),
    )
    assert me.status_code == 404
    assert me.json() == {"detail": "Not Found"}


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", LEGACY_LOGIN_PATH),
        ("get", LEGACY_ME_PATH),
    ],
)
def test_removed_legacy_auth_routes_do_not_consume_canonical_login_limit(
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
    method: str,
    path: str,
) -> None:
    """Keep removed paths outside the surviving canonical login limiter."""
    user_id = _store_user(user_session_factory)
    limiter = FixedWindowRateLimiter(limit=1, window_seconds=60, clock=lambda: 0.0)
    application = _application(
        user_session_factory,
        user_token_service=user_token_service,
        login_limiter=limiter,
    )
    payload = {"email": "user@example.com", "password": SYNTHETIC_PASSWORD}
    with TestClient(application, client=("shared-peer", 50000)) as client:
        if method == "post":
            removed = client.post(path, json=payload)
        else:
            removed = client.get(
                path,
                headers=_authorization(user_token_service.create_access_token(user_id)),
            )
        accepted = client.post(LOGIN_PATH, json=payload)
        blocked = client.post(LOGIN_PATH, json=payload)
        registration = client.post(
            REGISTER_PATH,
            json=_registration_payload(email="isolated-register@example.com"),
        )
    assert removed.status_code == 404
    assert removed.json() == {"detail": "Not Found"}
    assert accepted.status_code == 200
    assert blocked.status_code == 429
    assert int(blocked.headers["Retry-After"]) > 0
    assert registration.status_code == 201


def test_openapi_contains_only_three_canonical_auth_operations(
    user_session_factory: sessionmaker[Session],
    user_token_service: UserTokenService,
) -> None:
    """Expose only canonical auth routes and the single UserBearer scheme."""
    application = _application(
        user_session_factory,
        user_token_service=user_token_service,
    )
    document = application.openapi()
    canonical_operations = {
        (method.upper(), path)
        for path, operations in document["paths"].items()
        if path.startswith("/api/v1/auth/")
        for method in operations
    }
    assert canonical_operations == {
        ("POST", REGISTER_PATH),
        ("POST", LOGIN_PATH),
        ("GET", ME_PATH),
    }
    assert LEGACY_LOGIN_PATH not in document["paths"]
    assert LEGACY_ME_PATH not in document["paths"]
    assert document["components"]["securitySchemes"] == {
        "UserBearer": {
            "type": "http",
            "description": "Canonical registered-user access token",
            "scheme": "bearer",
            "bearerFormat": "JWT user_access",
        }
    }
    assert application.state.user_register_rate_limiter.limit == 5
    assert application.state.user_register_rate_limiter.window_seconds == 60
    assert application.state.user_login_rate_limiter.limit == 5
    assert application.state.user_login_rate_limiter.window_seconds == 60
    assert (
        application.state.user_register_rate_limiter
        is not application.state.user_login_rate_limiter
    )
    assert set(document["paths"]["/api/v1/admin/users"]) == {"get"}
    assert set(document["paths"]["/api/v1/admin/users/{user_id}/role"]) == {"patch"}
    assert document["paths"]["/api/v1/admin/users"]["get"]["security"] == [
        {"UserBearer": []}
    ]
    assert document["paths"]["/api/v1/admin/users/{user_id}/role"]["patch"][
        "security"
    ] == [{"UserBearer": []}]
