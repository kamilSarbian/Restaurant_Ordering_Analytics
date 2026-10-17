"""Unit tests for guest order number and access-token security."""

import hashlib
import hmac
import re
from inspect import Parameter, signature
from typing import cast
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from app.auth.demo_admin import (
    DEMO_ADMIN_DISABLED_PASSWORD_HASH,
    DEMO_ADMIN_EMAIL,
    DEMO_ADMIN_ID,
)
from app.auth.models import User
from app.auth.roles import UserRole
from app.orders.access import (
    PUBLIC_ORDER_ALPHABET,
    CustomerOrderAccessDeniedError,
    can_access_order,
    generate_order_access_token,
    generate_public_order_number,
    hash_order_access_token,
    resolve_customer_order_access_policy,
    verify_order_access_token,
)
from app.orders.account_service import (
    AccountOrderAccessDeniedError,
    get_account_order,
    list_account_orders,
)
from app.orders.origins import OrderDataOrigin
from app.payments.providers import PaymentProvider

PUBLIC_NUMBER_PATTERN = re.compile(r"^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$")
OWNER_ID = UUID("00000000-0000-4000-8000-000000000001")
OTHER_USER_ID = UUID("00000000-0000-4000-8000-000000000002")
VALID_CAPABILITY = "synthetic-valid-capability"
WRONG_CAPABILITY = "synthetic-wrong-capability"


def _user(
    *,
    user_id: UUID | None = None,
    email: str | None = None,
    password_hash: str = "synthetic-password-hash",
    role: UserRole = UserRole.CUSTOMER,
    is_active: bool = True,
) -> User:
    return User(
        id=user_id or uuid4(),
        email=email or f"customer-{uuid4().hex}@example.com",
        password_hash=password_hash,
        role=role,
        is_active=is_active,
    )


def _demo_admin() -> User:
    return _user(
        user_id=DEMO_ADMIN_ID,
        email=DEMO_ADMIN_EMAIL,
        password_hash=DEMO_ADMIN_DISABLED_PASSWORD_HASH,
        role=UserRole.ADMIN,
    )


def test_public_number_generator_uses_exact_secrets_alphabet() -> None:
    """Delegate every suffix character to secrets.choice."""
    with patch(
        "app.orders.access.secrets.choice",
        side_effect=list("23456789ABCD"),
    ) as choice:
        value = generate_public_order_number()

    assert value == "ROA-23456789ABCD"
    assert choice.call_count == 12
    assert all(call.args == (PUBLIC_ORDER_ALPHABET,) for call in choice.call_args_list)


def test_generated_public_numbers_have_the_approved_format() -> None:
    """Generate multiple correctly shaped values without statistical claims."""
    for _ in range(50):
        value = generate_public_order_number()
        assert len(value) == 16
        assert PUBLIC_NUMBER_PATTERN.fullmatch(value)
        assert set(value.removeprefix("ROA-")) <= set(PUBLIC_ORDER_ALPHABET)


def test_public_number_alphabet_excludes_ambiguous_characters() -> None:
    """Exclude characters commonly confused in guest-facing identifiers."""
    assert set("01IO").isdisjoint(PUBLIC_ORDER_ALPHABET)


def test_access_token_generator_requests_exactly_32_bytes() -> None:
    """Use the approved token_urlsafe source-byte count."""
    with patch(
        "app.orders.access.secrets.token_urlsafe",
        return_value="generated-token",
    ) as token_urlsafe:
        token = generate_order_access_token()

    assert token
    token_urlsafe.assert_called_once_with(32)


def test_access_token_hash_matches_sha256_lowercase_hex() -> None:
    """Produce the exact stable SHA-256 lookup digest."""
    token = "known-private-token"
    expected = hashlib.sha256(token.encode("utf-8")).hexdigest()
    actual = hash_order_access_token(token)
    assert actual == expected
    assert len(actual) == 64
    assert actual == actual.lower()
    assert re.fullmatch(r"[0-9a-f]{64}", actual)


def test_access_token_verification_accepts_correct_and_rejects_wrong() -> None:
    """Authenticate only the token matching the stored digest."""
    expected_hash = hash_order_access_token("correct-token")
    assert verify_order_access_token("correct-token", expected_hash) is True
    assert verify_order_access_token("wrong-token", expected_hash) is False


