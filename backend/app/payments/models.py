"""Persistent SQLAlchemy model for payment attempts."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
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
    stripe_idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False)
    stripe_checkout_session_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    stripe_checkout_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    stripe_checkout_expires_at: Mapped[datetime | None] = mapped_column(
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
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
        CheckConstraint(
            "(stripe_checkout_session_id IS NULL "
            "AND stripe_checkout_url IS NULL "
            "AND stripe_checkout_expires_at IS NULL) OR "
            "(stripe_checkout_session_id IS NOT NULL "
            "AND stripe_checkout_url IS NOT NULL "
            "AND stripe_checkout_expires_at IS NOT NULL)",
            name="checkout_session_fields_consistent",
        ),
        UniqueConstraint(
            "order_id",
            "request_idempotency_key",
            name="uq_payments_order_id_request_idempotency_key",
        ),
        UniqueConstraint(
            "stripe_idempotency_key",
            name="uq_payments_stripe_idempotency_key",
        ),
        UniqueConstraint(
            "stripe_checkout_session_id",
            name="uq_payments_stripe_checkout_session_id",
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
    )
