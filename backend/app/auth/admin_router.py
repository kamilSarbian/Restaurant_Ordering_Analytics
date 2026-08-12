"""Super-administrator HTTP routes for registered-user role management."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth.dependencies import require_super_admin
from app.auth.schemas import AdminPrincipal
from app.auth.user_schemas import (
    UserAdminListResponse,
    UserRoleUpdateRequest,
    UserRoleUpdateResponse,
)
from app.auth.user_service import (
    UserNotFoundError,
    UserRoleConflictError,
    list_users,
    update_user_role,
)
from app.database.dependencies import get_db_session

router = APIRouter(prefix="/api/v1/admin/users", tags=["admin-users"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]
CurrentSuperAdmin = Annotated[AdminPrincipal, Depends(require_super_admin)]
PageLimit = Annotated[int, Query(ge=1, le=100)]
PageOffset = Annotated[int, Query(ge=0)]

AUTH_RESPONSES = {
    401: {"description": "Invalid authentication credentials"},
    403: {"description": "Super-administrator access required"},
    503: {"description": "Authentication service unavailable"},
}


@router.get(
    "",
    response_model=UserAdminListResponse,
    summary="List registered users",
    responses=AUTH_RESPONSES,
)
def list_users_endpoint(
    session: DatabaseSession,
    _super_admin: CurrentSuperAdmin,
    limit: PageLimit = 50,
    offset: PageOffset = 0,
) -> UserAdminListResponse:
    """Return one super-administrator-only page of safe user identities."""
    try:
        return list_users(session, limit=limit, offset=offset)
    except SQLAlchemyError:
        raise _service_unavailable_error() from None


@router.patch(
    "/{user_id}/role",
    response_model=UserRoleUpdateResponse,
    summary="Change an ordinary user role",
    responses={
        **AUTH_RESPONSES,
        404: {"description": "User not found"},
        409: {"description": "Role transition is not allowed"},
        422: {"description": "Invalid request"},
    },
)
def update_user_role_endpoint(
    user_id: UUID,
    payload: UserRoleUpdateRequest,
    session: DatabaseSession,
    _super_admin: CurrentSuperAdmin,
) -> UserRoleUpdateResponse:
    """Apply one locked customer-to-admin or admin-to-customer transition."""
    try:
        return update_user_role(session, user_id=user_id, request=payload)
    except UserNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        ) from error
    except UserRoleConflictError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Role transition is not allowed",
        ) from error
    except SQLAlchemyError:
        raise _service_unavailable_error() from None


def _service_unavailable_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="User management service unavailable",
    )