def test_access_token_verification_uses_compare_digest() -> None:
    """Use constant-time digest comparison instead of equality."""
    expected_hash = hash_order_access_token("correct-token")
    with patch(
        "app.orders.access.hmac.compare_digest",
        wraps=hmac.compare_digest,
    ) as compare_digest:
        result = verify_order_access_token("correct-token", expected_hash)

    assert result is True
    compare_digest.assert_called_once_with(expected_hash, expected_hash)


@pytest.mark.parametrize(
    (
        "order_customer_user_id",
        "current_user_id",
        "access_token",
        "expected_allowed",
    ),
    [
        (OWNER_ID, OWNER_ID, None, True),
        (OWNER_ID, OWNER_ID, WRONG_CAPABILITY, True),
        (OWNER_ID, OWNER_ID, VALID_CAPABILITY, True),
        (OWNER_ID, OTHER_USER_ID, VALID_CAPABILITY, True),
        (OWNER_ID, OTHER_USER_ID, None, False),
        (OWNER_ID, OTHER_USER_ID, WRONG_CAPABILITY, False),
        (OWNER_ID, None, VALID_CAPABILITY, True),
        (OWNER_ID, None, None, False),
        (None, OTHER_USER_ID, VALID_CAPABILITY, True),
        (None, OTHER_USER_ID, None, False),
        (None, None, VALID_CAPABILITY, True),
        (None, None, WRONG_CAPABILITY, False),
    ],
    ids=[
        "owner-without-capability",
        "owner-with-wrong-capability",
        "owner-with-valid-capability",
        "non-owner-with-valid-capability",
        "non-owner-without-capability",
        "non-owner-with-wrong-capability",
        "anonymous-owned-with-valid-capability",
        "anonymous-owned-without-capability",
        "user-unowned-with-valid-capability",
        "user-unowned-without-capability",
        "anonymous-unowned-with-valid-capability",
        "anonymous-unowned-with-wrong-capability",
    ],
)
def test_owner_or_capability_decision_matrix(
    order_customer_user_id: UUID | None,
    current_user_id: UUID | None,
    access_token: str | None,
    expected_allowed: bool,
) -> None:
    """Authorize exactly a matching owner or a valid independent capability."""
    assert (
        can_access_order(
            order_customer_user_id=order_customer_user_id,
            current_user_id=current_user_id,
            access_token=access_token,
            expected_access_token_hash=hash_order_access_token(VALID_CAPABILITY),
        )
        is expected_allowed
    )


def test_access_decision_has_no_role_or_identity_profile_inputs() -> None:
    """Keep the pure public-access decision independent of roles and PII."""
    parameters = signature(can_access_order).parameters
    assert set(parameters) == {
        "order_customer_user_id",
        "current_user_id",
        "access_token",
        "expected_access_token_hash",
    }
    assert all(
        parameter.kind is Parameter.KEYWORD_ONLY for parameter in parameters.values()
    )


@pytest.mark.parametrize(
    "current_user", [None, _demo_admin()], ids=["guest", "demo-admin"]
)
def test_demo_customer_policy_is_unowned_capability_only(
    current_user: User | None,
) -> None:
    """Make anonymous and exact demo-admin Orders unowned and runtime-scoped."""
    policy = resolve_customer_order_access_policy(
        current_user=current_user,
        portfolio_demo_mode=True,
        payment_provider=PaymentProvider.DEMO.value,
    )

    assert policy.effective_owner_id is None
    assert policy.creation_origin is OrderDataOrigin.PORTFOLIO_RUNTIME
    assert policy.public_origin_scope is OrderDataOrigin.PORTFOLIO_RUNTIME
    assert policy.account_reads_allowed is False
    assert (
        can_access_order(
            order_customer_user_id=DEMO_ADMIN_ID,
            current_user_id=policy.effective_owner_id,
            access_token=None,
            expected_access_token_hash=hash_order_access_token(VALID_CAPABILITY),
        )
        is False
    )
    assert (
        can_access_order(
            order_customer_user_id=DEMO_ADMIN_ID,
            current_user_id=policy.effective_owner_id,
            access_token=VALID_CAPABILITY,
            expected_access_token_hash=hash_order_access_token(VALID_CAPABILITY),
        )
        is True
    )


