"""Private transport boundary for signed Stripe webhook deliveries."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.database.dependencies import get_db_session
from app.payments.stripe_webhook import StripeWebhookVerificationError
from app.payments.webhook import process_verified_stripe_event

router = APIRouter(prefix="/api/v1/stripe", tags=["stripe-webhook"])
DatabaseSession = Annotated[Session, Depends(get_db_session)]


@router.post("/webhook", include_in_schema=False)
async def receive_stripe_webhook(
    request: Request,
    session: DatabaseSession,
) -> dict[str, bool]:
    """Verify and transactionally process one Stripe webhook delivery."""
    verifier = request.app.state.stripe_webhook_verifier
    if verifier is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Webhook service unavailable",
        )

    signature_header = request.headers.get("Stripe-Signature")
    if signature_header is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid webhook request",
        )

    payload = await request.body()
    try:
        verified_event = verifier.verify(payload, signature_header)
    except StripeWebhookVerificationError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid webhook request",
        ) from error

    try:
        process_verified_stripe_event(session, verified_event)
    except SQLAlchemyError as error:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Webhook processing failed",
        ) from error
    return {"received": True}
