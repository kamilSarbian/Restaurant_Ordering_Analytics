"""Persist verified Stripe events and apply payment-attempt transitions."""

from __future__ import annotations

from enum import StrEnum
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.orders.models import Order
from app.payments.models import Payment, StripeEvent
from app.payments.providers import PaymentProvider
from app.payments.statuses import PaymentStatus
from app.payments.stripe_webhook import (
    IgnoredStripeEvent,
    StripeWebhookEventType,
    VerifiedStripeCheckoutEvent,
)


class WebhookProcessingOutcome(StrEnum):
    """Enumerate durable and transport-only webhook processing outcomes."""

    TRANSITIONED = "transitioned"
    AWAITING_ASYNC_PAYMENT = "awaiting_async_payment"
    ALREADY_APPLIED = "already_applied"
    RECONCILIATION_REQUIRED = "reconciliation_required"
    DUPLICATE = "duplicate"
    IGNORED = "ignored"


def process_verified_stripe_event(
    session: Session,
    event: VerifiedStripeCheckoutEvent | IgnoredStripeEvent,
) -> WebhookProcessingOutcome:
    """Process one trusted provider event in a short database transaction.

    Args:
        session: Request-scoped SQLAlchemy session with no active transaction.
        event: Minimal provider facts returned by the signature adapter.

    Returns:
        The internal processing outcome. Transport layers must acknowledge every
        non-error outcome without exposing it publicly.
    """
    if isinstance(event, IgnoredStripeEvent):
        return WebhookProcessingOutcome.IGNORED

    payment_id = _parse_canonical_uuid(event.metadata_payment_id)
    order_id = _parse_canonical_uuid(event.metadata_order_id)
    if payment_id is None or order_id is None:
        return _store_uncorrelated_receipt(session, event)

    with session.begin():
        order = session.scalar(
            select(Order).where(Order.id == order_id).with_for_update()
        )
        if order is None:
            return _insert_reconciliation_receipt(session, event, payment_id=None)

        payments = _lock_order_payments(session, order.id)
        if _receipt_exists(session, event.stripe_event_id):
            return WebhookProcessingOutcome.DUPLICATE

        payment = next((item for item in payments if item.id == payment_id), None)
        if payment is None:
            return _insert_reconciliation_receipt(session, event, payment_id=None)

        if payment.provider != PaymentProvider.STRIPE_TEST.value:
            return _insert_reconciliation_receipt(
                session,
                event,
                payment_id=payment.id,
            )

        if not _integrity_matches(event, order=order, payment=payment):
            return _insert_reconciliation_receipt(
                session,
                event,
                payment_id=payment.id,
            )

        outcome, next_status = _transition_decision(
            event, PaymentStatus(payment.status)
        )
        if next_status is PaymentStatus.SUCCEEDED and any(
            item.id != payment.id and item.status == PaymentStatus.SUCCEEDED.value
            for item in payments
        ):
            outcome = WebhookProcessingOutcome.RECONCILIATION_REQUIRED
            next_status = None
        inserted = _insert_receipt(
            session,
            event,
            payment_id=payment.id,
            processing_result=outcome,
        )
        if not inserted:
            return WebhookProcessingOutcome.DUPLICATE
        if next_status is not None:
            payment.status = next_status.value
            if next_status is PaymentStatus.SUCCEEDED:
                payment.succeeded_at = event.stripe_created_at
        return outcome


def _store_uncorrelated_receipt(
    session: Session,
    event: VerifiedStripeCheckoutEvent,
) -> WebhookProcessingOutcome:
    with session.begin():
        return _insert_reconciliation_receipt(session, event, payment_id=None)


def _insert_reconciliation_receipt(
    session: Session,
    event: VerifiedStripeCheckoutEvent,
    *,
    payment_id: UUID | None,
) -> WebhookProcessingOutcome:
    inserted = _insert_receipt(
        session,
        event,
        payment_id=payment_id,
        processing_result=WebhookProcessingOutcome.RECONCILIATION_REQUIRED,
    )
    if not inserted:
        return WebhookProcessingOutcome.DUPLICATE
    return WebhookProcessingOutcome.RECONCILIATION_REQUIRED


