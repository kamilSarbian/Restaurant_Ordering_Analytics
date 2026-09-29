"""Atomic synchronous checkout for portfolio-runtime demo orders."""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID, uuid4

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.orders.access import OrderNotFoundError, can_access_order
from app.orders.models import Order
from app.orders.origins import OrderDataOrigin
from app.orders.statuses import OrderStatus
from app.payments import checkout
from app.payments.models import Payment
from app.payments.providers import PaymentProvider
from app.payments.schemas import CheckoutSessionResponse
from app.payments.statuses import PaymentStatus

_NUL = bytes((0,))
DEMO_OUTCOME_DOMAIN = (
    b"restaurant-ordering-analytics"
    + _NUL
    + b"demo-checkout-outcome"
    + _NUL
    + b"v1"
    + _NUL
)
DEMO_PROVIDER_IDEMPOTENCY_PREFIX = "demo-runtime:v1:"
_RECONCILIATION_MESSAGE = "Demo payment state requires reconciliation."
LOGGER = logging.getLogger(__name__)


def demo_outcome_bucket(payment_id: UUID) -> int:
    """Return the v1 deterministic outcome bucket for a backend Payment ID."""
    digest = hashlib.sha256(DEMO_OUTCOME_DOMAIN + payment_id.bytes).digest()
    return int.from_bytes(digest, "big", signed=False) % 100


def select_demo_outcome(payment_id: UUID) -> PaymentStatus:
    """Map one backend Payment ID to the approved v1 terminal demo outcome."""
    bucket = demo_outcome_bucket(payment_id)
    if bucket <= 79:
        return PaymentStatus.SUCCEEDED
    if bucket <= 89:
        return PaymentStatus.FAILED
    return PaymentStatus.EXPIRED


def build_demo_provider_idempotency_key(payment_id: UUID) -> str:
    """Build the versioned provider-side key for one demo Payment."""
    return f"{DEMO_PROVIDER_IDEMPOTENCY_PREFIX}{payment_id.hex}"


def checkout_demo_order(
    session: Session,
    *,
    public_order_number: str,
    access_token: str | None,
    request_idempotency_key: UUID,
    payment_provider: str,
    current_user_id: UUID | None = None,
    now_provider: Callable[[], datetime] = checkout.utc_now,
    payment_id_provider: Callable[[], UUID] | None = None,
) -> checkout.CheckoutOutcome:
    """Create or replay one atomic synchronous portfolio demo payment.

    Args:
        session: Request-scoped SQLAlchemy session.
        public_order_number: Untrusted public order identifier.
        access_token: Optional raw guest capability.
        request_idempotency_key: Validated canonical request UUIDv4.
        payment_provider: Trusted current provider from application settings.
        current_user_id: Canonical current User identifier, when authenticated.
        now_provider: Injectable timezone-aware server clock.
        payment_id_provider: Internal backend UUID generator and test seam.

    Returns:
        Public terminal checkout response and HTTP creation semantics.

    Raises:
        OrderNotFoundError: If neither ownership nor capability grants access.
        checkout.OrderNotPayableError: If a new attempt is not permitted.
        checkout.OrderAlreadyPaidError: If a new key follows a success.
        checkout.PaymentSessionReconciliationRequiredError: If persisted or
            persistence state is unsafe.
        checkout.PaymentServiceUnavailableError: If runtime isolation fails.
    """
    persistence_failed = False
    try:
        return _checkout_demo_order(
            session,
            public_order_number=public_order_number,
            access_token=access_token,
            request_idempotency_key=request_idempotency_key,
            payment_provider=payment_provider,
            current_user_id=current_user_id,
            now_provider=now_provider,
            payment_id_provider=payment_id_provider,
        )
    except DBAPIError:
        persistence_failed = True

    if persistence_failed:
        LOGGER.warning("Demo checkout persistence failed during atomic transaction")
        raise checkout.PaymentSessionReconciliationRequiredError(
            _RECONCILIATION_MESSAGE
        )
    raise RuntimeError("Unreachable demo checkout persistence state")


