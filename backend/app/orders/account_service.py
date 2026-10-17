"""Read-only customer account services for personally owned Orders."""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.models import User
from app.orders.access import (
    CustomerOrderAccessDeniedError,
    build_order_status_response,
    resolve_customer_order_access_policy,
)
from app.orders.account_schemas import AccountOrderListItem, AccountOrderListResponse
from app.orders.models import Order, OrderItem
from app.orders.schemas import OrderStatusResponse, OrderType
from app.orders.statuses import OrderStatus


class AccountOrderNotFoundError(Exception):
    """Hide whether an account detail Order is unknown or not personally owned."""


class AccountOrderAccessDeniedError(Exception):
    """Reject account Order reads outside the exact normal customer boundary."""


def list_account_orders(
    session: Session,
    *,
    current_user: User,
    portfolio_demo_mode: bool | None,
    payment_provider: str | None,
    limit: int,
    offset: int,
) -> AccountOrderListResponse:
    """Return one owner-scoped and deterministically ordered account page.

    Args:
        session: Open request-scoped database session.
        current_user: Current canonical active User loaded by authentication.
        portfolio_demo_mode: Trusted application-scoped portfolio mode.
        payment_provider: Trusted application-scoped payment provider.
        limit: Maximum number of personally owned Orders in the page.
        offset: Number of personally owned Orders skipped before the page.

    Returns:
        A strict detached page whose total and items share the owner predicate.

    Raises:
        AccountOrderAccessDeniedError: If actor or runtime policy denies access.
    """
    current_user_id = _account_owner_id(
        current_user=current_user,
        portfolio_demo_mode=portfolio_demo_mode,
        payment_provider=payment_provider,
    )
    owner_filter = Order.customer_user_id == current_user_id
    total = session.scalar(select(func.count()).select_from(Order).where(owner_filter))
    order_rows = (
        session.execute(
            select(
                Order.public_order_number,
                Order.status,
                Order.order_type,
                Order.total_amount,
                Order.currency,
                Order.created_at,
                Order.updated_at,
            )
            .where(owner_filter)
            .order_by(Order.created_at.desc(), Order.id.desc())
            .limit(limit)
            .offset(offset)
        )
        .mappings()
        .all()
    )
    return AccountOrderListResponse(
        items=[
            AccountOrderListItem(
                public_order_number=row["public_order_number"],
                status=OrderStatus(row["status"]),
                order_type=OrderType(row["order_type"]),
                total_amount=row["total_amount"],
                currency=row["currency"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
            for row in order_rows
        ],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


def get_account_order(
    session: Session,
    *,
    current_user: User,
    portfolio_demo_mode: bool | None,
    payment_provider: str | None,
    public_order_number: str,
) -> OrderStatusResponse:
    """Return one owner-scoped customer-safe account Order detail.

    Args:
        session: Open request-scoped database session.
        current_user: Current canonical active User loaded by authentication.
        portfolio_demo_mode: Trusted application-scoped portfolio mode.
        payment_provider: Trusted application-scoped payment provider.
        public_order_number: Requested public identifier used in the SQL lookup.

    Returns:
        The shared strict customer-safe Order status response.

    Raises:
        AccountOrderAccessDeniedError: If actor or runtime policy denies access.
        AccountOrderNotFoundError: If the Order is unknown or not personally owned.
    """
    current_user_id = _account_owner_id(
        current_user=current_user,
        portfolio_demo_mode=portfolio_demo_mode,
        payment_provider=payment_provider,
    )
    order_row = (
        session.execute(
            select(
                Order.id,
                Order.public_order_number,
                Order.status,
                Order.order_type,
                Order.table_number_snapshot,
                Order.currency,
                Order.subtotal_amount,
                Order.total_amount,
                Order.created_at,
                Order.updated_at,
            ).where(
                Order.public_order_number == public_order_number,
                Order.customer_user_id == current_user_id,
            )
        )
        .mappings()
        .one_or_none()
    )
    if order_row is None:
        raise AccountOrderNotFoundError

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


def _account_owner_id(
    *,
    current_user: User,
    portfolio_demo_mode: bool | None,
    payment_provider: str | None,
) -> UUID:
    """Return the normal-runtime owner ID before any account-domain query."""
    try:
        policy = resolve_customer_order_access_policy(
            current_user=current_user,
            portfolio_demo_mode=portfolio_demo_mode,
            payment_provider=payment_provider,
        )
    except CustomerOrderAccessDeniedError:
        raise AccountOrderAccessDeniedError from None
    if not policy.account_reads_allowed or policy.effective_owner_id is None:
        raise AccountOrderAccessDeniedError
    return policy.effective_owner_id
