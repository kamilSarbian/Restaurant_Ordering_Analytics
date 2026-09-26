"""Transactional creation of durable public order aggregates."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.categories.models import Category
from app.menu.models import MenuItem
from app.orders.access import (
    generate_order_access_token,
    generate_public_order_number,
    hash_order_access_token,
)
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.origins import OrderDataOrigin
from app.orders.schemas import OrderCreateRequest, OrderCreateResponse, OrderType
from app.orders.statuses import OrderStatus
from app.restaurant_tables.models import RestaurantTable

KNOWN_CREATION_COLLISION_CONSTRAINTS = {
    "uq_orders_public_order_number",
    "uq_orders_order_access_token_hash",
}


class InvalidTableError(Exception):
    """Indicate that a dine-in table is missing or inactive."""


class MenuItemNotFoundError(Exception):
    """Indicate that a requested menu item is missing or inactive."""


class MenuItemUnavailableError(Exception):
    """Indicate that a requested menu item cannot currently be ordered."""


class MixedCurrencyError(Exception):
    """Indicate that one order contains more than one currency."""


class OrderCreationConflictError(Exception):
    """Indicate a known collision in generated public access data."""


@dataclass(frozen=True)
class _ItemSnapshot:
    menu_item_id: UUID
    category_name: str
    name: str
    quantity: int
    unit_price_amount: int
    unit_cost_amount: int | None
    line_total_amount: int


def _load_table(
    session: Session,
    request: OrderCreateRequest,
) -> tuple[UUID | None, int | None]:
    if request.order_type is OrderType.TAKEAWAY:
        return None, None
    if request.table_number is None:
        raise InvalidTableError

    row = (
        session.execute(
            select(
                RestaurantTable.id,
                RestaurantTable.number,
                RestaurantTable.is_active,
            )
            .where(RestaurantTable.number == request.table_number)
            .with_for_update(read=True, of=RestaurantTable)
        )
        .mappings()
        .one_or_none()
    )
    if row is None or row["is_active"] is not True:
        raise InvalidTableError
    return row["id"], row["number"]


def _load_menu_rows(
    session: Session,
    requested_ids: list[UUID],
) -> dict[UUID, RowMapping]:
    rows = (
        session.execute(
            select(
                MenuItem.id,
                MenuItem.name,
                MenuItem.price_amount,
                MenuItem.cost_amount,
                MenuItem.currency,
                MenuItem.is_active.label("menu_item_is_active"),
                MenuItem.is_available,
                Category.name.label("category_name"),
                Category.is_active.label("category_is_active"),
            )
            .join(Category, MenuItem.category_id == Category.id)
            .where(MenuItem.id.in_(requested_ids))
            .order_by(MenuItem.id.asc())
            .with_for_update(read=True, of=(MenuItem, Category))
        )
        .mappings()
        .all()
    )
    return {row["id"]: row for row in rows}


def _validate_and_snapshot_items(
    request: OrderCreateRequest,
    rows_by_id: dict[UUID, RowMapping],
) -> tuple[list[_ItemSnapshot], str]:
    snapshots: list[_ItemSnapshot] = []
    currencies: set[str] = set()
    for item in request.items:
        row = rows_by_id.get(item.menu_item_id)
        if (
            row is None
            or row["menu_item_is_active"] is not True
            or row["category_is_active"] is not True
        ):
            raise MenuItemNotFoundError
        if row["is_available"] is not True:
            raise MenuItemUnavailableError

        unit_price_amount = int(row["price_amount"])
        snapshots.append(
            _ItemSnapshot(
                menu_item_id=row["id"],
                category_name=str(row["category_name"]),
                name=str(row["name"]),
                quantity=item.quantity,
                unit_price_amount=unit_price_amount,
                unit_cost_amount=(
                    None if row["cost_amount"] is None else int(row["cost_amount"])
                ),
                line_total_amount=unit_price_amount * item.quantity,
            )
        )
        currencies.add(str(row["currency"]))

    if len(currencies) != 1:
        raise MixedCurrencyError
    return snapshots, currencies.pop()


def _is_known_creation_collision(error: IntegrityError) -> bool:
    diagnostic = getattr(error.orig, "diag", None)
    constraint_name = getattr(diagnostic, "constraint_name", None)
    return constraint_name in KNOWN_CREATION_COLLISION_CONSTRAINTS


def create_order(
    session: Session,
    request: OrderCreateRequest,
    *,
    customer_user_id: UUID | None = None,
    data_origin: OrderDataOrigin = OrderDataOrigin.LIVE,
) -> OrderCreateResponse:
    """Create and commit one server-authoritative order aggregate.

    Args:
        session: Fresh request-scoped session without an active transaction.
        request: Validated public order data containing identifiers and quantities.
        customer_user_id: Trusted current User identity, or None for a guest.
        data_origin: Trusted server-selected provenance for the new order.

    Returns:
        A detached public response containing the one-time raw guest token.

    Raises:
        InvalidTableError: If a dine-in table is missing or inactive.
        MenuItemNotFoundError: If an item or its category is missing or inactive.
        MenuItemUnavailableError: If a requested item is unavailable.
        MixedCurrencyError: If valid requested items use multiple currencies.
        OrderCreationConflictError: If generated public access data collides.
        IntegrityError: If any other database integrity constraint fails.
    """
    response_data: dict[str, Any] | None = None
    try:
        with session.begin():
            table_id, table_number_snapshot = _load_table(session, request)
            requested_ids = [item.menu_item_id for item in request.items]
            rows_by_id = _load_menu_rows(session, requested_ids)
            snapshots, currency = _validate_and_snapshot_items(request, rows_by_id)

            subtotal_amount = sum(item.line_total_amount for item in snapshots)
            public_order_number = generate_public_order_number()
            raw_access_token = generate_order_access_token()
            order = Order(
                public_order_number=public_order_number,
                order_access_token_hash=hash_order_access_token(raw_access_token),
                customer_user_id=customer_user_id,
                order_type=request.order_type.value,
                table_id=table_id,
                table_number_snapshot=table_number_snapshot,
                status=OrderStatus.CREATED.value,
                data_origin=data_origin.value,
                currency=currency,
                subtotal_amount=subtotal_amount,
                total_amount=subtotal_amount,
            )
            order_items = [
                OrderItem(
                    order=order,
                    menu_item_id=item.menu_item_id,
                    position=position,
                    category_name_snapshot=item.category_name,
                    name_snapshot=item.name,
                    quantity=item.quantity,
                    unit_price_amount=item.unit_price_amount,
                    unit_cost_amount=item.unit_cost_amount,
                    tax_rate_bps_snapshot=None,
                    discount_amount_snapshot=0,
                    line_total_amount=item.line_total_amount,
                )
                for position, item in enumerate(snapshots)
            ]
            initial_history = OrderStatusHistory(
                order=order,
                sequence=0,
                previous_status=None,
                new_status=OrderStatus.CREATED.value,
            )

            session.add(order)
            session.add_all([*order_items, initial_history])
            session.flush()

            response_data = {
                "public_order_number": public_order_number,
                "order_access_token": raw_access_token,
                "status": OrderStatus.CREATED,
                "order_type": request.order_type,
                "table_number": table_number_snapshot,
                "currency": currency,
                "items": [
                    {
                        "menu_item_id": item.menu_item_id,
                        "name": item.name,
                        "quantity": item.quantity,
                        "unit_price_amount": item.unit_price_amount,
                        "line_total_amount": item.line_total_amount,
                    }
                    for item in snapshots
                ],
                "subtotal_amount": subtotal_amount,
                "total_amount": subtotal_amount,
            }
    except IntegrityError as error:
        if _is_known_creation_collision(error):
            raise OrderCreationConflictError from error
        raise

    if response_data is None:
        raise RuntimeError("Order transaction completed without response data")
    return OrderCreateResponse.model_validate(response_data)