def _checkout_demo_order(
    session: Session,
    *,
    public_order_number: str,
    access_token: str | None,
    request_idempotency_key: UUID,
    payment_provider: str,
    current_user_id: UUID | None,
    now_provider: Callable[[], datetime],
    payment_id_provider: Callable[[], UUID] | None,
) -> checkout.CheckoutOutcome:
    outcome: checkout.CheckoutOutcome | None = None
    with session.begin():
        order = session.scalar(
            select(Order)
            .where(Order.public_order_number == public_order_number)
            .with_for_update()
        )
        if order is None or not can_access_order(
            order_customer_user_id=order.customer_user_id,
            current_user_id=current_user_id,
            access_token=access_token,
            expected_access_token_hash=order.order_access_token_hash,
        ):
            raise OrderNotFoundError
        if (
            payment_provider != PaymentProvider.DEMO.value
            or order.data_origin != OrderDataOrigin.PORTFOLIO_RUNTIME.value
        ):
            raise checkout.PaymentServiceUnavailableError

        payments = _lock_payments(session, order.id)
        statuses = {
            payment.id: _validated_payment_status(payment, order)
            for payment in payments
        }
        same_key_payment = next(
            (
                payment
                for payment in payments
                if payment.request_idempotency_key == request_idempotency_key
            ),
            None,
        )
        if same_key_payment is not None:
            outcome = checkout.CheckoutOutcome(
                response=_terminal_response(
                    order.public_order_number,
                    statuses[same_key_payment.id],
                ),
                created=False,
            )
        else:
            if any(status is PaymentStatus.SUCCEEDED for status in statuses.values()):
                raise checkout.OrderAlreadyPaidError
            if order.status != OrderStatus.CREATED.value:
                raise checkout.OrderNotPayableError
            outcome = _create_terminal_attempt(
                session,
                order=order,
                request_idempotency_key=request_idempotency_key,
                now_provider=now_provider,
                payment_id_provider=payment_id_provider or uuid4,
            )

    if outcome is None:
        raise checkout.PaymentSessionReconciliationRequiredError(
            _RECONCILIATION_MESSAGE
        )
    return outcome


def _lock_payments(session: Session, order_id: UUID) -> list[Payment]:
    return list(
        session.scalars(
            select(Payment)
            .where(Payment.order_id == order_id)
            .order_by(Payment.created_at.asc(), Payment.id.asc())
            .with_for_update()
        ).all()
    )


def _validated_payment_status(payment: Payment, order: Order) -> PaymentStatus:
    try:
        payment_status = PaymentStatus(payment.status)
    except (TypeError, ValueError):
        payment_status = None

    if (
        payment_status is None
        or payment_status is PaymentStatus.PENDING
        or payment.provider != PaymentProvider.DEMO.value
        or payment.provider_idempotency_key
        != build_demo_provider_idempotency_key(payment.id)
        or payment.amount != order.total_amount
        or payment.currency != order.currency
        or payment.provider_session_id is not None
        or payment.provider_checkout_url is not None
        or payment.provider_checkout_expires_at is not None
        or (
            payment_status is PaymentStatus.SUCCEEDED
            and not _is_aware(payment.succeeded_at)
        )
        or (
            payment_status is not PaymentStatus.SUCCEEDED
            and payment.succeeded_at is not None
        )
    ):
        raise checkout.PaymentSessionReconciliationRequiredError(
            _RECONCILIATION_MESSAGE
        )
    return payment_status


def _create_terminal_attempt(
    session: Session,
    *,
    order: Order,
    request_idempotency_key: UUID,
    now_provider: Callable[[], datetime],
    payment_id_provider: Callable[[], UUID],
) -> checkout.CheckoutOutcome:
    payment_id = payment_id_provider()
    if not isinstance(payment_id, UUID):
        raise TypeError("payment_id_provider must return UUID")
    payment = Payment(
        id=payment_id,
        order_id=order.id,
        status=PaymentStatus.PENDING.value,
        amount=order.total_amount,
        currency=order.currency,
        request_idempotency_key=request_idempotency_key,
        provider=PaymentProvider.DEMO.value,
        provider_idempotency_key=build_demo_provider_idempotency_key(payment_id),
        provider_session_id=None,
        provider_checkout_url=None,
        provider_checkout_expires_at=None,
        succeeded_at=None,
    )
    session.add(payment)
    session.flush()

    payment_status = select_demo_outcome(payment.id)
    payment.status = payment_status.value
    if payment_status is PaymentStatus.SUCCEEDED:
        payment.succeeded_at = _as_utc(now_provider())
    session.flush()

    return checkout.CheckoutOutcome(
        response=_terminal_response(order.public_order_number, payment_status),
        created=True,
    )


def _terminal_response(
    public_order_number: str,
    payment_status: PaymentStatus,
) -> CheckoutSessionResponse:
    response: CheckoutSessionResponse | None = None
    try:
        response = CheckoutSessionResponse(
            public_order_number=public_order_number,
            payment_status=payment_status,
            checkout_url=None,
            expires_at=None,
        )
    except ValidationError:
        pass
    if response is None:
        raise checkout.PaymentSessionReconciliationRequiredError(
            _RECONCILIATION_MESSAGE
        )
    return response


def _as_utc(value: datetime) -> datetime:
    if not _is_aware(value):
        raise checkout.PaymentSessionReconciliationRequiredError(
            _RECONCILIATION_MESSAGE
        )
    return value.astimezone(UTC)


def _is_aware(value: datetime | None) -> bool:
    return (
        value is not None and value.tzinfo is not None and value.utcoffset() is not None
    )
