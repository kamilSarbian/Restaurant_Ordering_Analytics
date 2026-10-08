"""Authenticated administrator HTTP routes for menu management."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user, require_admin
from app.auth.models import User
from app.auth.schemas import AdminPrincipal
from app.database.dependencies import get_db_session
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
from app.menu.admin_service import (
    AdminCategoryConflictError,
    AdminCategoryNotFoundError,
    AdminMenuItemConflictError,
    AdminMenuItemNotFoundError,
    AdminMenuMutationDeniedError,
    create_admin_category,
    create_admin_menu_item,
    list_admin_categories,
    list_admin_menu_items,
    update_admin_category,
    update_admin_menu_item,
)

router = APIRouter(prefix="/api/v1/admin/menu", tags=["admin-menu"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]
CurrentAdmin = Annotated[AdminPrincipal, Depends(require_admin)]
CurrentUser = Annotated[User, Depends(get_current_user)]
PageLimit = Annotated[int, Query(ge=1, le=100)]
PageOffset = Annotated[int, Query(ge=0)]
MENU_MUTATION_FORBIDDEN_DETAIL = "Menu mutation is not allowed"

AUTH_RESPONSES = {
    401: {"description": "Invalid authentication credentials"},
    503: {"description": "Authentication service unavailable"},
}


@router.get(
    "/categories",
    response_model=AdminCategoryListResponse,
    summary="List administrator categories",
    responses=AUTH_RESPONSES,
)
def list_admin_categories_endpoint(
    session: DatabaseSession,
    _admin: CurrentAdmin,
    limit: PageLimit = 50,
    offset: PageOffset = 0,
) -> AdminCategoryListResponse:
    """Return one authenticated administrator category page."""
    return list_admin_categories(session, limit=limit, offset=offset)


@router.post(
    "/categories",
    response_model=AdminCategoryResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create administrator category",
    responses={
        **AUTH_RESPONSES,
        403: {"description": MENU_MUTATION_FORBIDDEN_DETAIL},
        409: {"description": "Category already exists"},
        422: {"description": "Invalid request"},
    },
)
def create_admin_category_endpoint(
    payload: AdminCategoryCreateRequest,
    request: Request,
    session: DatabaseSession,
    current_user: CurrentUser,
    _admin: CurrentAdmin,
) -> AdminCategoryResponse:
    """Create one authenticated administrator category."""
    try:
        return create_admin_category(
            session,
            request=payload,
            current_user=current_user,
            portfolio_demo_mode=getattr(request.app.state, "portfolio_demo_mode", None),
            payment_provider=getattr(request.app.state, "payment_provider", None),
        )
    except AdminMenuMutationDeniedError as error:
        raise _menu_mutation_forbidden_error() from error
    except AdminCategoryConflictError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Category already exists",
        ) from error


@router.patch(
    "/categories/{category_id}",
    response_model=AdminCategoryResponse,
    summary="Update administrator category",
    responses={
        **AUTH_RESPONSES,
        403: {"description": MENU_MUTATION_FORBIDDEN_DETAIL},
        404: {"description": "Category not found"},
        409: {"description": "Category already exists"},
        422: {"description": "Invalid request"},
    },
)
def update_admin_category_endpoint(
    category_id: UUID,
    payload: AdminCategoryUpdateRequest,
    request: Request,
    session: DatabaseSession,
    current_user: CurrentUser,
    _admin: CurrentAdmin,
) -> AdminCategoryResponse:
    """Update one authenticated administrator category."""
    try:
        return update_admin_category(
            session,
            category_id=category_id,
            request=payload,
            current_user=current_user,
            portfolio_demo_mode=getattr(request.app.state, "portfolio_demo_mode", None),
            payment_provider=getattr(request.app.state, "payment_provider", None),
        )
    except AdminMenuMutationDeniedError as error:
        raise _menu_mutation_forbidden_error() from error
    except AdminCategoryNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Category not found",
        ) from error
    except AdminCategoryConflictError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Category already exists",
        ) from error


@router.get(
    "/items",
    response_model=AdminMenuItemListResponse,
    summary="List administrator menu items",
    responses=AUTH_RESPONSES,
)
def list_admin_menu_items_endpoint(
    session: DatabaseSession,
    _admin: CurrentAdmin,
    limit: PageLimit = 50,
    offset: PageOffset = 0,
) -> AdminMenuItemListResponse:
    """Return one authenticated administrator menu-item page."""
    return list_admin_menu_items(session, limit=limit, offset=offset)


@router.post(
    "/items",
    response_model=AdminMenuItemResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create administrator menu item",
    responses={
        **AUTH_RESPONSES,
        403: {"description": MENU_MUTATION_FORBIDDEN_DETAIL},
        404: {"description": "Category not found"},
        409: {"description": "Menu item already exists"},
        422: {"description": "Invalid request"},
    },
)
def create_admin_menu_item_endpoint(
    payload: AdminMenuItemCreateRequest,
    request: Request,
    session: DatabaseSession,
    current_user: CurrentUser,
    _admin: CurrentAdmin,
) -> AdminMenuItemResponse:
    """Create one authenticated administrator menu item."""
    try:
        return create_admin_menu_item(
            session,
            request=payload,
            current_user=current_user,
            portfolio_demo_mode=getattr(request.app.state, "portfolio_demo_mode", None),
            payment_provider=getattr(request.app.state, "payment_provider", None),
        )
    except AdminMenuMutationDeniedError as error:
        raise _menu_mutation_forbidden_error() from error
    except AdminCategoryNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Category not found",
        ) from error
    except AdminMenuItemConflictError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Menu item already exists",
        ) from error


@router.patch(
    "/items/{item_id}",
    response_model=AdminMenuItemResponse,
    summary="Update administrator menu item",
    responses={
        **AUTH_RESPONSES,
        403: {"description": MENU_MUTATION_FORBIDDEN_DETAIL},
        404: {"description": "Menu item or category not found"},
        409: {"description": "Menu item already exists"},
        422: {"description": "Invalid request"},
    },
)
def update_admin_menu_item_endpoint(
    item_id: UUID,
    payload: AdminMenuItemUpdateRequest,
    request: Request,
    session: DatabaseSession,
    current_user: CurrentUser,
    _admin: CurrentAdmin,
) -> AdminMenuItemResponse:
    """Update one authenticated administrator menu item."""
    try:
        return update_admin_menu_item(
            session,
            item_id=item_id,
            request=payload,
            current_user=current_user,
            portfolio_demo_mode=getattr(request.app.state, "portfolio_demo_mode", None),
            payment_provider=getattr(request.app.state, "payment_provider", None),
        )
    except AdminMenuMutationDeniedError as error:
        raise _menu_mutation_forbidden_error() from error
    except AdminMenuItemNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Menu item not found",
        ) from error
    except AdminCategoryNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Category not found",
        ) from error
    except AdminMenuItemConflictError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Menu item already exists",
        ) from error


def _menu_mutation_forbidden_error() -> HTTPException:
    """Build the fixed non-disclosing menu-mutation denial response."""
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=MENU_MUTATION_FORBIDDEN_DETAIL,
    )
