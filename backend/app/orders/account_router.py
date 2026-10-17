"""Strict canonical account routes for personally owned Order reads."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.database.dependencies import get_db_session
from app.orders.account_schemas import AccountOrderListResponse
from app.orders.account_service import (
    AccountOrderAccessDeniedError,
    AccountOrderNotFoundError,
    get_account_order,
    list_account_orders,
)
from app.orders.schemas import OrderStatusResponse

router = APIRouter(prefix="/api/v1/account", tags=["account-orders"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get(
    "/orders",
    response_model=AccountOrderListResponse,
    summary="List personally owned orders",
    responses={
        401: {"description": "Invalid canonical authentication credentials"},
        403: {"description": "Account order access is not allowed"},
        422: {"description": "Invalid pagination parameters"},
        503: {"description": "Authentication or account order service unavailable"},
    },
)
def list_account_orders_endpoint(
    request: Request,
    current_user: CurrentUser,
    session: DatabaseSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AccountOrderListResponse:
    """Return one strict canonical User's personally owned Order page."""
    try:
        return list_account_orders(
            session,
            current_user=current_user,
            portfolio_demo_mode=getattr(request.app.state, "portfolio_demo_mode", None),
            payment_provider=getattr(request.app.state, "payment_provider", None),
            limit=limit,
            offset=offset,
        )
    except AccountOrderAccessDeniedError as error:
        raise _account_access_denied_error() from error
    except SQLAlchemyError as error:
        raise _account_service_unavailable_error() from error


@router.get(
    "/orders/{public_order_number}",
    response_model=OrderStatusResponse,
    summary="Get personally owned order detail",
    responses={
        401: {"description": "Invalid canonical authentication credentials"},
        403: {"description": "Account order access is not allowed"},
        404: {
            "description": "Order not found",
            "content": {"application/json": {"example": {"detail": "Order not found"}}},
        },
        503: {"description": "Authentication or account order service unavailable"},
    },
)
def get_account_order_endpoint(
    public_order_number: str,
    request: Request,
    current_user: CurrentUser,
    session: DatabaseSession,
) -> OrderStatusResponse:
    """Return one strict canonical User's personally owned Order snapshot."""
    try:
        return get_account_order(
            session,
            current_user=current_user,
            portfolio_demo_mode=getattr(request.app.state, "portfolio_demo_mode", None),
            payment_provider=getattr(request.app.state, "payment_provider", None),
            public_order_number=public_order_number,
        )
    except AccountOrderAccessDeniedError as error:
        raise _account_access_denied_error() from error
    except AccountOrderNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order not found",
        ) from error
    except SQLAlchemyError as error:
        raise _account_service_unavailable_error() from error


def _account_service_unavailable_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Account order service unavailable",
    )


def _account_access_denied_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Account order access is not allowed",
    )
