"""Guarded transactional reset for portfolio-runtime order aggregates."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth.demo_customer import DEMO_CUSTOMER_ID
from app.orders.creation import (
    MAX_PORTFOLIO_RUNTIME_ORDERS,
    PORTFOLIO_RUNTIME_ORDER_CAPACITY_LOCK_KEY,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.origins import OrderDataOrigin
from app.orders.statuses import OrderStatus, can_transition_order_status
from app.payments.demo_checkout import (
    MAX_DEMO_PAYMENTS_PER_ORDER,
    build_demo_provider_idempotency_key,
)
from app.payments.models import Payment, StripeEvent
from app.payments.providers import PaymentProvider
from app.payments.statuses import PaymentStatus

EXPECTED_RUNTIME_RESET_FOREIGN_KEYS = (
    ("order_items", "order_id", "orders", "id", "r"),
    ("order_status_history", "order_id", "orders", "id", "r"),
    ("payments", "order_id", "orders", "id", "r"),
    ("stripe_events", "payment_id", "payments", "id", "r"),
)


class PortfolioRuntimeResetConflictError(Exception):
    """Indicate that runtime data is not safe for an automatic scoped reset."""


class PortfolioRuntimeResetDatabaseError(Exception):
    """Indicate that the transactional reset could not complete safely."""


@dataclass(frozen=True, slots=True)
class PortfolioRuntimeResetResult:
    """Summarize rows deleted by one exact runtime-only reset."""

    orders_deleted: int
    order_items_deleted: int
    status_history_deleted: int
    payments_deleted: int

    @property
    def already_empty(self) -> bool:
        """Return whether the reset observed no runtime aggregate to delete."""
        return self.orders_deleted == 0


def reset_portfolio_runtime_data(session: Session) -> PortfolioRuntimeResetResult:
    """Delete only validated portfolio-runtime aggregates in one transaction.

    Args:
        session: Fresh operator-scoped session bound to the approved database.

    Returns:
        Exact child-first deletion counts, or all zeros for an empty rerun.

    Raises:
        PortfolioRuntimeResetConflictError: If runtime rows are unsafe or drifted.
        PortfolioRuntimeResetDatabaseError: If PostgreSQL work cannot complete.
    """
    result: PortfolioRuntimeResetResult | None = None
    database_failure = False
    try:
        with session.begin():
            session.execute(
                text("SELECT pg_advisory_xact_lock(:lock_key)"),
                {"lock_key": PORTFOLIO_RUNTIME_ORDER_CAPACITY_LOCK_KEY},
            )
            _require_expected_foreign_keys(session)
            orders = list(
                session.scalars(
                    select(Order)
                    .where(Order.data_origin == OrderDataOrigin.PORTFOLIO_RUNTIME.value)
                    .order_by(Order.id.asc())
                    .with_for_update()
                ).all()
            )
            if len(orders) > MAX_PORTFOLIO_RUNTIME_ORDERS:
                raise PortfolioRuntimeResetConflictError
            if not orders:
                result = PortfolioRuntimeResetResult(0, 0, 0, 0)
            else:
                result = _validate_delete_and_verify(session, orders)
    except PortfolioRuntimeResetConflictError:
        raise
    except SQLAlchemyError:
        database_failure = True

    if database_failure:
        raise PortfolioRuntimeResetDatabaseError
    if result is None:  # pragma: no cover - defensive invariant
        raise PortfolioRuntimeResetDatabaseError
    return result


def _require_expected_foreign_keys(session: Session) -> None:
    rows = session.execute(
        text(
            "SELECT child.relname, child_column.attname, parent.relname, "
            "parent_column.attname, fk.confdeltype "
            "FROM pg_catalog.pg_constraint AS fk "
            "JOIN pg_catalog.pg_class AS child ON child.oid = fk.conrelid "
            "JOIN pg_catalog.pg_namespace AS child_namespace "
            "ON child_namespace.oid = child.relnamespace "
            "JOIN pg_catalog.pg_class AS parent ON parent.oid = fk.confrelid "
            "JOIN pg_catalog.pg_namespace AS parent_namespace "
            "ON parent_namespace.oid = parent.relnamespace "
            "JOIN LATERAL unnest(fk.conkey, fk.confkey) "
            "WITH ORDINALITY AS keys(child_number, parent_number, position) ON TRUE "
            "JOIN pg_catalog.pg_attribute AS child_column "
            "ON child_column.attrelid = child.oid "
            "AND child_column.attnum = keys.child_number "
            "JOIN pg_catalog.pg_attribute AS parent_column "
            "ON parent_column.attrelid = parent.oid "
            "AND parent_column.attnum = keys.parent_number "
            "WHERE fk.contype = 'f' "
            "AND child_namespace.nspname = 'public' "
            "AND parent_namespace.nspname = 'public' "
            "AND parent.relname IN ('orders', 'payments') "
            "ORDER BY child.relname, child_column.attname, parent.relname, "
            "parent_column.attname"
        )
    ).all()
    if tuple(tuple(str(value) for value in row) for row in rows) != (
        EXPECTED_RUNTIME_RESET_FOREIGN_KEYS
    ):
        raise PortfolioRuntimeResetConflictError


def _validate_delete_and_verify(
    session: Session,
    orders: list[Order],
) -> PortfolioRuntimeResetResult:
    order_ids = tuple(order.id for order in orders)
    items = list(
        session.scalars(
            select(OrderItem)
            .where(OrderItem.order_id.in_(order_ids))
            .order_by(OrderItem.order_id.asc(), OrderItem.position.asc())
            .with_for_update()
        ).all()
    )
    history = list(
        session.scalars(
            select(OrderStatusHistory)
            .where(OrderStatusHistory.order_id.in_(order_ids))
            .order_by(
                OrderStatusHistory.order_id.asc(),
                OrderStatusHistory.sequence.asc(),
            )
            .with_for_update()
        ).all()
    )
    payments = list(
        session.scalars(
            select(Payment)
            .where(Payment.order_id.in_(order_ids))
            .order_by(
                Payment.order_id.asc(), Payment.created_at.asc(), Payment.id.asc()
            )
            .with_for_update()
        ).all()
    )
    payment_ids = tuple(payment.id for payment in payments)
    stripe_events = (
        []
        if not payment_ids
        else list(
            session.scalars(
                select(StripeEvent)
                .where(StripeEvent.payment_id.in_(payment_ids))
                .order_by(StripeEvent.id.asc())
                .with_for_update()
            ).all()
        )
    )

    if stripe_events:
        raise PortfolioRuntimeResetConflictError
    _require_consistent_runtime_aggregates(orders, items, history, payments)

    _delete_exact(
        session,
        Payment,
        Payment.order_id.in_(order_ids),
        len(payments),
    )
    _delete_exact(
        session,
        OrderStatusHistory,
        OrderStatusHistory.order_id.in_(order_ids),
        len(history),
    )
    _delete_exact(
        session,
        OrderItem,
        OrderItem.order_id.in_(order_ids),
        len(items),
    )
    _delete_exact(session, Order, Order.id.in_(order_ids), len(orders))
    _require_runtime_rows_absent(session, order_ids, payment_ids)
    return PortfolioRuntimeResetResult(
        orders_deleted=len(orders),
        order_items_deleted=len(items),
        status_history_deleted=len(history),
        payments_deleted=len(payments),
    )


def _require_consistent_runtime_aggregates(
    orders: list[Order],
    items: list[OrderItem],
    history: list[OrderStatusHistory],
    payments: list[Payment],
) -> None:
    items_by_order: dict[UUID, list[OrderItem]] = defaultdict(list)
    history_by_order: dict[UUID, list[OrderStatusHistory]] = defaultdict(list)
    payments_by_order: dict[UUID, list[Payment]] = defaultdict(list)
    for item in items:
        items_by_order[item.order_id].append(item)
    for entry in history:
        history_by_order[entry.order_id].append(entry)
    for payment in payments:
        payments_by_order[payment.order_id].append(payment)

    for order in orders:
        if (
            order.data_origin != OrderDataOrigin.PORTFOLIO_RUNTIME.value
            or order.customer_user_id not in {None, DEMO_CUSTOMER_ID}
        ):
            raise PortfolioRuntimeResetConflictError
        _require_consistent_items(order, items_by_order[order.id])
        _require_consistent_history(order, history_by_order[order.id])
        _require_consistent_payments(order, payments_by_order[order.id])


def _require_consistent_items(order: Order, items: list[OrderItem]) -> None:
    if not items or [item.position for item in items] != list(range(len(items))):
        raise PortfolioRuntimeResetConflictError
    if any(
        item.discount_amount_snapshot != 0
        or item.line_total_amount != item.unit_price_amount * item.quantity
        for item in items
    ):
        raise PortfolioRuntimeResetConflictError
    item_total = sum(item.line_total_amount for item in items)
    if (
        item_total != order.subtotal_amount
        or item_total != order.total_amount
        or order.subtotal_amount != order.total_amount
    ):
        raise PortfolioRuntimeResetConflictError


def _require_consistent_history(
    order: Order,
    history: list[OrderStatusHistory],
) -> None:
    if not history or [entry.sequence for entry in history] != list(
        range(len(history))
    ):
        raise PortfolioRuntimeResetConflictError
    first = history[0]
    if (
        first.previous_status is not None
        or first.new_status != OrderStatus.CREATED.value
    ):
        raise PortfolioRuntimeResetConflictError
    for previous, current in zip(history, history[1:], strict=False):
        if (
            current.previous_status != previous.new_status
            or not can_transition_order_status(
                previous.new_status,
                current.new_status,
            )
        ):
            raise PortfolioRuntimeResetConflictError
    if history[-1].new_status != order.status:
        raise PortfolioRuntimeResetConflictError


def _require_consistent_payments(order: Order, payments: list[Payment]) -> None:
    if len(payments) > MAX_DEMO_PAYMENTS_PER_ORDER:
        raise PortfolioRuntimeResetConflictError
    validated_statuses: set[PaymentStatus] = set()
    for payment in payments:
        try:
            status = PaymentStatus(payment.status)
        except ValueError:
            status = None
        if (
            status
            not in {
                PaymentStatus.SUCCEEDED,
                PaymentStatus.FAILED,
                PaymentStatus.EXPIRED,
            }
            or payment.provider != PaymentProvider.DEMO.value
            or payment.provider_idempotency_key
            != build_demo_provider_idempotency_key(payment.id)
            or payment.amount != order.total_amount
            or payment.currency != order.currency
            or payment.provider_session_id is not None
            or payment.provider_checkout_url is not None
            or payment.provider_checkout_expires_at is not None
            or (
                status is PaymentStatus.SUCCEEDED
                and not _is_aware(payment.succeeded_at)
            )
            or (
                status is not PaymentStatus.SUCCEEDED
                and payment.succeeded_at is not None
            )
        ):
            raise PortfolioRuntimeResetConflictError
        validated_statuses.add(status)

    has_succeeded_payment = PaymentStatus.SUCCEEDED in validated_statuses
    if (
        order.status
        in {
            OrderStatus.ACCEPTED.value,
            OrderStatus.PREPARING.value,
            OrderStatus.READY.value,
            OrderStatus.COMPLETED.value,
        }
        and not has_succeeded_payment
    ):
        raise PortfolioRuntimeResetConflictError
    if order.status == OrderStatus.CANCELLED.value and has_succeeded_payment:
        raise PortfolioRuntimeResetConflictError


def _delete_exact(
    session: Session,
    model: type[object],
    predicate: object,
    expected_count: int,
) -> None:
    if expected_count == 0:
        return
    deleted = session.execute(delete(model).where(predicate)).rowcount
    if deleted != expected_count:
        raise PortfolioRuntimeResetConflictError


def _require_runtime_rows_absent(
    session: Session,
    order_ids: tuple[UUID, ...],
    payment_ids: tuple[UUID, ...],
) -> None:
    remaining = (
        session.scalar(
            select(func.count(Order.id)).where(
                Order.data_origin == OrderDataOrigin.PORTFOLIO_RUNTIME.value
            )
        ),
        session.scalar(
            select(func.count(OrderItem.id)).where(OrderItem.order_id.in_(order_ids))
        ),
        session.scalar(
            select(func.count(OrderStatusHistory.id)).where(
                OrderStatusHistory.order_id.in_(order_ids)
            )
        ),
        session.scalar(
            select(func.count(Payment.id)).where(Payment.order_id.in_(order_ids))
        ),
        (
            0
            if not payment_ids
            else session.scalar(
                select(func.count(StripeEvent.id)).where(
                    StripeEvent.payment_id.in_(payment_ids)
                )
            )
        ),
    )
    if remaining != (0, 0, 0, 0, 0):
        raise PortfolioRuntimeResetConflictError


def _is_aware(value: datetime | None) -> bool:
    return (
        value is not None and value.tzinfo is not None and value.utcoffset() is not None
    )


__all__ = [
    "PortfolioRuntimeResetConflictError",
    "PortfolioRuntimeResetDatabaseError",
    "PortfolioRuntimeResetResult",
    "reset_portfolio_runtime_data",
]
