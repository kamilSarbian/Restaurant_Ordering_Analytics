"""Guest order identifiers, access tokens, and public status retrieval."""

import hashlib
import hmac
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.orders.models import Order, OrderItem
from app.orders.schemas import (
    OrderCreateItemResponse,
    OrderStatusResponse,
    OrderType,
)
from app.orders.statuses import OrderStatus

PUBLIC_ORDER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
PUBLIC_ORDER_PREFIX = "ROA-"
PUBLIC_ORDER_SUFFIX_LENGTH = 12


class OrderNotFoundError(Exception):
    """Hide whether an order number or guest access token was invalid."""


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


def get_order_status(
    session: Session,
    public_order_number: str,
    access_token: str | None,
) -> OrderStatusResponse:
    """Retrieve an authenticated public order snapshot without mutation.

    Args:
        session: Open database session used for explicit read-only queries.
        public_order_number: Unvalidated path value presented by the guest.
        access_token: Optional raw token from the guest access header.

    Returns:
        A detached response containing only approved public snapshot fields.

    Raises:
        OrderNotFoundError: If the number or token cannot authenticate the order.
    """
    if access_token is None:
        raise OrderNotFoundError

    order_row = (
        session.execute(
            select(
                Order.id,
                Order.public_order_number,
                Order.order_access_token_hash,
                Order.status,
                Order.order_type,
                Order.table_number_snapshot,
                Order.currency,
                Order.subtotal_amount,
                Order.total_amount,
                Order.created_at,
                Order.updated_at,
            ).where(Order.public_order_number == public_order_number)
        )
        .mappings()
        .one_or_none()
    )

    if order_row is None or not verify_order_access_token(
        access_token,
        order_row["order_access_token_hash"],
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