def _insert_receipt(
    session: Session,
    event: VerifiedStripeCheckoutEvent,
    *,
    payment_id: UUID | None,
    processing_result: WebhookProcessingOutcome,
) -> bool:
    statement = (
        insert(StripeEvent)
        .values(
            stripe_event_id=event.stripe_event_id,
            event_type=event.event_type.value,
            livemode=event.livemode,
            stripe_created_at=event.stripe_created_at,
            stripe_checkout_session_id=event.stripe_checkout_session_id,
            payment_id=payment_id,
            processing_result=processing_result.value,
        )
        .on_conflict_do_nothing(index_elements=[StripeEvent.stripe_event_id])
        .returning(StripeEvent.id)
    )
    return session.execute(statement).scalar_one_or_none() is not None


def _receipt_exists(session: Session, stripe_event_id: str) -> bool:
    return (
        session.scalar(
            select(StripeEvent.id).where(StripeEvent.stripe_event_id == stripe_event_id)
        )
        is not None
    )


def _lock_order_payments(session: Session, order_id: UUID) -> list[Payment]:
    return list(
        session.scalars(
            select(Payment)
            .where(Payment.order_id == order_id)
            .order_by(Payment.created_at.asc(), Payment.id.asc())
            .with_for_update()
        ).all()
    )


def _parse_canonical_uuid(value: str | None) -> UUID | None:
    try:
        parsed = UUID(value)
    except (AttributeError, TypeError, ValueError):
        return None
    return parsed if value == str(parsed) else None


def _integrity_matches(
    event: VerifiedStripeCheckoutEvent,
    *,
    order: Order,
    payment: Payment,
) -> bool:
    if event.metadata_payment_id != str(payment.id):
        return False
    if event.metadata_order_id != str(order.id) or payment.order_id != order.id:
        return False
    if event.metadata_public_order_number != order.public_order_number:
        return False
    if (
        payment.provider_session_id is not None
        and payment.provider_session_id != event.stripe_checkout_session_id
    ):
        return False
    if event.mode != "payment" or event.amount_total != payment.amount:
        return False
    if event.currency is None or event.currency.upper() != payment.currency:
        return False
    return True


def _transition_decision(
    event: VerifiedStripeCheckoutEvent,
    current_status: PaymentStatus,
) -> tuple[WebhookProcessingOutcome, PaymentStatus | None]:
    if event.event_type is StripeWebhookEventType.COMPLETED:
        if event.session_status != "complete":
            return WebhookProcessingOutcome.RECONCILIATION_REQUIRED, None
        if event.payment_status == "paid":
            return _terminal_decision(
                current_status,
                target_status=PaymentStatus.SUCCEEDED,
            )
        if event.payment_status == "unpaid" and current_status is PaymentStatus.PENDING:
            return WebhookProcessingOutcome.AWAITING_ASYNC_PAYMENT, None
        return WebhookProcessingOutcome.RECONCILIATION_REQUIRED, None

    if event.event_type is StripeWebhookEventType.ASYNC_PAYMENT_SUCCEEDED:
        if event.session_status != "complete" or event.payment_status != "paid":
            return WebhookProcessingOutcome.RECONCILIATION_REQUIRED, None
        return _terminal_decision(
            current_status,
            target_status=PaymentStatus.SUCCEEDED,
        )

    if event.event_type is StripeWebhookEventType.ASYNC_PAYMENT_FAILED:
        if event.session_status != "complete" or event.payment_status != "unpaid":
            return WebhookProcessingOutcome.RECONCILIATION_REQUIRED, None
        return _terminal_decision(
            current_status,
            target_status=PaymentStatus.FAILED,
        )

    if event.session_status != "expired" or event.payment_status != "unpaid":
        return WebhookProcessingOutcome.RECONCILIATION_REQUIRED, None
    return _terminal_decision(
        current_status,
        target_status=PaymentStatus.EXPIRED,
    )


def _terminal_decision(
    current_status: PaymentStatus,
    *,
    target_status: PaymentStatus,
) -> tuple[WebhookProcessingOutcome, PaymentStatus | None]:
    if current_status is PaymentStatus.PENDING:
        return WebhookProcessingOutcome.TRANSITIONED, target_status
    if current_status is target_status:
        return WebhookProcessingOutcome.ALREADY_APPLIED, None
    return WebhookProcessingOutcome.RECONCILIATION_REQUIRED, None
