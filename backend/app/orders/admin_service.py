"""Administrator read and transition services for the order aggregate."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.orders.admin_schemas import (
    AdminOrderDetail,
    AdminOrderItem,
    AdminOrderListItem,
    AdminOrderListResponse,
    AdminOrderStatusHistoryEntry,
    AdminOrderStatusUpdateResponse,
    AdminPaymentSummary,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.schemas import OrderType
from app.orders.statuses import (
    OrderStatus,
    can_cancel_order,
    can_transition_order_status,
)
from app.payments.models import Payment
from app.payments.policies import has_blocking_payment_status
from app.payments.statuses import PaymentStatus


class AdminOrderNotFoundError(Exception):
    """Indicate that an administrator order lookup found no matching order."""


class AdminOrderInvalidTransitionError(Exception):
    """Indicate that the fulfilment graph rejects a requested transition."""


class AdminOrderNotPaidError(Exception):
    """Indicate that acceptance lacks a succeeded payment attempt."""


class AdminOrderActivePaymentError(Exception):
    """Indicate that an active payment attempt blocks cancellation."""


class AdminOrderCannotCancelError(Exception):
    """Indicate that a succeeded payment attempt blocks cancellation."""


def list_admin_orders(
    session: Session,
    *,
    status: OrderStatus | None,
    order_type: OrderType | None,
    limit: int,
    offset: int,
) -> AdminOrderListResponse:
    """Return one filtered and deterministically ordered administrator page.

    Args:
        session: Open request-scoped database session.
        status: Optional fulfilment-status filter.
        order_type: Optional fulfilment-type filter.
        limit: Maximum number of orders in the page.
        offset: Number of matching orders skipped before the page.

    Returns:
        A detached strict response containing the page and total count.
    """
    filters = []
    if status is not None:
        filters.append(Order.status == status.value)
    if order_type is not None:
        filters.append(Order.order_type == order_type.value)

    total = session.scalar(select(func.count()).select_from(Order).where(*filters))
    orders = session.scalars(
        select(Order)
        .where(*filters)
        .order_by(Order.created_at.desc(), Order.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()

    return AdminOrderListResponse(
        items=[_build_list_item(order) for order in orders],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


def get_admin_order(
    session: Session,
    *,
    public_order_number: str,
) -> AdminOrderDetail:
    """Return a detached administrator order detail without guest authorization.

    Args:
        session: Open request-scoped database session.
        public_order_number: Stable public identifier used to locate the order.

    Returns:
        Strict administrator order detail assembled from durable snapshots.

    Raises:
        AdminOrderNotFoundError: If no order has the supplied public number.
    """
    order = session.scalar(
        select(Order).where(Order.public_order_number == public_order_number)
    )
    if order is None:
        raise AdminOrderNotFoundError

    items = session.scalars(
        select(OrderItem)
        .where(OrderItem.order_id == order.id)
        .order_by(OrderItem.position.asc())
    ).all()
    history = session.scalars(
        select(OrderStatusHistory)
        .where(OrderStatusHistory.order_id == order.id)
        .order_by(OrderStatusHistory.sequence.asc())
    ).all()
    payments = session.scalars(
        select(Payment)
        .where(Payment.order_id == order.id)
        .order_by(Payment.created_at.asc(), Payment.id.asc())
    ).all()

    return AdminOrderDetail(
        order_id=order.id,
        public_order_number=order.public_order_number,
        status=OrderStatus(order.status),
        order_type=OrderType(order.order_type),
        table_number=order.table_number_snapshot,
        currency=order.currency,
        subtotal_amount=order.subtotal_amount,
        total_amount=order.total_amount,
        created_at=order.created_at,
        updated_at=order.updated_at,
        items=[_build_order_item(item) for item in items],
        status_history=[_build_history_entry(entry) for entry in history],
        payments=[_build_payment_summary(payment) for payment in payments],
    )


def transition_order_status(
    session: Session,
    *,
    public_order_number: str,
    target_status: OrderStatus,
) -> AdminOrderStatusUpdateResponse:
    """Apply one authorized fulfilment transition in a short transaction.

    Args:
        session: Request-scoped session with no active transaction.
        public_order_number: Stable public identifier used to locate the order.
        target_status: Requested next status from the approved graph.

    Returns:
        Detached result containing the updated status and appended history row.

    Raises:
        AdminOrderNotFoundError: If the order does not exist.
        AdminOrderInvalidTransitionError: If the graph rejects the transition.
        AdminOrderNotPaidError: If acceptance lacks a succeeded payment.
        AdminOrderActivePaymentError: If a pending payment blocks cancellation.
        AdminOrderCannotCancelError: If a succeeded payment blocks cancellation.
    """
    response: AdminOrderStatusUpdateResponse | None = None
    with session.begin():
        order = session.scalar(
            select(Order)
            .where(Order.public_order_number == public_order_number)
            .with_for_update()
        )
        if order is None:
            raise AdminOrderNotFoundError

        current_status = OrderStatus(order.status)
        if not can_transition_order_status(current_status, target_status):
            raise AdminOrderInvalidTransitionError

        if target_status in {OrderStatus.ACCEPTED, OrderStatus.CANCELLED}:
            payments = _lock_order_payments(session, order.id)
            payment_statuses = [payment.status for payment in payments]
            if target_status is OrderStatus.ACCEPTED:
                if PaymentStatus.SUCCEEDED.value not in payment_statuses:
                    raise AdminOrderNotPaidError
            else:
                has_blocking_payment = has_blocking_payment_status(payment_statuses)
                if not can_cancel_order(
                    current_status,
                    has_blocking_payment=has_blocking_payment,
                ):
                    if PaymentStatus.SUCCEEDED.value in payment_statuses:
                        raise AdminOrderCannotCancelError
                    if PaymentStatus.PENDING.value in payment_statuses:
                        raise AdminOrderActivePaymentError
                    raise AdminOrderInvalidTransitionError

        latest_sequence = session.scalar(
            select(func.max(OrderStatusHistory.sequence)).where(
                OrderStatusHistory.order_id == order.id
            )
        )
        history = OrderStatusHistory(
            order_id=order.id,
            sequence=(latest_sequence if latest_sequence is not None else -1) + 1,
            previous_status=current_status.value,
            new_status=target_status.value,
        )
        order.status = target_status.value
        session.add(history)
        session.flush()
        response = AdminOrderStatusUpdateResponse(
            public_order_number=order.public_order_number,
            status=target_status,
            updated_at=order.updated_at,
            history=_build_history_entry(history),
        )

    if response is None:
        raise RuntimeError("Order status transition produced no response")
    return response


def _build_list_item(order: Order) -> AdminOrderListItem:
    return AdminOrderListItem(
        public_order_number=order.public_order_number,
        status=OrderStatus(order.status),
        order_type=OrderType(order.order_type),
        table_number=order.table_number_snapshot,
        total_amount=order.total_amount,
        currency=order.currency,
        created_at=order.created_at,
        updated_at=order.updated_at,
    )


def _build_order_item(item: OrderItem) -> AdminOrderItem:
    return AdminOrderItem(
        id=item.id,
        menu_item_id=item.menu_item_id,
        position=item.position,
        category_name=item.category_name_snapshot,
        name=item.name_snapshot,
        quantity=item.quantity,
        unit_price_amount=item.unit_price_amount,
        unit_cost_amount=item.unit_cost_amount,
        tax_rate_bps=item.tax_rate_bps_snapshot,
        discount_amount=item.discount_amount_snapshot,
        line_total_amount=item.line_total_amount,
    )


def _build_history_entry(
    entry: OrderStatusHistory,
) -> AdminOrderStatusHistoryEntry:
    return AdminOrderStatusHistoryEntry(
        sequence=entry.sequence,
        previous_status=(
            OrderStatus(entry.previous_status)
            if entry.previous_status is not None
            else None
        ),
        new_status=OrderStatus(entry.new_status),
        changed_at=entry.changed_at,
    )


def _build_payment_summary(payment: Payment) -> AdminPaymentSummary:
    return AdminPaymentSummary(
        id=payment.id,
        status=PaymentStatus(payment.status),
        amount=payment.amount,
        currency=payment.currency,
        created_at=payment.created_at,
        updated_at=payment.updated_at,
        checkout_expires_at=payment.provider_checkout_expires_at,
    )


def _lock_order_payments(session: Session, order_id: UUID) -> list[Payment]:
    return list(
        session.scalars(
            select(Payment)
            .where(Payment.order_id == order_id)
            .order_by(Payment.created_at.asc(), Payment.id.asc())
            .with_for_update()
        ).all()
    )
