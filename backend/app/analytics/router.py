"""Authenticated administrator analytics HTTP routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.analytics.schemas import (
    AnalyticsBreakdownQuery,
    AnalyticsCategoryResponse,
    AnalyticsOrderTypeResponse,
    AnalyticsOverviewQuery,
    AnalyticsOverviewResponse,
    AnalyticsProductResponse,
)
from app.analytics.service import (
    get_analytics_overview,
    get_category_analytics,
    get_order_type_analytics,
    get_product_analytics,
)
from app.auth.dependencies import get_current_user, require_admin
from app.auth.models import User
from app.auth.schemas import AdminPrincipal
from app.database.dependencies import get_db_session
from app.orders.admin_service import AdminOrderReadDeniedError

router = APIRouter(prefix="/api/v1/admin/analytics", tags=["admin-analytics"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]
CurrentAdmin = Annotated[AdminPrincipal, Depends(require_admin)]
CurrentUser = Annotated[User, Depends(get_current_user)]
ADMIN_REPORTING_FORBIDDEN_DETAIL = "Administrator reporting access is not allowed"


@router.get(
    "/overview",
    response_model=AnalyticsOverviewResponse,
    summary="Get administrator analytics overview",
    responses={
        401: {"description": "Invalid authentication credentials"},
        403: {"description": ADMIN_REPORTING_FORBIDDEN_DETAIL},
        422: {"description": "Invalid request"},
        503: {"description": "Authentication service unavailable"},
    },
)
def get_analytics_overview_endpoint(
    request: Request,
    query: Annotated[AnalyticsOverviewQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
    current_user: CurrentUser,
) -> AnalyticsOverviewResponse:
    """Return payment overview KPIs to an authenticated administrator."""
    try:
        return get_analytics_overview(
            session,
            current_user=current_user,
            portfolio_demo_mode=getattr(
                request.app.state,
                "portfolio_demo_mode",
                None,
            ),
            payment_provider=getattr(request.app.state, "payment_provider", None),
            start=query.start,
            end=query.end,
            currency=query.currency,
        )
    except AdminOrderReadDeniedError as error:
        raise _admin_reporting_forbidden_error() from error


@router.get(
    "/products",
    response_model=AnalyticsProductResponse,
    summary="Get administrator product analytics",
    responses={403: {"description": ADMIN_REPORTING_FORBIDDEN_DETAIL}},
)
def get_product_analytics_endpoint(
    request: Request,
    query: Annotated[AnalyticsBreakdownQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
    current_user: CurrentUser,
) -> AnalyticsProductResponse:
    """Return historical product sales to an authenticated administrator."""
    try:
        return get_product_analytics(
            session,
            current_user=current_user,
            portfolio_demo_mode=getattr(
                request.app.state,
                "portfolio_demo_mode",
                None,
            ),
            payment_provider=getattr(request.app.state, "payment_provider", None),
            start=query.start,
            end=query.end,
            currency=query.currency,
            limit=query.limit,
        )
    except AdminOrderReadDeniedError as error:
        raise _admin_reporting_forbidden_error() from error


@router.get(
    "/categories",
    response_model=AnalyticsCategoryResponse,
    summary="Get administrator category analytics",
    responses={403: {"description": ADMIN_REPORTING_FORBIDDEN_DETAIL}},
)
def get_category_analytics_endpoint(
    request: Request,
    query: Annotated[AnalyticsBreakdownQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
    current_user: CurrentUser,
) -> AnalyticsCategoryResponse:
    """Return historical category sales to an authenticated administrator."""
    try:
        return get_category_analytics(
            session,
            current_user=current_user,
            portfolio_demo_mode=getattr(
                request.app.state,
                "portfolio_demo_mode",
                None,
            ),
            payment_provider=getattr(request.app.state, "payment_provider", None),
            start=query.start,
            end=query.end,
            currency=query.currency,
            limit=query.limit,
        )
    except AdminOrderReadDeniedError as error:
        raise _admin_reporting_forbidden_error() from error


@router.get(
    "/order-types",
    response_model=AnalyticsOrderTypeResponse,
    summary="Get administrator order-type analytics",
    responses={403: {"description": ADMIN_REPORTING_FORBIDDEN_DETAIL}},
)
def get_order_type_analytics_endpoint(
    request: Request,
    query: Annotated[AnalyticsOverviewQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
    current_user: CurrentUser,
) -> AnalyticsOrderTypeResponse:
    """Return paid order-type KPIs to an authenticated administrator."""
    try:
        return get_order_type_analytics(
            session,
            current_user=current_user,
            portfolio_demo_mode=getattr(
                request.app.state,
                "portfolio_demo_mode",
                None,
            ),
            payment_provider=getattr(request.app.state, "payment_provider", None),
            start=query.start,
            end=query.end,
            currency=query.currency,
        )
    except AdminOrderReadDeniedError as error:
        raise _admin_reporting_forbidden_error() from error


def _admin_reporting_forbidden_error() -> HTTPException:
    """Build the fixed non-disclosing administrator reporting denial."""
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=ADMIN_REPORTING_FORBIDDEN_DETAIL,
    )
