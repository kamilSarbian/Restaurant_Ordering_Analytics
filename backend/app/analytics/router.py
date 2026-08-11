"""Authenticated administrator analytics HTTP routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
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
from app.auth.dependencies import require_admin
from app.auth.schemas import AdminPrincipal
from app.database.dependencies import get_db_session

router = APIRouter(prefix="/api/v1/admin/analytics", tags=["admin-analytics"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]
CurrentAdmin = Annotated[AdminPrincipal, Depends(require_admin)]


@router.get(
    "/overview",
    response_model=AnalyticsOverviewResponse,
    summary="Get administrator analytics overview",
    responses={
        401: {"description": "Invalid authentication credentials"},
        422: {"description": "Invalid request"},
        503: {"description": "Authentication service unavailable"},
    },
)
def get_analytics_overview_endpoint(
    query: Annotated[AnalyticsOverviewQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
) -> AnalyticsOverviewResponse:
    """Return payment overview KPIs to an authenticated administrator."""
    return get_analytics_overview(
        session,
        start=query.start,
        end=query.end,
        currency=query.currency,
    )


@router.get(
    "/products",
    response_model=AnalyticsProductResponse,
    summary="Get administrator product analytics",
)
def get_product_analytics_endpoint(
    query: Annotated[AnalyticsBreakdownQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
) -> AnalyticsProductResponse:
    """Return historical product sales to an authenticated administrator."""
    return get_product_analytics(
        session,
        start=query.start,
        end=query.end,
        currency=query.currency,
        limit=query.limit,
    )


@router.get(
    "/categories",
    response_model=AnalyticsCategoryResponse,
    summary="Get administrator category analytics",
)
def get_category_analytics_endpoint(
    query: Annotated[AnalyticsBreakdownQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
) -> AnalyticsCategoryResponse:
    """Return historical category sales to an authenticated administrator."""
    return get_category_analytics(
        session,
        start=query.start,
        end=query.end,
        currency=query.currency,
        limit=query.limit,
    )


@router.get(
    "/order-types",
    response_model=AnalyticsOrderTypeResponse,
    summary="Get administrator order-type analytics",
)
def get_order_type_analytics_endpoint(
    query: Annotated[AnalyticsOverviewQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
) -> AnalyticsOrderTypeResponse:
    """Return paid order-type KPIs to an authenticated administrator."""
    return get_order_type_analytics(
        session,
        start=query.start,
        end=query.end,
        currency=query.currency,
    )
