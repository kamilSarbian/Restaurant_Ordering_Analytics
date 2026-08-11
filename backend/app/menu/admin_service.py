"""Database services for authenticated administrator menu management."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.categories.models import Category
from app.menu.admin_schemas import (
    AdminCategoryCreateRequest,
    AdminCategoryListResponse,
    AdminCategoryResponse,
    AdminCategoryUpdateRequest,
    AdminMenuItemCreateRequest,
    AdminMenuItemListResponse,
    AdminMenuItemResponse,
    AdminMenuItemUpdateRequest,
)
from app.menu.models import MenuItem

CATEGORY_NAME_UNIQUE_INDEX = "ix_categories_name_normalized_unique"
MENU_ITEM_NAME_UNIQUE_INDEX = "ix_menu_items_category_name_normalized_unique"


class AdminCategoryNotFoundError(Exception):
    """Indicate that an administrator category lookup found no row."""


class AdminCategoryConflictError(Exception):
    """Indicate a normalized category-name uniqueness conflict."""


class AdminMenuItemNotFoundError(Exception):
    """Indicate that an administrator menu-item lookup found no row."""


class AdminMenuItemConflictError(Exception):
    """Indicate a category-scoped normalized item-name conflict."""


def list_admin_categories(
    session: Session,
    *,
    limit: int,
    offset: int,
) -> AdminCategoryListResponse:
    """Return all categories in one deterministic administrator page.

    Args:
        session: Open request-scoped database session.
        limit: Maximum number of categories returned.
        offset: Number of categories skipped before the page.

    Returns:
        Strict detached category page including inactive rows.
    """
    total = session.scalar(select(func.count()).select_from(Category))
    categories = session.scalars(
        select(Category)
        .order_by(Category.display_order.asc(), Category.id.asc())
        .limit(limit)
        .offset(offset)
    ).all()
    return AdminCategoryListResponse(
        items=[_build_category_response(category) for category in categories],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


def create_admin_category(
    session: Session,
    *,
    request: AdminCategoryCreateRequest,
) -> AdminCategoryResponse:
    """Create one category in a short transaction.

    Args:
        session: Request-scoped session with no active transaction.
        request: Validated writable category values.

    Returns:
        Strict detached representation of the created category.

    Raises:
        AdminCategoryConflictError: If the normalized name already exists.
    """
    response: AdminCategoryResponse | None = None
    try:
        with session.begin():
            category = Category(**request.model_dump())
            session.add(category)
            session.flush()
            response = _build_category_response(category)
    except IntegrityError as error:
        if _constraint_name(error) == CATEGORY_NAME_UNIQUE_INDEX:
            raise AdminCategoryConflictError from error
        raise
    if response is None:
        raise RuntimeError("Category creation produced no response")
    return response


def update_admin_category(
    session: Session,
    *,
    category_id: UUID,
    request: AdminCategoryUpdateRequest,
) -> AdminCategoryResponse:
    """Serialize and apply one partial category update.

    Args:
        session: Request-scoped session with no active transaction.
        category_id: Category identifier to update.
        request: Validated explicitly supplied fields.

    Returns:
        Strict detached representation of the updated category.

    Raises:
        AdminCategoryNotFoundError: If the category does not exist.
        AdminCategoryConflictError: If the normalized name already exists.
    """
    response: AdminCategoryResponse | None = None
    try:
        with session.begin():
            category = session.scalar(
                select(Category).where(Category.id == category_id).with_for_update()
            )
            if category is None:
                raise AdminCategoryNotFoundError
            for field, value in request.model_dump(exclude_unset=True).items():
                setattr(category, field, value)
            session.flush()
            response = _build_category_response(category)
    except IntegrityError as error:
        if _constraint_name(error) == CATEGORY_NAME_UNIQUE_INDEX:
            raise AdminCategoryConflictError from error
        raise
    if response is None:
        raise RuntimeError("Category update produced no response")
    return response


def list_admin_menu_items(
    session: Session,
    *,
    limit: int,
    offset: int,
) -> AdminMenuItemListResponse:
    """Return all menu items in one deterministic administrator page.

    Args:
        session: Open request-scoped database session.
        limit: Maximum number of items returned.
        offset: Number of items skipped before the page.

    Returns:
        Strict detached menu-item page including inactive and unavailable rows.
    """
    total = session.scalar(select(func.count()).select_from(MenuItem))
    items = session.scalars(
        select(MenuItem)
        .order_by(
            MenuItem.category_id.asc(),
            MenuItem.display_order.asc(),
            MenuItem.id.asc(),
        )
        .limit(limit)
        .offset(offset)
    ).all()
    return AdminMenuItemListResponse(
        items=[_build_menu_item_response(item) for item in items],
        total=int(total or 0),
        limit=limit,
        offset=offset,
    )


def create_admin_menu_item(
    session: Session,
    *,
    request: AdminMenuItemCreateRequest,
) -> AdminMenuItemResponse:
    """Create one menu item under an existing category.

    Args:
        session: Request-scoped session with no active transaction.
        request: Validated writable menu-item values.

    Returns:
        Strict detached representation of the created menu item.

    Raises:
        AdminCategoryNotFoundError: If the target category does not exist.
        AdminMenuItemConflictError: If the category already contains the name.
    """
    response: AdminMenuItemResponse | None = None
    try:
        with session.begin():
            if session.get(Category, request.category_id) is None:
                raise AdminCategoryNotFoundError
            item = MenuItem(**request.model_dump())
            session.add(item)
            session.flush()
            response = _build_menu_item_response(item)
    except IntegrityError as error:
        if _constraint_name(error) == MENU_ITEM_NAME_UNIQUE_INDEX:
            raise AdminMenuItemConflictError from error
        raise
    if response is None:
        raise RuntimeError("Menu-item creation produced no response")
    return response


def update_admin_menu_item(
    session: Session,
    *,
    item_id: UUID,
    request: AdminMenuItemUpdateRequest,
) -> AdminMenuItemResponse:
    """Serialize and apply one partial menu-item update.

    The item row is locked first. A changed target category is then read only to
    validate existence because category deletion is not an administrative action.

    Args:
        session: Request-scoped session with no active transaction.
        item_id: Menu-item identifier to update.
        request: Validated explicitly supplied fields.

    Returns:
        Strict detached representation of the updated menu item.

    Raises:
        AdminMenuItemNotFoundError: If the item does not exist.
        AdminCategoryNotFoundError: If a new target category does not exist.
        AdminMenuItemConflictError: If the category already contains the name.
    """
    response: AdminMenuItemResponse | None = None
    try:
        with session.begin():
            item = session.scalar(
                select(MenuItem).where(MenuItem.id == item_id).with_for_update()
            )
            if item is None:
                raise AdminMenuItemNotFoundError
            values = request.model_dump(exclude_unset=True)
            target_category_id = values.get("category_id")
            if (
                target_category_id is not None
                and target_category_id != item.category_id
                and session.get(Category, target_category_id) is None
            ):
                raise AdminCategoryNotFoundError
            for field, value in values.items():
                setattr(item, field, value)
            session.flush()
            response = _build_menu_item_response(item)
    except IntegrityError as error:
        if _constraint_name(error) == MENU_ITEM_NAME_UNIQUE_INDEX:
            raise AdminMenuItemConflictError from error
        raise
    if response is None:
        raise RuntimeError("Menu-item update produced no response")
    return response


def _build_category_response(category: Category) -> AdminCategoryResponse:
    return AdminCategoryResponse(
        id=category.id,
        name=category.name,
        description=category.description,
        display_order=category.display_order,
        is_active=category.is_active,
        created_at=category.created_at,
        updated_at=category.updated_at,
    )


def _build_menu_item_response(item: MenuItem) -> AdminMenuItemResponse:
    return AdminMenuItemResponse(
        id=item.id,
        category_id=item.category_id,
        name=item.name,
        description=item.description,
        image_url=item.image_url,
        price_amount=item.price_amount,
        cost_amount=item.cost_amount,
        currency=item.currency,
        allergens=list(item.allergens),
        display_order=item.display_order,
        is_active=item.is_active,
        is_available=item.is_available,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


def _constraint_name(error: IntegrityError) -> str | None:
    diagnostic = getattr(error.orig, "diag", None)
    value = getattr(diagnostic, "constraint_name", None)
    return str(value) if value is not None else None
