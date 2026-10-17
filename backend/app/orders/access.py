"""Public order identifiers, access rules, and status retrieval."""

import hashlib
import hmac
import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from app.auth.demo_admin import DEMO_ADMIN_EMAIL, DEMO_ADMIN_ID, is_demo_admin_identity
from app.auth.models import User
from app.orders.models import Order, OrderItem
from app.orders.origins import OrderDataOrigin
from app.orders.schemas import (
    OrderCreateItemResponse,
    OrderStatusResponse,
    OrderType,
)
from app.orders.statuses import OrderStatus
from app.payments.providers import PaymentProvider

PUBLIC_ORDER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
PUBLIC_ORDER_PREFIX = "ROA-"
PUBLIC_ORDER_SUFFIX_LENGTH = 12


class OrderNotFoundError(Exception):
    """Hide whether an order number or guest access token was invalid."""


class CustomerOrderAccessDeniedError(Exception):
    """Reject an actor or trusted runtime outside the customer Order boundary."""


@dataclass(frozen=True)
class CustomerOrderAccessPolicy:
    """Carry trusted customer Order ownership and provenance decisions."""

    effective_owner_id: UUID | None
    creation_origin: OrderDataOrigin
    public_origin_scope: OrderDataOrigin | None
    account_reads_allowed: bool


def resolve_customer_order_access_policy(
    *,
    current_user: User | None,
    portfolio_demo_mode: bool | None,
    payment_provider: str | None,
) -> CustomerOrderAccessPolicy:
    """Resolve the customer Order boundary from trusted runtime and identity.

    Args:
        current_user: Canonical active User, or None when Authorization is absent.
        portfolio_demo_mode: Trusted application-scoped portfolio mode.
        payment_provider: Trusted application-scoped payment provider.

    Returns:
        The effective owner, creation origin, public origin scope, and account
        permission for the exact approved runtime.

    Raises:
        CustomerOrderAccessDeniedError: If runtime or identity is not approved.
    """
    has_reserved_demo_identity = current_user is not None and (
        current_user.id == DEMO_ADMIN_ID or current_user.email == DEMO_ADMIN_EMAIL
    )

    if portfolio_demo_mode is True and payment_provider == PaymentProvider.DEMO.value:
        if current_user is not None and not is_demo_admin_identity(current_user):
            raise CustomerOrderAccessDeniedError
        return CustomerOrderAccessPolicy(
            effective_owner_id=None,
            creation_origin=OrderDataOrigin.PORTFOLIO_RUNTIME,
            public_origin_scope=OrderDataOrigin.PORTFOLIO_RUNTIME,
            account_reads_allowed=False,
        )

    if (
        portfolio_demo_mode is False
        and payment_provider == PaymentProvider.STRIPE_TEST.value
    ):
        if current_user is None:
            return CustomerOrderAccessPolicy(
                effective_owner_id=None,
                creation_origin=OrderDataOrigin.LIVE,
                public_origin_scope=None,
                account_reads_allowed=False,
            )
        if current_user.is_active is True and not has_reserved_demo_identity:
            return CustomerOrderAccessPolicy(
                effective_owner_id=current_user.id,
                creation_origin=OrderDataOrigin.LIVE,
                public_origin_scope=None,
                account_reads_allowed=True,
            )

    raise CustomerOrderAccessDeniedError


def generate_public_order_number() -> str:
    """Generate one non-ambiguous public order number.

    Returns:
        A value using the fixed ROA prefix and twelve approved characters.
    """
    suffix = "".join(
        secrets.choice(PUBLIC_ORDER_ALPHABET) for _ in range(PUBLIC_ORDER_SUFFIX_LENGTH)
    )
    return f"{PUBLIC_ORDER_PREFIX}{suffix}"


def generate_order_access_token() -> str:
    """Generate a guest access token with at least 256 source bits.

    Returns:
        A URL-safe token intended to be returned exactly once.
    """
    return secrets.token_urlsafe(32)


