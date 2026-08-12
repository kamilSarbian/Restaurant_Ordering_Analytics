"""Integration tests for administrator login and Bearer authorization."""

from __future__ import annotations

from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.auth import router as auth_router_module
from app.auth import service as auth_service
from app.auth import user_service as canonical_user_service
from app.auth.models import AdminUser
from app.auth.passwords import hash_password
from app.auth.roles import UserRole
from app.auth.service import (
    USER_AUDIENCE,
    USER_TOKEN_TYPE,
    AdminAuthenticationError,
    UserTokenService,
    authenticate_admin,
)
from app.auth.tokens import (
    ALGORITHM,
    AUDIENCE,
    ISSUER,
    TOKEN_TYPE,
    AdminTokenService,
)
from app.core.config import Settings
from app.core.rate_limit import FixedWindowRateLimiter
from app.database.session import create_session_factory
from app.main import create_app

pytestmark = pytest.mark.integration

LOGIN_PATH = "/api/v1/admin/auth/login"
ME_PATH = "/api/v1/admin/auth/me"
ADMIN_EMAIL = "admin@example.com"
SYNTHETIC_PASSWORD = "synthetic-admin-login-password"
WRONG_SYNTHETIC_PASSWORD = "wrong-synthetic-password"
SYNTHETIC_SECRET = "s" * 32
OTHER_SYNTHETIC_SECRET = "o" * 32
FIXED_NOW = datetime(2026, 8, 9, 12, tzinfo=UTC)
ISSUED_AT = int(FIXED_NOW.timestamp())
UNKNOWN_ADMIN_ID = UUID("2c1f7f68-19e0-45dc-a97e-7f0e6792e4e1")


class MutableClock:
    """Provide deterministic wall-clock or monotonic values without sleeping."""

    def __init__(self, value: datetime | float) -> None:
        self.value = value

    def __call__(self) -> datetime | float:
        return self.value

    def advance(self, amount: timedelta | float) -> None:
        """Advance the stored clock value by a matching duration."""
        self.value += amount


class CountingUserTokenService(UserTokenService):
    """Count canonical token creation while preserving real signing behavior."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self.create_calls = 0

    def create_access_token(self, admin_id: UUID) -> str:
        """Count and create one real synthetic access token."""
        self.create_calls += 1
        return super().create_access_token(admin_id)


@pytest.fixture(autouse=True)
def empty_admin_users(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep administrator authentication tests isolated from persisted identities."""
    with test_database_engine.begin() as connection:
        connection.execute(delete(AdminUser))
    try:
        yield
    finally:
        with test_database_engine.begin() as connection:
            connection.execute(delete(AdminUser))


@pytest.fixture
def admin_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create administrator sessions bound only to the isolated test database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def token_service() -> AdminTokenService:
    """Create a deterministic token service with a custom seven-minute TTL."""
    return AdminTokenService(
        SYNTHETIC_SECRET,
        access_token_expire_minutes=7,
        now_provider=lambda: FIXED_NOW,
    )


@pytest.fixture
def client(
    admin_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
) -> Generator[TestClient, None, None]:
    """Run the auth router against real PostgreSQL and synthetic token signing."""
    application = _application(admin_session_factory, token_service=token_service)
    with TestClient(application) as test_client:
        yield test_client


def _application(
    session_factory: sessionmaker[Session],
    *,
    token_service: AdminTokenService | None,
    limiter: FixedWindowRateLimiter | None = None,
    user_token_service: UserTokenService | None = None,
):
    resolved_user_token_service = user_token_service
    if resolved_user_token_service is None and token_service is not None:
        resolved_user_token_service = UserTokenService(
            SYNTHETIC_SECRET,
            access_token_expire_minutes=7,
            now_provider=lambda: FIXED_NOW,
        )
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=None,
        ),
        session_factory=session_factory,
        admin_token_service=token_service,
        admin_login_rate_limiter=limiter,
        user_token_service=resolved_user_token_service,
        user_login_rate_limiter=limiter,
    )


