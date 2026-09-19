"""Persistent SQLAlchemy model for payment attempts."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base
from app.payments.statuses import PaymentStatus

if TYPE_CHECKING:
    from app.orders.models import Order


class Payment(Base):
    """Represent one durable payment attempt for an order."""

    __tablename__ = "payments"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, nullable=False
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("orders.id", ondelete="RESTRICT"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        String(16),
        default=PaymentStatus.PENDING.value,
        server_default=text("'pending'"),
        nullable=False,
    )
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    request_idempotency_key: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(11), nullable=False)
    provider_idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False)
    provider_session_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    provider_checkout_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_checkout_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    succeeded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    order: Mapped[Order] = relationship(back_populates="payments")

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'succeeded', 'failed', 'expired')",
            name="status_allowed",
        ),
        CheckConstraint(
            "provider IN ('stripe_test', 'demo')",
            name="provider_allowed",
        ),
        CheckConstraint(
            "provider_idempotency_key ~ '[^[:space:]]'",
            name="provider_idempotency_key_not_blank",
        ),
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
        CheckConstraint(
            "(provider_session_id IS NULL "
            "AND provider_checkout_url IS NULL "
            "AND provider_checkout_expires_at IS NULL) OR "
            "(provider_session_id IS NOT NULL "
            "AND provider_checkout_url IS NOT NULL "
            "AND provider_checkout_expires_at IS NOT NULL)",
            name="checkout_session_fields_consistent",
        ),
        CheckConstraint(
            "(status = 'succeeded' AND succeeded_at IS NOT NULL) OR "
            "(status IN ('pending', 'failed', 'expired') "
            "AND succeeded_at IS NULL)",
            name="succeeded_at_status_consistent",
        ),
        UniqueConstraint(
            "order_id",
            "request_idempotency_key",
            name="uq_payments_order_id_request_idempotency_key",
        ),
        UniqueConstraint(
            "provider",
            "provider_idempotency_key",
            name="uq_payments_provider_provider_idempotency_key",
        ),
        UniqueConstraint(
            "provider",
            "provider_session_id",
            name="uq_payments_provider_provider_session_id",
        ),
        Index(
            "ix_payments_order_pending_unique",
            "order_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
        Index(
            "ix_payments_order_succeeded_unique",
            "order_id",
            unique=True,
            postgresql_where=text("status = 'succeeded'"),
        ),
        Index(
            "ix_payments_order_created_at_id",
            "order_id",
            "created_at",
            "id",
        ),
        Index(
            "ix_payments_succeeded_at_id",
            "succeeded_at",
            "id",
            postgresql_where=text("status = 'succeeded'"),
        ),
    )


class StripeEvent(Base):
    """Represent one durable receipt for an in-scope Stripe event."""

    __tablename__ = "stripe_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, nullable=False
    )
    stripe_event_id: Mapped[str] = mapped_column(String(255), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    livemode: Mapped[bool] = mapped_column(Boolean, nullable=False)
    stripe_created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    stripe_checkout_session_id: Mapped[str] = mapped_column(String(255), nullable=False)
    payment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("payments.id", ondelete="RESTRICT"),
        nullable=True,
    )
    processing_result: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "event_type IN ("
            "'checkout.session.completed', "
            "'checkout.session.async_payment_succeeded', "
            "'checkout.session.async_payment_failed', "
            "'checkout.session.expired'"
            ")",
            name="event_type_allowed",
        ),
        CheckConstraint(
            "processing_result IN ("
            "'transitioned', "
            "'awaiting_async_payment', "
            "'already_applied', "
            "'reconciliation_required'"
            ")",
            name="processing_result_allowed",
        ),
        CheckConstraint(
            "char_length(btrim(stripe_event_id)) > 0",
            name="stripe_event_id_not_blank",
        ),
        CheckConstraint(
            "char_length(btrim(stripe_checkout_session_id)) > 0",
            name="checkout_session_id_not_blank",
        ),
        UniqueConstraint(
            "stripe_event_id",
            name="uq_stripe_events_stripe_event_id",
        ),
        Index(
            "ix_stripe_events_payment_created_at_id",
            "payment_id",
            "stripe_created_at",
            "id",
        ),
        Index(
            "ix_stripe_events_session_created_at_id",
            "stripe_checkout_session_id",
            "stripe_created_at",
            "id",
        ),
    )
