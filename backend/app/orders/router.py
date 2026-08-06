"""HTTP route for public, transient order quotes."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database.dependencies import get_db_session
from app.orders.quoting import (
    MenuItemNotFoundError,
    MenuItemUnavailableError,
    MixedCurrencyError,
    quote_order,
)
from app.orders.schemas import OrderQuoteRequest, OrderQuoteResponse

router = APIRouter(prefix="/api/v1/orders", tags=["orders"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]


@router.post(
    "/quote",
    response_model=OrderQuoteResponse,
    summary="Quote an order",
    description=(
        "Calculate a point-in-time, non-persistent quote from current menu data. "
        "The quote does not reserve prices or availability."
    ),
    response_description=("The current price snapshot for the requested menu items."),
    responses={
        404: {
            "description": "Menu item not found",
            "content": {
                "application/json": {"example": {"detail": "Menu item not found"}}
            },
        },
        409: {
            "description": "A menu item is unavailable or currencies are mixed",
            "content": {
                "application/json": {
                    "examples": {
                        "unavailable": {
                            "summary": "Menu item unavailable",
                            "value": {"detail": "Menu item is unavailable"},
                        },
                        "mixedCurrencies": {
                            "summary": "Mixed currencies",
                            "value": {"detail": "Mixed currencies are not supported"},
                        },
                    }
                }
            },
        },
    },
)
def quote_order_endpoint(
    request: OrderQuoteRequest,
    session: DatabaseSession,
) -> OrderQuoteResponse:
    """Return a server-authoritative quote without persisting it."""
    try:
        return quote_order(session, request)
    except MenuItemNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Menu item not found",
        ) from error
    except MenuItemUnavailableError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Menu item is unavailable",
        ) from error
    except MixedCurrencyError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Mixed currencies are not supported",
        ) from error