def _store_admin(
    session_factory: sessionmaker[Session],
    *,
    email: str = ADMIN_EMAIL,
    password: str = SYNTHETIC_PASSWORD,
    is_active: bool = True,
    role: UserRole = UserRole.SUPER_ADMIN,
) -> UUID:
    with session_factory.begin() as session:
        admin = AdminUser(
            email=email,
            password_hash=hash_password(password),
            role=role,
            is_active=is_active,
        )
        session.add(admin)
        session.flush()
        return admin.id


def _login_payload(
    *,
    email: str = ADMIN_EMAIL,
    password: str = SYNTHETIC_PASSWORD,
) -> dict[str, str]:
    return {"email": email, "password": password}


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _assert_login_failure(response) -> None:
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid credentials"}
    assert response.headers["WWW-Authenticate"] == "Bearer"


def _assert_protected_failure(response) -> None:
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid authentication credentials"}
    assert response.headers["WWW-Authenticate"] == "Bearer"


def _claims(**overrides: object) -> dict[str, object]:
    claims: dict[str, object] = {
        "sub": str(UNKNOWN_ADMIN_ID),
        "type": TOKEN_TYPE,
        "iat": ISSUED_AT,
        "exp": ISSUED_AT + 420,
        "iss": ISSUER,
        "aud": AUDIENCE,
    }
    claims.update(overrides)
    return claims


def _signed_token(
    claims: dict[str, object],
    *,
    secret: str = SYNTHETIC_SECRET,
) -> str:
    return jwt.encode(claims, secret, algorithm=ALGORITHM)


def test_successful_login_normalizes_email_returns_exact_token_contract_and_is_read_only(
    client: TestClient,
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Authenticate real Argon2 credentials and return the custom JWT lifetime."""
    admin_id = _store_admin(admin_session_factory)
    with admin_session_factory() as session:
        original_updated_at = session.scalar(
            select(AdminUser.updated_at).where(AdminUser.id == admin_id)
        )

    response = client.post(
        LOGIN_PATH,
        json=_login_payload(email="  Admin@EXAMPLE.COM  "),
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"access_token", "token_type", "expires_in"}
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 420
    token = body["access_token"]
    assert isinstance(token, str) and token
    unverified_claims = jwt.decode(token, options={"verify_signature": False})
    assert unverified_claims["sub"] == str(admin_id)
    assert unverified_claims["type"] == USER_TOKEN_TYPE
    assert unverified_claims["aud"] == USER_AUDIENCE
    assert {"email", "role", "password_hash"}.isdisjoint(unverified_claims)

    with admin_session_factory() as session:
        current_updated_at = session.scalar(
            select(AdminUser.updated_at).where(AdminUser.id == admin_id)
        )
    assert current_updated_at == original_updated_at


def test_legacy_login_uses_canonical_auth_config_and_shared_legacy_validator(
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Wire both strict token families from only canonical AUTH settings."""
    admin_id = _store_admin(admin_session_factory)
    application = create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            auth_jwt_secret=SYNTHETIC_SECRET,
            auth_access_token_expire_minutes=7,
        ),
        session_factory=admin_session_factory,
    )
    with TestClient(application) as client:
        login = client.post(LOGIN_PATH, json=_login_payload())
        assert login.status_code == 200
        body = login.json()
        assert set(body) == {"access_token", "token_type", "expires_in"}
        assert body["expires_in"] == 420
        claims = jwt.decode(body["access_token"], options={"verify_signature": False})
        assert claims["type"] == USER_TOKEN_TYPE
        assert claims["aud"] == USER_AUDIENCE
        assert "role" not in claims
        assert (
            application.state.user_token_service.decode_access_token(
                body["access_token"]
            ).user_id
            == admin_id
        )

        legacy_token = application.state.admin_token_service.create_access_token(
            admin_id
        )
        legacy_me = client.get(ME_PATH, headers=_authorization(legacy_token))
        assert legacy_me.status_code == 200
        assert legacy_me.json() == {"email": ADMIN_EMAIL, "is_active": True}


