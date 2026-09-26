"""Public HTTP endpoint for idempotent hosted checkout creation."""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from app.auth.dependencies import UserBearerCredentials, get_optional_current_user
from app.core.rate_limit import get_client_bucket_key
from app.database.dependencies import get_db_session
from app.orders.access import OrderNotFoundError
from app.payments import checkout
from app.payments.schemas import CheckoutSessionResponse
from app.payments.stripe_checkout import (
    InvalidCheckoutIdempotencyKeyError,
    parse_checkout_idempotency_key,
)

router = APIRouter(prefix="/api/v1/orders", tags=["payments"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]


@router.post(
    "/{public_order_number}/checkout-session",
    response_model=CheckoutSessionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a checkout session",
    responses={
        200: {
            "model": CheckoutSessionResponse,
            "description": "Existing idempotent checkout session",
        },
        401: {"description": "Invalid canonical authentication credentials"},
        404: {"description": "Order not found"},
        409: {"description": "Order or payment state conflict"},
        422: {"description": "Invalid Idempotency-Key"},
        429: {"description": "Checkout rate limit exceeded"},
        502: {"description": "Payment provider unavailable"},
        503: {
            "description": (
                "Authentication, payment service, or session state unavailable"
            )
        },
    },
    openapi_extra={"security": [{}]},
)
def create_checkout_session_endpoint(
    public_order_number: str,
    request: Request,
    response: Response,
    session: DatabaseSession,
    credentials: UserBearerCredentials,
    access_token: Annotated[
        str | None,
        Header(alias="X-Order-Access-Token"),
    ] = None,
    idempotency_key: Annotated[
        str | None,
        Header(alias="Idempotency-Key"),
    ] = None,
) -> CheckoutSessionResponse:
    """Create or replay an authenticated, rate-limited Checkout Session."""
    try:
        parsed_idempotency_key = parse_checkout_idempotency_key(idempotency_key)
    except InvalidCheckoutIdempotencyKeyError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid Idempotency-Key",
        ) from error

    limiter = request.app.state.checkout_rate_limiter
    rate_limit = limiter.check(get_client_bucket_key(request))
    if not rate_limit.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many checkout requests",
            headers={"Retry-After": str(rate_limit.retry_after_seconds)},
        )

    current_user = get_optional_current_user(request, credentials)

    try:
        outcome = checkout.checkout_order(
            session,
            public_order_number=public_order_number,
            access_token=access_token,
            request_idempotency_key=parsed_idempotency_key,
            payment_provider=request.app.state.payment_provider,
            stripe_client=request.app.state.stripe_checkout_client,
            stripe_success_url_template=request.app.state.stripe_success_url,
            stripe_cancel_url_template=request.app.state.stripe_cancel_url,
            current_user_id=(None if current_user is None else current_user.id),
            now_provider=request.app.state.checkout_now_provider,
        )
    except OrderNotFoundError as error:
        raise _http_error(status.HTTP_404_NOT_FOUND, "Order not found") from error
    except checkout.OrderNotPayableError as error:
        raise _http_error(status.HTTP_409_CONFLICT, "Order is not payable") from error
    except checkout.ActivePaymentAttemptError as error:
        raise _http_error(
            status.HTTP_409_CONFLICT,
            "Active payment attempt exists",
        ) from error
    except checkout.OrderAlreadyPaidError as error:
        raise _http_error(status.HTTP_409_CONFLICT, "Order is already paid") from error
    except checkout.PaymentAttemptExpiredError as error:
        raise _http_error(
            status.HTTP_409_CONFLICT,
            "Payment attempt expired",
        ) from error
    except checkout.PaymentProviderUnavailableError as error:
        raise _http_error(
            status.HTTP_502_BAD_GATEWAY,
            "Payment provider unavailable",
        ) from error
    except checkout.PaymentSessionOutcomeUnknownError as error:
        raise _http_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Payment session outcome is unknown",
        ) from error
    except checkout.PaymentSessionReconciliationRequiredError as error:
        raise _http_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Payment session requires reconciliation",
        ) from error
    except checkout.PaymentServiceUnavailableError as error:
        raise _http_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Payment service unavailable",
        ) from error

    response.status_code = (
        status.HTTP_201_CREATED if outcome.created else status.HTTP_200_OK
    )
    return outcome.response


def _http_error(status_code: int, detail: str) -> HTTPException:
    """Build one stable public HTTP exception without leaking internal context."""
    return HTTPException(status_code=status_code, detail=detail)
