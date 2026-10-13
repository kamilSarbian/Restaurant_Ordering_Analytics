"""Authenticated administrator CSV export HTTP routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user, require_admin
from app.auth.models import User
from app.auth.schemas import AdminPrincipal
from app.database.dependencies import get_db_session
from app.orders.admin_service import AdminOrderReadDeniedError
from app.reports.schemas import AnalyticsCsvExportQuery, OrdersCsvExportQuery
from app.reports.service import (
    CsvExportResult,
    export_orders_csv,
    export_payments_csv,
    export_product_sales_csv,
)

router = APIRouter(prefix="/api/v1/admin/exports", tags=["admin-exports"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]
CurrentAdmin = Annotated[AdminPrincipal, Depends(require_admin)]
CurrentUser = Annotated[User, Depends(get_current_user)]
ADMIN_REPORTING_FORBIDDEN_DETAIL = "Administrator reporting access is not allowed"


@router.get(
    "/orders.csv",
    response_class=Response,
    summary="Export administrator orders as CSV",
    responses={
        200: {
            "description": "Orders CSV export",
            "content": {"text/csv": {}},
        },
        401: {"description": "Invalid authentication credentials"},
        403: {"description": ADMIN_REPORTING_FORBIDDEN_DETAIL},
        422: {"description": "Invalid request"},
        503: {"description": "Authentication service unavailable"},
    },
)
def export_orders_csv_endpoint(
    request: Request,
    query: Annotated[OrdersCsvExportQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
    current_user: CurrentUser,
) -> Response:
    """Return a buffered orders CSV to an authenticated administrator."""
    try:
        export = export_orders_csv(
            session,
            query,
            current_user=current_user,
            portfolio_demo_mode=getattr(
                request.app.state,
                "portfolio_demo_mode",
                None,
            ),
            payment_provider=getattr(request.app.state, "payment_provider", None),
        )
    except AdminOrderReadDeniedError as error:
        raise _admin_reporting_forbidden_error() from error
    return _csv_response(export)


@router.get(
    "/product-sales.csv",
    response_class=Response,
    summary="Export administrator product sales as CSV",
    responses={
        200: {
            "description": "Product-sales CSV export",
            "content": {"text/csv": {}},
        },
        401: {"description": "Invalid authentication credentials"},
        403: {"description": ADMIN_REPORTING_FORBIDDEN_DETAIL},
        422: {"description": "Invalid request"},
        503: {"description": "Authentication service unavailable"},
    },
)
def export_product_sales_csv_endpoint(
    request: Request,
    query: Annotated[AnalyticsCsvExportQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
    current_user: CurrentUser,
) -> Response:
    """Return a buffered product-sales CSV to an authenticated administrator."""
    try:
        export = export_product_sales_csv(
            session,
            query,
            current_user=current_user,
            portfolio_demo_mode=getattr(
                request.app.state,
                "portfolio_demo_mode",
                None,
            ),
            payment_provider=getattr(request.app.state, "payment_provider", None),
        )
    except AdminOrderReadDeniedError as error:
        raise _admin_reporting_forbidden_error() from error
    return _csv_response(export)


@router.get(
    "/payments.csv",
    response_class=Response,
    summary="Export administrator qualified payments as CSV",
    responses={
        200: {
            "description": "Qualified payments CSV export",
            "content": {"text/csv": {}},
        },
        401: {"description": "Invalid authentication credentials"},
        403: {"description": ADMIN_REPORTING_FORBIDDEN_DETAIL},
        422: {"description": "Invalid request"},
        503: {"description": "Authentication service unavailable"},
    },
)
def export_payments_csv_endpoint(
    request: Request,
    query: Annotated[AnalyticsCsvExportQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
    current_user: CurrentUser,
) -> Response:
    """Return a buffered qualified-payments CSV to an administrator."""
    try:
        export = export_payments_csv(
            session,
            query,
            current_user=current_user,
            portfolio_demo_mode=getattr(
                request.app.state,
                "portfolio_demo_mode",
                None,
            ),
            payment_provider=getattr(request.app.state, "payment_provider", None),
        )
    except AdminOrderReadDeniedError as error:
        raise _admin_reporting_forbidden_error() from error
    return _csv_response(export)


def _csv_response(export: CsvExportResult) -> Response:
    return Response(
        content=export.content,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{export.filename}"',
        },
    )


def _admin_reporting_forbidden_error() -> HTTPException:
    """Build the fixed non-disclosing administrator reporting denial."""
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=ADMIN_REPORTING_FORBIDDEN_DETAIL,
    )
