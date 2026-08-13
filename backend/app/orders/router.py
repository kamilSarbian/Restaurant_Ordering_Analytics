"""HTTP routes for public order quotes, creation, and status access."""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from app.auth.dependencies import UserBearerCredentials, get_optional_current_user
from app.core.rate_limit import get_client_bucket_key
from app.database.dependencies import get_db_session
from app.orders import creation, quoting
from app.orders.access import OrderNotFoundError, get_order_status
from app.orders.schemas import (
    OrderCreateRequest,
    OrderCreateResponse,
    OrderQuoteRequest,
    OrderQuoteResponse,
    OrderStatusResponse,
)

router = APIRouter(prefix="/api/v1/orders", tags=["orders"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]


@router.post(
    "",
    response_model=OrderCreateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an order",
    responses={
        401: {"description": "Invalid canonical authentication credentials"},
        404: {"description": "Menu item not found"},
        409: {
            "description": "Unavailable item, mixed currencies, or creation conflict"
        },
        422: {"description": "Invalid request or restaurant table"},
        429: {"description": "Order creation rate limit exceeded"},
        503: {"description": "Authentication service unavailable"},
    },
    openapi_extra={"security": [{}]},
)
def create_order_endpoint(
    payload: OrderCreateRequest,
    request: Request,
    response: Response,
    session: DatabaseSession,
    credentials: UserBearerCredentials,
) -> OrderCreateResponse:
    """Create one rate-limited guest or registered-user order."""
    limiter = request.app.state.order_creation_rate_limiter
    rate_limit = limiter.check(get_client_bucket_key(request))
    if not rate_limit.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many order creation requests",
            headers={"Retry-After": str(rate_limit.retry_after_seconds)},
        )

    current_user = get_optional_current_user(request, credentials)

    try:
        created_order = creation.create_order(
            session,
            payload,
            customer_user_id=(None if current_user is None else current_user.id),
        )
    except creation.InvalidTableError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid table",
        ) from error
    except creation.MenuItemNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Menu item not found",
        ) from error
    except creation.MenuItemUnavailableError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Menu item is unavailable",
        ) from error
    except creation.MixedCurrencyError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Mixed currencies are not supported",
        ) from error
    except creation.OrderCreationConflictError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Order creation conflict",
        ) from error

    response.headers["Location"] = f"/api/v1/orders/{created_order.public_order_number}"
    return created_order


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
        return quoting.quote_order(session, request)
    except quoting.MenuItemNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Menu item not found",
        ) from error
    except quoting.MenuItemUnavailableError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Menu item is unavailable",
        ) from error
    except quoting.MixedCurrencyError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Mixed currencies are not supported",
        ) from error


@router.get("/quote", include_in_schema=False)
def reject_quote_get() -> None:
    """Preserve the Stage 7 method contract before the dynamic status route."""
    raise HTTPException(
        status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
        detail="Method Not Allowed",
    )


@router.get(
    "/{public_order_number}",
    response_model=OrderStatusResponse,
    summary="Get public order status",
    description=(
        "Return a stored public order snapshot to its owner or a caller with the "
        "valid guest capability."
    ),
    responses={
        401: {"description": "Invalid canonical authentication credentials"},
        404: {
            "description": "Order not found",
            "content": {"application/json": {"example": {"detail": "Order not found"}}},
        },
        503: {"description": "Authentication service unavailable"},
    },
    openapi_extra={"security": [{}]},
)
def get_order_status_endpoint(
    public_order_number: str,
    request: Request,
    session: DatabaseSession,
    credentials: UserBearerCredentials,
    access_token: Annotated[
        str | None,
        Header(alias="X-Order-Access-Token"),
    ] = None,
) -> OrderStatusResponse:
    """Return an order snapshot to its owner or a capability holder."""
    current_user = get_optional_current_user(request, credentials)
    try:
        return get_order_status(
            session,
            public_order_number,
            access_token,
            current_user_id=(None if current_user is None else current_user.id),
        )
    except OrderNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order not found",
        ) from error
