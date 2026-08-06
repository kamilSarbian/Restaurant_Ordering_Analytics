"""Read-only query services for the public menu API."""

from collections import defaultdict
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.categories.models import Category
from app.menu.models import MenuItem
from app.menu.schemas import (
    PublicCategoryResponse,
    PublicMenuItemCategoryResponse,
    PublicMenuItemDetailResponse,
    PublicMenuItemResponse,
    PublicMenuResponse,
)


def get_public_menu(
    session: Session, *, available_only: bool = False
) -> PublicMenuResponse:
    """Return active menu categories containing visible items.

    Args:
        session: Open database session used for read-only queries.
        available_only: Whether temporarily unavailable items should be excluded.

    Returns:
        The public menu ordered by category and item display order.
    """
    category_rows = session.execute(
        select(
            Category.id,
            Category.name,
            Category.description,
            Category.display_order,
        )
        .where(Category.is_active.is_(True))
        .order_by(Category.display_order, Category.id)
    ).all()
    if not category_rows:
        return PublicMenuResponse(categories=[])

    category_ids = [row.id for row in category_rows]
    item_query = (
        select(
            MenuItem.id,
            MenuItem.category_id,
            MenuItem.name,
            MenuItem.description,
            MenuItem.image_url,
            MenuItem.price_amount,
            MenuItem.currency,
            MenuItem.allergens,
            MenuItem.display_order,
            MenuItem.is_available,
        )
        .where(
            MenuItem.is_active.is_(True),
            MenuItem.category_id.in_(category_ids),
        )
        .order_by(MenuItem.category_id, MenuItem.display_order, MenuItem.id)
    )
    if available_only:
        item_query = item_query.where(MenuItem.is_available.is_(True))

    items_by_category: dict[UUID, list[PublicMenuItemResponse]] = defaultdict(list)
    for row in session.execute(item_query):
        items_by_category[row.category_id].append(
            PublicMenuItemResponse(
                id=row.id,
                name=row.name,
                description=row.description,
                image_url=row.image_url,
                price_amount=row.price_amount,
                currency=row.currency,
                allergens=list(row.allergens),
                display_order=row.display_order,
                is_available=row.is_available,
            )
        )

    categories = [
        PublicCategoryResponse(
            id=row.id,
            name=row.name,
            description=row.description,
            display_order=row.display_order,
            items=items_by_category[row.id],
        )
        for row in category_rows
        if items_by_category[row.id]
    ]
    return PublicMenuResponse(categories=categories)


def get_public_menu_item(
    session: Session, item_id: UUID
) -> PublicMenuItemDetailResponse | None:
    """Return one visible menu item or ``None`` when it is not public.

    Args:
        session: Open database session used for the read-only query.
        item_id: Identifier of the requested menu item.

    Returns:
        The public detail response, or ``None`` when no visible item matches.
    """
    row = session.execute(
        select(
            MenuItem.id,
            MenuItem.name,
            MenuItem.description,
            MenuItem.image_url,
            MenuItem.price_amount,
            MenuItem.currency,
            MenuItem.allergens,
            MenuItem.display_order,
            MenuItem.is_available,
            Category.id.label("category_id"),
            Category.name.label("category_name"),
        )
        .join(Category, MenuItem.category_id == Category.id)
        .where(
            MenuItem.id == item_id,
            MenuItem.is_active.is_(True),
            Category.is_active.is_(True),
        )
    ).one_or_none()
    if row is None:
        return None

    return PublicMenuItemDetailResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        image_url=row.image_url,
        price_amount=row.price_amount,
        currency=row.currency,
        allergens=list(row.allergens),
        display_order=row.display_order,
        is_available=row.is_available,
        category=PublicMenuItemCategoryResponse(
            id=row.category_id,
            name=row.category_name,
        ),
    )
