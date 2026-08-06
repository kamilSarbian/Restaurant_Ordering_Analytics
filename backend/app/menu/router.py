"""HTTP routes for the public menu API."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database.dependencies import get_db_session
from app.menu.queries import get_public_menu, get_public_menu_item
from app.menu.schemas import PublicMenuItemDetailResponse, PublicMenuResponse

router = APIRouter(prefix="/api/v1/menu", tags=["menu"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]


@router.get(
    "",
    response_model=PublicMenuResponse,
    summary="Get the public menu",
    response_description="The active public menu grouped by category.",
)
def read_public_menu(
    session: DatabaseSession,
    available_only: Annotated[
        bool,
        Query(
            description=(
                "Exclude temporarily unavailable items when set to true. "
                "Inactive categories and items are always excluded."
            )
        ),
    ] = False,
) -> PublicMenuResponse:
    """Return the public menu with an optional availability filter."""
    return get_public_menu(session, available_only=available_only)


@router.get(
    "/items/{item_id}",
    response_model=PublicMenuItemDetailResponse,
    summary="Get a public menu item",
    response_description="The requested active public menu item.",
    responses={404: {"description": "Menu item not found"}},
)
def read_public_menu_item(
    item_id: UUID,
    session: DatabaseSession,
) -> PublicMenuItemDetailResponse:
    """Return one active item that belongs to an active category."""
    item = get_public_menu_item(session, item_id)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Menu item not found",
        )
    return item