def hash_order_access_token(token: str) -> str:
    """Hash a raw guest access token for durable storage.

    Args:
        token: Raw access token supplied at creation or status retrieval.

    Returns:
        A lowercase 64-character SHA-256 hexadecimal digest.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_order_access_token(token: str, expected_hash: str) -> bool:
    """Compare a raw token with its stored SHA-256 digest in constant time.

    Args:
        token: Raw token supplied by the guest.
        expected_hash: Stored lowercase SHA-256 hexadecimal digest.

    Returns:
        True when the token produces the expected digest.
    """
    actual_hash = hash_order_access_token(token)
    return hmac.compare_digest(actual_hash, expected_hash)


def can_access_order(
    *,
    order_customer_user_id: UUID | None,
    current_user_id: UUID | None,
    access_token: str | None,
    expected_access_token_hash: str,
) -> bool:
    """Authorize an order owner or a caller presenting its guest capability.

    Args:
        order_customer_user_id: Persisted trusted owner identifier, when any.
        current_user_id: Canonical current User identifier, when authenticated.
        access_token: Optional raw guest capability supplied by the caller.
        expected_access_token_hash: Persisted trusted guest capability hash.

    Returns:
        True when the caller owns the order or presents its valid capability.
    """
    is_owner = current_user_id is not None and order_customer_user_id == current_user_id
    has_valid_capability = access_token is not None and verify_order_access_token(
        access_token,
        expected_access_token_hash,
    )
    return is_owner or has_valid_capability


def build_order_status_response(
    *,
    order_row: RowMapping,
    item_rows: Sequence[RowMapping],
) -> OrderStatusResponse:
    """Build the shared customer-safe response from authorized snapshots.

    Args:
        order_row: Already-authorized projected Order values.
        item_rows: Ordered projected OrderItem values for that Order.

    Returns:
        The existing strict customer-safe order status response.

    Notes:
        The caller owns authorization and query scoping. This function performs
        no authentication, authorization, database access, or token validation.
    """
    items = [
        OrderCreateItemResponse(
            menu_item_id=item["menu_item_id"],
            name=item["name_snapshot"],
            quantity=item["quantity"],
            unit_price_amount=item["unit_price_amount"],
            line_total_amount=item["line_total_amount"],
        )
        for item in item_rows
    ]
    return OrderStatusResponse(
        public_order_number=order_row["public_order_number"],
        status=OrderStatus(order_row["status"]),
        order_type=OrderType(order_row["order_type"]),
        table_number=order_row["table_number_snapshot"],
        currency=order_row["currency"],
        items=items,
        subtotal_amount=order_row["subtotal_amount"],
        total_amount=order_row["total_amount"],
        created_at=order_row["created_at"],
        updated_at=order_row["updated_at"],
    )


def get_order_status(
    session: Session,
    public_order_number: str,
    access_token: str | None,
    *,
    current_user_id: UUID | None,
    required_data_origin: OrderDataOrigin | None,
) -> OrderStatusResponse:
    """Retrieve an authenticated public order snapshot without mutation.

    Args:
        session: Open database session used for explicit read-only queries.
        public_order_number: Unvalidated path value presented by the caller.
        access_token: Optional raw token from the guest capability header.
        current_user_id: Canonical current User identifier, when authenticated.
        required_data_origin: Optional trusted provenance scope for the first read.

    Returns:
        A detached response containing only approved public snapshot fields.

    Raises:
        OrderNotFoundError: If the number or token cannot authenticate the order.
    """
    predicates = [Order.public_order_number == public_order_number]
    if required_data_origin is not None:
        predicates.append(Order.data_origin == required_data_origin.value)

    order_row = (
        session.execute(
            select(
                Order.id,
                Order.public_order_number,
                Order.order_access_token_hash,
                Order.customer_user_id,
                Order.status,
                Order.order_type,
                Order.table_number_snapshot,
                Order.currency,
                Order.subtotal_amount,
                Order.total_amount,
                Order.created_at,
                Order.updated_at,
            ).where(*predicates)
        )
        .mappings()
        .one_or_none()
    )

    if order_row is None or not can_access_order(
        order_customer_user_id=order_row["customer_user_id"],
        current_user_id=current_user_id,
        access_token=access_token,
        expected_access_token_hash=order_row["order_access_token_hash"],
    ):
        raise OrderNotFoundError

    item_rows = (
        session.execute(
            select(
                OrderItem.menu_item_id,
                OrderItem.name_snapshot,
                OrderItem.quantity,
                OrderItem.unit_price_amount,
                OrderItem.line_total_amount,
            )
            .where(OrderItem.order_id == order_row["id"])
            .order_by(OrderItem.position.asc())
        )
        .mappings()
        .all()
    )

    return build_order_status_response(order_row=order_row, item_rows=item_rows)