def test_authenticate_admin_uses_one_exact_email_select(
    admin_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    """Query normalized email once without LIKE, ILIKE, locking, or writes."""
    admin_id = _store_admin(admin_session_factory)
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
        with admin_session_factory() as session:
            principal = authenticate_admin(
                session,
                email=ADMIN_EMAIL,
                password=SYNTHETIC_PASSWORD,
            )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    assert principal.id == admin_id
    assert len(statements) == 1
    normalized_statement = " ".join(statements[0].lower().split())
    assert "users.email =" in normalized_statement
    assert " like " not in normalized_statement
    assert " ilike " not in normalized_statement
    assert " for update" not in normalized_statement


def test_unknown_wrong_and_inactive_credentials_have_one_public_failure(
    client: TestClient,
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Keep credential and activation failures indistinguishable over HTTP."""
    _store_admin(admin_session_factory)
    _store_admin(
        admin_session_factory,
        email="inactive@example.com",
        is_active=False,
    )
    responses = [
        client.post(LOGIN_PATH, json=_login_payload(email="unknown@example.com")),
        client.post(
            LOGIN_PATH,
            json=_login_payload(password=WRONG_SYNTHETIC_PASSWORD),
        ),
        client.post(
            LOGIN_PATH,
            json=_login_payload(email="inactive@example.com"),
        ),
        client.post(
            LOGIN_PATH,
            json=_login_payload(
                email="inactive@example.com",
                password=WRONG_SYNTHETIC_PASSWORD,
            ),
        ),
    ]
    for response in responses:
        _assert_login_failure(response)


def test_authentication_failure_paths_use_dummy_or_real_verification_structurally(
    admin_session_factory: sessionmaker[Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify enumeration-resistant control flow without timing assertions."""
    _store_admin(admin_session_factory)
    _store_admin(
        admin_session_factory,
        email="inactive@example.com",
        is_active=False,
    )
    calls: list[tuple[str, str]] = []

    def fake_dummy(password: str) -> None:
        calls.append(("dummy", password))

    def fake_verify(password: str, _password_hash: str) -> bool:
        calls.append(("real", password))
        return password == SYNTHETIC_PASSWORD

    monkeypatch.setattr(auth_service, "verify_dummy_password", fake_dummy)
    monkeypatch.setattr(auth_service, "verify_password", fake_verify)

    attempts = [
        ("unknown@example.com", "unknown-candidate"),
        (ADMIN_EMAIL, WRONG_SYNTHETIC_PASSWORD),
        ("inactive@example.com", SYNTHETIC_PASSWORD),
        ("inactive@example.com", WRONG_SYNTHETIC_PASSWORD),
    ]
    with admin_session_factory() as session:
        for email, password in attempts:
            with pytest.raises(AdminAuthenticationError):
                authenticate_admin(session, email=email, password=password)

    assert calls == [
        ("dummy", "unknown-candidate"),
        ("real", WRONG_SYNTHETIC_PASSWORD),
        ("real", SYNTHETIC_PASSWORD),
        ("real", WRONG_SYNTHETIC_PASSWORD),
    ]


def test_invalid_login_schemas_return_422_without_consuming_limiter_or_sql(
    admin_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
    test_database_engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject malformed bodies before endpoint, limiter, SQL, or verification."""
    limiter = FixedWindowRateLimiter(limit=1, window_seconds=60)
    application = _application(
        admin_session_factory,
        token_service=token_service,
        limiter=limiter,
    )
    verification_calls = 0
    statements: list[str] = []

    def fake_dummy(_password: str) -> None:
        nonlocal verification_calls
        verification_calls += 1

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    monkeypatch.setattr(canonical_user_service, "verify_dummy_password", fake_dummy)
    invalid_payloads = [
        _login_payload(email="invalid"),
        _login_payload(password=""),
        _login_payload(password="p" * 129),
        {**_login_payload(), "role": "admin"},
    ]
    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with TestClient(application) as test_client:
            for payload in invalid_payloads:
                assert test_client.post(LOGIN_PATH, json=payload).status_code == 422
            assert verification_calls == 0
            assert statements == []
            _assert_login_failure(
                test_client.post(
                    LOGIN_PATH,
                    json=_login_payload(email="unknown@example.com"),
                )
            )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    assert verification_calls == 1


def test_unavailable_service_precedes_limiter_sql_and_verification(
    admin_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Return 503 without consuming authentication or database resources."""
    limiter = FixedWindowRateLimiter(limit=1, window_seconds=60)
    application = _application(
        admin_session_factory,
        token_service=None,
        limiter=limiter,
    )
    auth_calls = 0
    statements: list[str] = []

    def fake_authenticate(*_args: object, **_kwargs: object):
        nonlocal auth_calls
        auth_calls += 1
        raise AssertionError("Credential authentication must not run")

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    monkeypatch.setattr(auth_router_module, "authenticate_user", fake_authenticate)
    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with TestClient(application) as test_client:
            login_response = test_client.post(LOGIN_PATH, json=_login_payload())
            me_response = test_client.get(ME_PATH)
            assert test_client.get("/health").status_code == 200
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    for response in (login_response, me_response):
        assert response.status_code == 503
        assert response.json() == {"detail": "Authentication service unavailable"}
    assert auth_calls == 0
    assert statements == []
    assert limiter.check("testclient").allowed is True


def test_sixth_login_attempt_is_denied_before_sql_verification_or_token_creation(
    admin_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop the sixth same-peer attempt before every expensive operation."""
    dummy_calls = 0
    real_verify_calls = 0
    statements: list[str] = []
    counting_service = CountingUserTokenService(
        SYNTHETIC_SECRET,
        now_provider=lambda: FIXED_NOW,
    )
    limiter = FixedWindowRateLimiter(limit=5, window_seconds=60, clock=lambda: 0.0)
    application = _application(
        admin_session_factory,
        token_service=AdminTokenService(
            SYNTHETIC_SECRET,
            now_provider=lambda: FIXED_NOW,
        ),
        limiter=limiter,
        user_token_service=counting_service,
    )

    def fake_dummy(_password: str) -> None:
        nonlocal dummy_calls
        dummy_calls += 1

    def fake_verify(_password: str, _password_hash: str) -> bool:
        nonlocal real_verify_calls
        real_verify_calls += 1
        return False

    def capture_statement(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    monkeypatch.setattr(canonical_user_service, "verify_dummy_password", fake_dummy)
    monkeypatch.setattr(canonical_user_service, "verify_password", fake_verify)
    event.listen(test_database_engine, "before_cursor_execute", capture_statement)
    try:
        with TestClient(application, client=("same-peer", 50000)) as test_client:
            for _ in range(5):
                _assert_login_failure(
                    test_client.post(
                        LOGIN_PATH,
                        json=_login_payload(email="unknown@example.com"),
                    )
                )
            assert len(statements) == 5
            assert dummy_calls == 5
            denied = test_client.post(
                LOGIN_PATH,
                json=_login_payload(email="unknown@example.com"),
            )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    assert denied.status_code == 429
    assert denied.json() == {"detail": "Too many sign-in attempts"}
    assert int(denied.headers["Retry-After"]) > 0
    assert len(statements) == 5
    assert dummy_calls == 5
    assert real_verify_calls == 0
    assert counting_service.create_calls == 0


def test_login_limiter_ignores_xff_and_keeps_direct_peers_independent(
    admin_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bucket by direct peer while ignoring forwarded identities."""
    limiter = FixedWindowRateLimiter(limit=5, window_seconds=60, clock=lambda: 0.0)
    application = _application(
        admin_session_factory,
        token_service=token_service,
        limiter=limiter,
    )
    monkeypatch.setattr(
        canonical_user_service,
        "verify_dummy_password",
        lambda _password: None,
    )

    with TestClient(application, client=("first-peer", 50000)) as first_client:
        for index in range(5):
            response = first_client.post(
                LOGIN_PATH,
                json=_login_payload(email="unknown@example.com"),
                headers={"X-Forwarded-For": f"203.0.113.{index + 1}"},
            )
            _assert_login_failure(response)
        denied = first_client.post(
            LOGIN_PATH,
            json=_login_payload(email="unknown@example.com"),
            headers={"X-Forwarded-For": "198.51.100.1"},
        )
        assert denied.status_code == 429

    with TestClient(application, client=("second-peer", 50001)) as second_client:
        _assert_login_failure(
            second_client.post(
                LOGIN_PATH,
                json=_login_payload(email="unknown@example.com"),
            )
        )


def test_login_limiter_window_resets_with_injected_clock(
    admin_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reach authentication again after the deterministic minute window."""
    clock = MutableClock(0.0)
    limiter = FixedWindowRateLimiter(
        limit=5,
        window_seconds=60,
        clock=clock,  # type: ignore[arg-type]
    )
    application = _application(
        admin_session_factory,
        token_service=token_service,
        limiter=limiter,
    )
    dummy_calls = 0

    def fake_dummy(_password: str) -> None:
        nonlocal dummy_calls
        dummy_calls += 1

    monkeypatch.setattr(canonical_user_service, "verify_dummy_password", fake_dummy)
    with TestClient(application) as test_client:
        for _ in range(5):
            _assert_login_failure(
                test_client.post(
                    LOGIN_PATH,
                    json=_login_payload(email="unknown@example.com"),
                )
            )
        assert test_client.post(LOGIN_PATH, json=_login_payload()).status_code == 429
        clock.advance(60.1)
        _assert_login_failure(
            test_client.post(
                LOGIN_PATH,
                json=_login_payload(email="unknown@example.com"),
            )
        )
    assert dummy_calls == 6


def test_me_returns_exact_active_principal_with_one_database_query(
    client: TestClient,
    admin_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
    test_database_engine: Engine,
) -> None:
    """Authorize once in the dependency and avoid a second router lookup."""
    admin_id = _store_admin(admin_session_factory)
    token = token_service.create_access_token(admin_id)
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
        response = client.get(ME_PATH, headers=_authorization(token))
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)

    assert response.status_code == 200
    assert response.json() == {"email": ADMIN_EMAIL, "is_active": True}
    assert len(statements) == 1
    assert statements[0].lstrip().upper().startswith("SELECT")


def test_me_rejects_missing_and_malformed_authorization_uniformly(
    client: TestClient,
) -> None:
    """Return one Bearer challenge for missing and unusable credentials."""
    responses = [
        client.get(ME_PATH),
        client.get(ME_PATH, headers={"Authorization": "Basic synthetic"}),
        client.get(ME_PATH, headers={"Authorization": "Bearer"}),
    ]
    for response in responses:
        _assert_protected_failure(response)


def test_me_rejects_invalid_token_matrix_without_public_distinctions(
    client: TestClient,
) -> None:
    """Map cryptographic, registered-claim, type, and subject failures to 401."""
    invalid_tokens = [
        "not-a-jwt",
        _signed_token(
            _claims(iat=ISSUED_AT - 420, exp=ISSUED_AT),
        ),
        _signed_token(_claims(), secret=OTHER_SYNTHETIC_SECRET),
        _signed_token(_claims(iss="wrong-issuer")),
        _signed_token(_claims(aud="wrong-audience")),
        _signed_token(_claims(type="wrong-type")),
        _signed_token(_claims(sub="not-a-uuid")),
        _signed_token(_claims(sub=str(UNKNOWN_ADMIN_ID).upper())),
    ]
    for token in invalid_tokens:
        _assert_protected_failure(client.get(ME_PATH, headers=_authorization(token)))


def test_clearly_invalid_token_executes_no_admin_query(
    client: TestClient,
    test_database_engine: Engine,
) -> None:
    """Reject malformed JWT input before opening the administrator DB path."""
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
        response = client.get(ME_PATH, headers=_authorization("not-a-jwt"))
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture_statement)
    _assert_protected_failure(response)
    assert statements == []


def test_me_rejects_valid_token_for_unknown_or_inactive_admin(
    client: TestClient,
    admin_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
) -> None:
    """Require a current active database identity for every valid token."""
    unknown_response = client.get(
        ME_PATH,
        headers=_authorization(token_service.create_access_token(UNKNOWN_ADMIN_ID)),
    )
    inactive_id = _store_admin(
        admin_session_factory,
        email="inactive@example.com",
        is_active=False,
    )
    inactive_response = client.get(
        ME_PATH,
        headers=_authorization(token_service.create_access_token(inactive_id)),
    )
    _assert_protected_failure(unknown_response)
    _assert_protected_failure(inactive_response)


def test_deactivation_immediately_invalidates_an_unexpired_login_token(
    client: TestClient,
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Prove that protected requests reload current activation state."""
    admin_id = _store_admin(admin_session_factory)
    login_response = client.post(LOGIN_PATH, json=_login_payload())
    assert login_response.status_code == 200
    token = login_response.json()["access_token"]
    assert client.get(ME_PATH, headers=_authorization(token)).status_code == 200

    with admin_session_factory.begin() as session:
        admin = session.get(AdminUser, admin_id)
        assert admin is not None
        admin.is_active = False

    _assert_protected_failure(client.get(ME_PATH, headers=_authorization(token)))


def test_admin_role_uses_legacy_login_alias_and_canonical_token_on_admin_routes(
    client: TestClient,
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Keep the legacy frontend contract while issuing unified user_access."""
    admin_id = _store_admin(admin_session_factory, role=UserRole.ADMIN)
    response = client.post(LOGIN_PATH, json=_login_payload())
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"access_token", "token_type", "expires_in"}
    claims = jwt.decode(body["access_token"], options={"verify_signature": False})
    assert claims["sub"] == str(admin_id)
    assert claims["type"] == USER_TOKEN_TYPE
    assert claims["aud"] == USER_AUDIENCE
    headers = _authorization(body["access_token"])
    assert client.get(ME_PATH, headers=headers).status_code == 200
    assert client.get("/api/v1/admin/orders", headers=headers).status_code == 200


def test_customer_credentials_on_legacy_login_match_invalid_credentials(
    client: TestClient,
    admin_session_factory: sessionmaker[Session],
) -> None:
    """Hide a valid customer's existence and insufficient administrator role."""
    _store_admin(admin_session_factory, role=UserRole.CUSTOMER)
    customer = client.post(LOGIN_PATH, json=_login_payload())
    invalid = client.post(
        LOGIN_PATH,
        json=_login_payload(password=WRONG_SYNTHETIC_PASSWORD),
    )
    _assert_login_failure(customer)
    _assert_login_failure(invalid)
    assert customer.json() == invalid.json()


def test_customer_canonical_and_demoted_legacy_tokens_receive_403(
    client: TestClient,
    admin_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
) -> None:
    """Use current database role for both canonical and legacy admin boundaries."""
    admin_id = _store_admin(admin_session_factory, role=UserRole.ADMIN)
    canonical = UserTokenService(
        SYNTHETIC_SECRET,
        access_token_expire_minutes=7,
        now_provider=lambda: FIXED_NOW,
    ).create_access_token(admin_id)
    legacy = token_service.create_access_token(admin_id)
    assert client.get(ME_PATH, headers=_authorization(canonical)).status_code == 200
    assert client.get(ME_PATH, headers=_authorization(legacy)).status_code == 200

    with admin_session_factory.begin() as session:
        admin = session.get(AdminUser, admin_id)
        assert admin is not None
        admin.role = UserRole.CUSTOMER

    for token in (canonical, legacy):
        response = client.get(ME_PATH, headers=_authorization(token))
        assert response.status_code == 403
        assert response.json() == {"detail": "Administrator access required"}


def test_openapi_documents_exact_admin_auth_contract_and_keeps_public_routes_open(
    client: TestClient,
) -> None:
    """Expose administrator operations without securing public routes globally."""
    document = client.get("/openapi.json").json()
    assert "/api/v1/stripe/webhook" not in document["paths"]
    assert "/api/v1/admin/auth/register" not in document["paths"]

    login = document["paths"][LOGIN_PATH]["post"]
    assert login["tags"] == ["admin-auth"]
    assert login["summary"] == "Sign in an administrator"
    assert "security" not in login
    assert login["requestBody"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/AdminLoginRequest")
    assert login["responses"]["200"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/AdminTokenResponse")

    me = document["paths"][ME_PATH]["get"]
    assert me["tags"] == ["admin-auth"]
    assert me["summary"] == "Get current administrator"
    assert me["security"] == [{"AdminBearer": []}]
    assert me["responses"]["200"]["content"]["application/json"]["schema"][
        "$ref"
    ].endswith("/AdminMeResponse")
    assert document["components"]["securitySchemes"]["AdminBearer"] == {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT",
    }

    admin_order_operations = [
        document["paths"]["/api/v1/admin/orders"]["get"],
        document["paths"]["/api/v1/admin/orders/{public_order_number}"]["get"],
        document["paths"]["/api/v1/admin/orders/{public_order_number}/status"]["patch"],
    ]
    assert [operation["summary"] for operation in admin_order_operations] == [
        "List administrator orders",
        "Get administrator order detail",
        "Update administrator order status",
    ]
    assert all(
        operation["tags"] == ["admin-orders"] for operation in admin_order_operations
    )
    assert all(
        operation["security"] == [{"AdminBearer": []}]
        for operation in admin_order_operations
    )

    admin_menu_operations = [
        document["paths"]["/api/v1/admin/menu/categories"]["get"],
        document["paths"]["/api/v1/admin/menu/categories"]["post"],
        document["paths"]["/api/v1/admin/menu/categories/{category_id}"]["patch"],
        document["paths"]["/api/v1/admin/menu/items"]["get"],
        document["paths"]["/api/v1/admin/menu/items"]["post"],
        document["paths"]["/api/v1/admin/menu/items/{item_id}"]["patch"],
    ]
    assert [operation["summary"] for operation in admin_menu_operations] == [
        "List administrator categories",
        "Create administrator category",
        "Update administrator category",
        "List administrator menu items",
        "Create administrator menu item",
        "Update administrator menu item",
    ]
    assert all(
        operation["tags"] == ["admin-menu"] for operation in admin_menu_operations
    )
    assert all(
        operation["security"] == [{"AdminBearer": []}]
        for operation in admin_menu_operations
    )

    analytics_operations = [
        document["paths"]["/api/v1/admin/analytics/overview"]["get"],
        document["paths"]["/api/v1/admin/analytics/products"]["get"],
        document["paths"]["/api/v1/admin/analytics/categories"]["get"],
        document["paths"]["/api/v1/admin/analytics/order-types"]["get"],
    ]
    assert [operation["summary"] for operation in analytics_operations] == [
        "Get administrator analytics overview",
        "Get administrator product analytics",
        "Get administrator category analytics",
        "Get administrator order-type analytics",
    ]
    assert all(
        operation["tags"] == ["admin-analytics"] for operation in analytics_operations
    )
    assert all(
        operation["security"] == [{"AdminBearer": []}]
        for operation in analytics_operations
    )
    response_schemas = [
        operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
        for operation in analytics_operations
    ]
    assert [schema.rsplit("/", 1)[-1] for schema in response_schemas] == [
        "AnalyticsOverviewResponse",
        "AnalyticsProductResponse",
        "AnalyticsCategoryResponse",
        "AnalyticsOrderTypeResponse",
    ]
    assert {
        path for path in document["paths"] if "/api/v1/admin/analytics" in path
    } == {
        "/api/v1/admin/analytics/overview",
        "/api/v1/admin/analytics/products",
        "/api/v1/admin/analytics/categories",
        "/api/v1/admin/analytics/order-types",
    }

    export_operations = [
        document["paths"]["/api/v1/admin/exports/orders.csv"]["get"],
        document["paths"]["/api/v1/admin/exports/product-sales.csv"]["get"],
        document["paths"]["/api/v1/admin/exports/payments.csv"]["get"],
    ]
    assert [operation["summary"] for operation in export_operations] == [
        "Export administrator orders as CSV",
        "Export administrator product sales as CSV",
        "Export administrator qualified payments as CSV",
    ]
    assert all(
        operation["tags"] == ["admin-exports"] for operation in export_operations
    )
    assert all(
        operation["security"] == [{"AdminBearer": []}]
        for operation in export_operations
    )
    assert all(
        set(operation["responses"]["200"]["content"]) == {"text/csv"}
        for operation in export_operations
    )
    assert all(
        "application/json" not in operation["responses"]["200"]["content"]
        for operation in export_operations
    )
    assert {path for path in document["paths"] if "/api/v1/admin/exports" in path} == {
        "/api/v1/admin/exports/orders.csv",
        "/api/v1/admin/exports/product-sales.csv",
        "/api/v1/admin/exports/payments.csv",
    }

    public_operations = [
        document["paths"]["/health"]["get"],
        document["paths"]["/api/v1/menu"]["get"],
        document["paths"]["/api/v1/orders/quote"]["post"],
        document["paths"]["/api/v1/orders"]["post"],
        document["paths"]["/api/v1/orders/{public_order_number}"]["get"],
        document["paths"]["/api/v1/orders/{public_order_number}/checkout-session"][
            "post"
        ],
    ]
    assert all("security" not in operation for operation in public_operations)
