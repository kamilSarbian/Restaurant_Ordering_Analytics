"""Authenticated administrator CSV export HTTP routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.auth.dependencies import require_admin
from app.auth.schemas import AdminPrincipal
from app.database.dependencies import get_db_session
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
        422: {"description": "Invalid request"},
        503: {"description": "Authentication service unavailable"},
    },
)
def export_orders_csv_endpoint(
    query: Annotated[OrdersCsvExportQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
) -> Response:
    """Return a buffered orders CSV to an authenticated administrator."""
    return _csv_response(export_orders_csv(session, query))


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
        422: {"description": "Invalid request"},
        503: {"description": "Authentication service unavailable"},
    },
)
def export_product_sales_csv_endpoint(
    query: Annotated[AnalyticsCsvExportQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
) -> Response:
    """Return a buffered product-sales CSV to an authenticated administrator."""
    return _csv_response(export_product_sales_csv(session, query))


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
        422: {"description": "Invalid request"},
        503: {"description": "Authentication service unavailable"},
    },
)
def export_payments_csv_endpoint(
    query: Annotated[AnalyticsCsvExportQuery, Query()],
    session: DatabaseSession,
    _admin: CurrentAdmin,
) -> Response:
    """Return a buffered qualified-payments CSV to an administrator."""
    return _csv_response(export_payments_csv(session, query))


def _csv_response(export: CsvExportResult) -> Response:
    return Response(
        content=export.content,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{export.filename}"',
        },
    )
