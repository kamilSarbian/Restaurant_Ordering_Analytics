"""Authenticated administrator HTTP routes for operational order actions."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.auth.schemas import AdminPrincipal
from app.database.dependencies import get_db_session
from app.orders.admin_schemas import (
    AdminOrderDetail,
    AdminOrderListResponse,
    AdminOrderStatusUpdateRequest,
    AdminOrderStatusUpdateResponse,
)
from app.orders.admin_service import (
    AdminOrderActivePaymentError,
    AdminOrderCannotCancelError,
    AdminOrderInvalidTransitionError,
    AdminOrderNotFoundError,
    AdminOrderNotPaidError,
    get_admin_order,
    list_admin_orders,
    transition_order_status,
)
from app.orders.schemas import OrderType
from app.orders.statuses import OrderStatus

router = APIRouter(prefix="/api/v1/admin/orders", tags=["admin-orders"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]
CurrentAdmin = Annotated[AdminPrincipal, Depends(require_admin)]


@router.get(
    "",
    response_model=AdminOrderListResponse,
    summary="List administrator orders",
)
def list_admin_orders_endpoint(
    session: DatabaseSession,
    _admin: CurrentAdmin,
    status_filter: Annotated[OrderStatus | None, Query(alias="status")] = None,
    order_type: OrderType | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AdminOrderListResponse:
    """Return one authenticated administrator order page."""
    return list_admin_orders(
        session,
        status=status_filter,
        order_type=order_type,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/{public_order_number}",
    response_model=AdminOrderDetail,
    summary="Get administrator order detail",
    responses={
        404: {
            "description": "Order not found",
            "content": {"application/json": {"example": {"detail": "Order not found"}}},
        }
    },
)
def get_admin_order_endpoint(
    public_order_number: str,
    session: DatabaseSession,
    _admin: CurrentAdmin,
) -> AdminOrderDetail:
    """Return one authenticated administrator order detail."""
    try:
        return get_admin_order(
            session,
            public_order_number=public_order_number,
        )
    except AdminOrderNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order not found",
        ) from error


@router.patch(
    "/{public_order_number}/status",
    response_model=AdminOrderStatusUpdateResponse,
    summary="Update administrator order status",
    responses={
        401: {"description": "Invalid authentication credentials"},
        404: {"description": "Order not found"},
        409: {"description": "Order status transition conflict"},
        422: {"description": "Invalid request"},
        503: {"description": "Authentication service unavailable"},
    },
)
def update_admin_order_status_endpoint(
    public_order_number: str,
    payload: AdminOrderStatusUpdateRequest,
    session: DatabaseSession,
    _admin: CurrentAdmin,
) -> AdminOrderStatusUpdateResponse:
    """Apply one authenticated administrator order-status transition."""
    try:
        return transition_order_status(
            session,
            public_order_number=public_order_number,
            target_status=payload.status,
        )
    except AdminOrderNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order not found",
        ) from error
    except AdminOrderInvalidTransitionError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Invalid order status transition",
        ) from error
    except AdminOrderNotPaidError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Order is not paid",
        ) from error
    except AdminOrderActivePaymentError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Active payment attempt exists",
        ) from error
    except AdminOrderCannotCancelError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Order cannot be cancelled",
        ) from error