def test_customer_policy_requires_all_trusted_inputs_explicitly() -> None:
    """Prevent permissive defaults at the shared customer access boundary."""
    parameters = signature(resolve_customer_order_access_policy).parameters
    assert set(parameters) == {
        "current_user",
        "portfolio_demo_mode",
        "payment_provider",
    }
    assert all(
        parameter.kind is Parameter.KEYWORD_ONLY
        and parameter.default is Parameter.empty
        for parameter in parameters.values()
    )


@pytest.mark.parametrize("role", list(UserRole))
def test_normal_customer_policy_preserves_non_reserved_ownership(
    role: UserRole,
) -> None:
    """Preserve personal ownership for every active non-reserved normal role."""
    current_user = _user(role=role)

    policy = resolve_customer_order_access_policy(
        current_user=current_user,
        portfolio_demo_mode=False,
        payment_provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert policy.effective_owner_id == current_user.id
    assert policy.creation_origin is OrderDataOrigin.LIVE
    assert policy.public_origin_scope is None
    assert policy.account_reads_allowed is True


def test_normal_guest_policy_preserves_unowned_live_orders() -> None:
    """Preserve anonymous unowned creation and capability access in normal mode."""
    policy = resolve_customer_order_access_policy(
        current_user=None,
        portfolio_demo_mode=False,
        payment_provider=PaymentProvider.STRIPE_TEST.value,
    )

    assert policy.effective_owner_id is None
    assert policy.creation_origin is OrderDataOrigin.LIVE
    assert policy.public_origin_scope is None
    assert policy.account_reads_allowed is False


@pytest.mark.parametrize(
    ("current_user", "portfolio_demo_mode", "payment_provider"),
    [
        (_user(), True, PaymentProvider.DEMO.value),
        (_user(user_id=DEMO_ADMIN_ID), True, PaymentProvider.DEMO.value),
        (_user(email=DEMO_ADMIN_EMAIL), True, PaymentProvider.DEMO.value),
        (_demo_admin(), False, PaymentProvider.STRIPE_TEST.value),
        (_user(user_id=DEMO_ADMIN_ID), False, PaymentProvider.STRIPE_TEST.value),
        (_user(email=DEMO_ADMIN_EMAIL), False, PaymentProvider.STRIPE_TEST.value),
        (_user(is_active=False), False, PaymentProvider.STRIPE_TEST.value),
        (None, True, PaymentProvider.STRIPE_TEST.value),
        (None, False, PaymentProvider.DEMO.value),
        (None, None, PaymentProvider.DEMO.value),
        (None, False, None),
    ],
    ids=[
        "ordinary-user-in-demo",
        "reserved-id-drift-in-demo",
        "reserved-email-drift-in-demo",
        "exact-demo-admin-in-normal",
        "reserved-id-in-normal",
        "reserved-email-in-normal",
        "inactive-user-in-normal",
        "demo-mode-with-stripe",
        "normal-mode-with-demo",
        "missing-mode",
        "missing-provider",
    ],
)
def test_customer_policy_fails_closed_for_actor_or_runtime_drift(
    current_user: User | None,
    portfolio_demo_mode: bool | None,
    payment_provider: str | None,
) -> None:
    """Reject every identity or trusted-runtime state outside the exact matrix."""
    with pytest.raises(CustomerOrderAccessDeniedError):
        resolve_customer_order_access_policy(
            current_user=current_user,
            portfolio_demo_mode=portfolio_demo_mode,
            payment_provider=payment_provider,
        )


@pytest.mark.parametrize("operation", ["list", "detail"])
def test_demo_account_policy_denies_before_domain_session_use(operation: str) -> None:
    """Reject both demo account reads before touching the Order session."""
    session = cast(Session, object())
    with pytest.raises(AccountOrderAccessDeniedError):
        if operation == "list":
            list_account_orders(
                session,
                current_user=_demo_admin(),
                portfolio_demo_mode=True,
                payment_provider=PaymentProvider.DEMO.value,
                limit=50,
                offset=0,
            )
        else:
            get_account_order(
                session,
                current_user=_demo_admin(),
                portfolio_demo_mode=True,
                payment_provider=PaymentProvider.DEMO.value,
                public_order_number="ROA-23456789ABCD",
            )
