"""Server-authoritative, read-only order quote calculation."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from app.categories.models import Category
from app.menu.models import MenuItem
from app.orders.schemas import (
    OrderQuoteItemRequest,
    OrderQuoteLineResponse,
    OrderQuoteRequest,
    OrderQuoteResponse,
)


class MenuItemNotFoundError(Exception):
    """Indicate that a requested menu item is missing or non-public."""


class MenuItemUnavailableError(Exception):
    """Indicate that a requested public menu item is unavailable."""


class MixedCurrencyError(Exception):
    """Indicate that one quote contains menu items in multiple currencies."""


def quote_order(
    session: Session,
    request: OrderQuoteRequest,
) -> OrderQuoteResponse:
    """Calculate a transient quote from current server-owned menu data.

    Args:
        session: Open database session used for the single read-only query.
        request: Validated identifiers and quantities supplied by the client.

    Returns:
        A complete quote that preserves the request item order.

    Raises:
        MenuItemNotFoundError: If an item is missing or not public.
        MenuItemUnavailableError: If a public item is temporarily unavailable.
        MixedCurrencyError: If valid items use more than one currency.
    """
    requested_ids = [item.menu_item_id for item in request.items]
    rows = session.execute(
        select(
            MenuItem.id,
            MenuItem.name,
            MenuItem.price_amount,
            MenuItem.currency,
            MenuItem.is_active.label("menu_item_is_active"),
            MenuItem.is_available,
            Category.is_active.label("category_is_active"),
        )
        .join(Category, MenuItem.category_id == Category.id)
        .where(MenuItem.id.in_(requested_ids))
    ).mappings()
    rows_by_id: dict[UUID, RowMapping] = {row["id"]: row for row in rows}

    validated_rows: list[tuple[OrderQuoteItemRequest, RowMapping]] = []
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
        validated_rows.append((item, row))

    currencies = {str(row["currency"]) for _, row in validated_rows}
    if len(currencies) != 1:
        raise MixedCurrencyError

    response_items = [
        OrderQuoteLineResponse(
            menu_item_id=row["id"],
            name=row["name"],
            quantity=item.quantity,
            unit_price_amount=row["price_amount"],
            line_total_amount=row["price_amount"] * item.quantity,
        )
        for item, row in validated_rows
    ]
    subtotal_amount = sum(item.line_total_amount for item in response_items)
    return OrderQuoteResponse(
        currency=currencies.pop(),
        items=response_items,
        subtotal_amount=subtotal_amount,
        total_amount=subtotal_amount,
    )
