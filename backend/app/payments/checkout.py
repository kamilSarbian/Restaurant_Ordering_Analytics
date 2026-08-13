"""Transactional checkout orchestration across PostgreSQL and Stripe."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.orders.access import OrderNotFoundError, can_access_order
from app.orders.models import Order
from app.orders.statuses import OrderStatus
from app.payments.models import Payment
from app.payments.schemas import CheckoutSessionResponse
from app.payments.statuses import PaymentStatus
from app.payments.stripe_checkout import (
    CheckoutConfigurationError,
    CheckoutSessionResult,
    StripeCheckoutAmbiguousError,
    StripeCheckoutClient,
    StripeCheckoutDefinitiveError,
    StripeCheckoutRequest,
    build_stripe_idempotency_key,
    render_checkout_redirect_url,
)

PENDING_RETRY_LIMIT = timedelta(hours=23)


class OrderNotPayableError(Exception):
    """Report an order whose fulfilment state forbids payment."""


class ActivePaymentAttemptError(Exception):
    """Report a different pending attempt that blocks a new payment."""


class OrderAlreadyPaidError(Exception):
    """Report an order that already has a succeeded payment attempt."""


class PaymentAttemptExpiredError(Exception):
    """Report replay of an explicitly expired payment attempt."""


class PaymentProviderUnavailableError(Exception):
    """Report a definitive provider rejection for the payment attempt."""


class PaymentSessionOutcomeUnknownError(Exception):
    """Report an external call whose remote outcome cannot be determined."""


class PaymentSessionReconciliationRequiredError(Exception):
    """Report payment/session state requiring manual reconciliation."""


class PaymentServiceUnavailableError(Exception):
    """Report missing or invalid local checkout provider configuration."""


@dataclass(frozen=True)
class CheckoutOutcome:
    """Carry the public checkout response and HTTP creation semantics."""

    response: CheckoutSessionResponse
    created: bool


@dataclass(frozen=True)
class _ProviderWork:
    request: StripeCheckoutRequest
    created: bool


def utc_now() -> datetime:
    """Return the current timezone-aware UTC datetime."""
    return datetime.now(UTC)


def checkout_order(
    session: Session,
    *,
    public_order_number: str,
    access_token: str | None,
    request_idempotency_key: UUID,
    stripe_client: StripeCheckoutClient | None,
    stripe_success_url_template: str | None,
    stripe_cancel_url_template: str | None,
    current_user_id: UUID | None = None,
    now_provider: Callable[[], datetime] = utc_now,
) -> CheckoutOutcome:
    """Create, replay, or recover one idempotent hosted checkout operation.

    Args:
        session: Request-scoped SQLAlchemy session.
        public_order_number: Untrusted public order identifier.
        access_token: Optional raw guest access token.
        request_idempotency_key: Validated canonical request UUIDv4.
        stripe_client: App-scoped Stripe adapter, when configured.
        stripe_success_url_template: Server-owned success redirect template.
        stripe_cancel_url_template: Server-owned cancellation redirect template.
        current_user_id: Canonical current User identifier, when authenticated.
        now_provider: Injectable timezone-aware clock.

    Returns:
        Public checkout response and whether this call created the Payment row.

    Raises:
        OrderNotFoundError: If neither ownership nor guest capability grants access.
        OrderNotPayableError: If the order status forbids checkout.
        ActivePaymentAttemptError: If another pending attempt exists.
        OrderAlreadyPaidError: If a succeeded attempt exists.
        PaymentAttemptExpiredError: If the same attempt is explicitly expired.
        PaymentProviderUnavailableError: If Stripe definitively rejects creation.
        PaymentSessionOutcomeUnknownError: If Stripe creation is ambiguous.
        PaymentSessionReconciliationRequiredError: If persisted state is unsafe.
        PaymentServiceUnavailableError: If provider configuration is unavailable.
    """
    now = _as_utc(now_provider())
    immediate_outcome: CheckoutOutcome | None = None
    provider_work: _ProviderWork | None = None

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
        if order.status != OrderStatus.CREATED.value:
            raise OrderNotPayableError

        payments = _lock_payments(session, order.id)
        if any(payment.status == PaymentStatus.SUCCEEDED.value for payment in payments):
            raise OrderAlreadyPaidError

        same_key_payment = next(
            (
                payment
                for payment in payments
                if payment.request_idempotency_key == request_idempotency_key
            ),
            None,
        )
        if same_key_payment is not None:
            immediate_outcome, provider_work = _resolve_same_key_payment(
                payment=same_key_payment,
                order=order,
                now=now,
                stripe_client=stripe_client,
                success_url_template=stripe_success_url_template,
                cancel_url_template=stripe_cancel_url_template,
            )
        else:
            if any(
                payment.status == PaymentStatus.PENDING.value for payment in payments
            ):
                raise ActivePaymentAttemptError
            provider_work = _create_pending_attempt(
                session=session,
                order=order,
                request_idempotency_key=request_idempotency_key,
                stripe_client=stripe_client,
                success_url_template=stripe_success_url_template,
                cancel_url_template=stripe_cancel_url_template,
            )

    if immediate_outcome is not None:
        return immediate_outcome
    if provider_work is None:
        raise PaymentSessionReconciliationRequiredError
    if session.in_transaction():
        raise RuntimeError("Stripe call attempted inside a database transaction")

    try:
        provider_result = stripe_client_create(stripe_client, provider_work.request)
    except StripeCheckoutDefinitiveError:
        return _resolve_definitive_failure(
            session,
            order_id=provider_work.request.order_id,
            payment_id=provider_work.request.payment_id,
            public_order_number=provider_work.request.public_order_number,
            created=provider_work.created,
        )
    except StripeCheckoutAmbiguousError as exc:
        raise PaymentSessionOutcomeUnknownError from exc

    return _persist_provider_success(
        session,
        order_id=provider_work.request.order_id,
        payment_id=provider_work.request.payment_id,
        public_order_number=provider_work.request.public_order_number,
        provider_result=provider_result,
        created=provider_work.created,
    )


def stripe_client_create(
    stripe_client: StripeCheckoutClient | None,
    request: StripeCheckoutRequest,
) -> CheckoutSessionResult:
    """Invoke the already-validated app-scoped provider boundary."""
    if stripe_client is None:
        raise PaymentServiceUnavailableError
    return stripe_client.create_checkout_session(request)


def _lock_payments(session: Session, order_id: UUID) -> list[Payment]:
    return list(
        session.scalars(
            select(Payment)
            .where(Payment.order_id == order_id)
            .order_by(Payment.created_at.asc(), Payment.id.asc())
            .with_for_update()
        ).all()
    )


def _resolve_same_key_payment(
    *,
    payment: Payment,
    order: Order,
    now: datetime,
    stripe_client: StripeCheckoutClient | None,
    success_url_template: str | None,
    cancel_url_template: str | None,
) -> tuple[CheckoutOutcome | None, _ProviderWork | None]:
    status = PaymentStatus(payment.status)
    if status is PaymentStatus.SUCCEEDED:
        raise OrderAlreadyPaidError
    if status is PaymentStatus.FAILED:
        raise PaymentProviderUnavailableError
    if status is PaymentStatus.EXPIRED:
        raise PaymentAttemptExpiredError

    session_state = _session_field_state(payment)
    if session_state == "partial":
        raise PaymentSessionReconciliationRequiredError
    if session_state == "complete":
        expires_at = _as_utc(payment.stripe_checkout_expires_at)
        if expires_at <= now:
            raise PaymentSessionReconciliationRequiredError
        return (
            CheckoutOutcome(
                response=_stored_response(order.public_order_number, payment),
                created=False,
            ),
            None,
        )

    created_at = _as_utc(payment.created_at)
    if now - created_at >= PENDING_RETRY_LIMIT:
        raise PaymentSessionReconciliationRequiredError
    request = _provider_request(
        order=order,
        payment=payment,
        stripe_client=stripe_client,
        success_url_template=success_url_template,
        cancel_url_template=cancel_url_template,
    )
    return None, _ProviderWork(request=request, created=False)


def _create_pending_attempt(
    *,
    session: Session,
    order: Order,
    request_idempotency_key: UUID,
    stripe_client: StripeCheckoutClient | None,
    success_url_template: str | None,
    cancel_url_template: str | None,
) -> _ProviderWork:
    success_url, cancel_url = _provider_urls(
        stripe_client,
        success_url_template,
        cancel_url_template,
        order.public_order_number,
    )
    payment_id = uuid4()
    payment = Payment(
        id=payment_id,
        order_id=order.id,
        status=PaymentStatus.PENDING.value,
        amount=order.total_amount,
        currency=order.currency,
        request_idempotency_key=request_idempotency_key,
        stripe_idempotency_key=build_stripe_idempotency_key(payment_id),
    )
    session.add(payment)
    session.flush()
    return _ProviderWork(
        request=StripeCheckoutRequest(
            amount=payment.amount,
            currency=payment.currency,
            public_order_number=order.public_order_number,
            order_id=order.id,
            payment_id=payment.id,
            success_url=success_url,
            cancel_url=cancel_url,
            stripe_idempotency_key=payment.stripe_idempotency_key,
        ),
        created=True,
    )


def _provider_request(
    *,
    order: Order,
    payment: Payment,
    stripe_client: StripeCheckoutClient | None,
    success_url_template: str | None,
    cancel_url_template: str | None,
) -> StripeCheckoutRequest:
    success_url, cancel_url = _provider_urls(
        stripe_client,
        success_url_template,
        cancel_url_template,
        order.public_order_number,
    )
    return StripeCheckoutRequest(
        amount=payment.amount,
        currency=payment.currency,
        public_order_number=order.public_order_number,
        order_id=order.id,
        payment_id=payment.id,
        success_url=success_url,
        cancel_url=cancel_url,
        stripe_idempotency_key=payment.stripe_idempotency_key,
    )


def _provider_urls(
    stripe_client: StripeCheckoutClient | None,
    success_url_template: str | None,
    cancel_url_template: str | None,
    public_order_number: str,
) -> tuple[str, str]:
    if stripe_client is None:
        raise PaymentServiceUnavailableError
    try:
        success_url = render_checkout_redirect_url(
            success_url_template,
            public_order_number,
        )
        cancel_url = render_checkout_redirect_url(
            cancel_url_template,
            public_order_number,
        )
    except CheckoutConfigurationError as exc:
        raise PaymentServiceUnavailableError from exc
    return success_url, cancel_url


def _persist_provider_success(
    session: Session,
    *,
    order_id: UUID,
    payment_id: UUID,
    public_order_number: str,
    provider_result: CheckoutSessionResult,
    created: bool,
) -> CheckoutOutcome:
    provider_expires_at = _as_utc(provider_result.expires_at)
    response: CheckoutSessionResponse | None = None
    with session.begin():
        order = session.scalar(
            select(Order).where(Order.id == order_id).with_for_update()
        )
        if order is None:
            raise PaymentSessionReconciliationRequiredError
        payments = _lock_payments(session, order.id)
        if any(
            payment.status == PaymentStatus.SUCCEEDED.value and payment.id != payment_id
            for payment in payments
        ):
            raise OrderAlreadyPaidError
        payment = next((item for item in payments if item.id == payment_id), None)
        if payment is None:
            raise PaymentSessionReconciliationRequiredError
        if payment.status not in {
            PaymentStatus.PENDING.value,
            PaymentStatus.SUCCEEDED.value,
        }:
            raise PaymentSessionReconciliationRequiredError

        session_state = _session_field_state(payment)
        if session_state == "partial":
            raise PaymentSessionReconciliationRequiredError
        if session_state == "empty":
            payment.stripe_checkout_session_id = provider_result.session_id
            payment.stripe_checkout_url = provider_result.checkout_url
            payment.stripe_checkout_expires_at = provider_expires_at
        elif not _provider_result_matches(
            payment, provider_result, provider_expires_at
        ):
            raise PaymentSessionReconciliationRequiredError
        response = _stored_response(public_order_number, payment)

    if response is None:
        raise PaymentSessionReconciliationRequiredError
    return CheckoutOutcome(response=response, created=created)


def _resolve_definitive_failure(
    session: Session,
    *,
    order_id: UUID,
    payment_id: UUID,
    public_order_number: str,
    created: bool,
) -> CheckoutOutcome:
    stored_outcome: CheckoutOutcome | None = None
    resolution: str | None = None
    with session.begin():
        order = session.scalar(
            select(Order).where(Order.id == order_id).with_for_update()
        )
        if order is None:
            raise PaymentSessionReconciliationRequiredError
        payments = _lock_payments(session, order.id)
        if any(payment.status == PaymentStatus.SUCCEEDED.value for payment in payments):
            resolution = "paid"
        else:
            payment = next((item for item in payments if item.id == payment_id), None)
            if payment is None:
                raise PaymentSessionReconciliationRequiredError
            if payment.status == PaymentStatus.FAILED.value:
                resolution = "failed"
            elif payment.status != PaymentStatus.PENDING.value:
                resolution = "reconcile"
            else:
                session_state = _session_field_state(payment)
                if session_state == "empty":
                    payment.status = PaymentStatus.FAILED.value
                    resolution = "failed"
                elif session_state == "complete":
                    stored_outcome = CheckoutOutcome(
                        response=_stored_response(public_order_number, payment),
                        created=created,
                    )
                else:
                    resolution = "reconcile"

    if stored_outcome is not None:
        return stored_outcome
    if resolution == "paid":
        raise OrderAlreadyPaidError
    if resolution == "failed":
        raise PaymentProviderUnavailableError
    raise PaymentSessionReconciliationRequiredError


def _session_field_state(payment: Payment) -> str:
    values = (
        payment.stripe_checkout_session_id,
        payment.stripe_checkout_url,
        payment.stripe_checkout_expires_at,
    )
    populated = sum(value is not None for value in values)
    if populated == 0:
        return "empty"
    if populated == len(values):
        return "complete"
    return "partial"


def _stored_response(
    public_order_number: str,
    payment: Payment,
) -> CheckoutSessionResponse:
    if _session_field_state(payment) != "complete":
        raise PaymentSessionReconciliationRequiredError
    if payment.stripe_checkout_url is None:
        raise PaymentSessionReconciliationRequiredError
    return CheckoutSessionResponse(
        public_order_number=public_order_number,
        payment_status=PaymentStatus(payment.status),
        checkout_url=payment.stripe_checkout_url,
        expires_at=_as_utc(payment.stripe_checkout_expires_at),
    )


def _provider_result_matches(
    payment: Payment,
    provider_result: CheckoutSessionResult,
    provider_expires_at: datetime,
) -> bool:
    return (
        payment.stripe_checkout_session_id == provider_result.session_id
        and payment.stripe_checkout_url == provider_result.checkout_url
        and _as_utc(payment.stripe_checkout_expires_at) == provider_expires_at
    )


def _as_utc(value: datetime | None) -> datetime:
    if value is None or value.tzinfo is None or value.utcoffset() is None:
        raise PaymentSessionReconciliationRequiredError
    return value.astimezone(UTC)
