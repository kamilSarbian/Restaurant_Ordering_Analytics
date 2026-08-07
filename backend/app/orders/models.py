"""Persistent SQLAlchemy models for the order aggregate."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base
from app.orders.statuses import OrderStatus


class Order(Base):
    """Represent one durable restaurant order and its financial snapshot."""

    __tablename__ = "orders"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, nullable=False
    )
    public_order_number: Mapped[str] = mapped_column(
        String(16), unique=True, nullable=False
    )
    order_access_token_hash: Mapped[str] = mapped_column(
        String(64), unique=True, nullable=False
    )
    order_type: Mapped[str] = mapped_column(String(16), nullable=False)
    table_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("restaurant_tables.id", ondelete="RESTRICT"),
        nullable=True,
    )
    table_number_snapshot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), default=OrderStatus.CREATED.value, nullable=False
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    subtotal_amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    total_amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    items: Mapped[list[OrderItem]] = relationship(
        back_populates="order",
        order_by="OrderItem.position",
        passive_deletes="all",
    )
    status_history: Mapped[list[OrderStatusHistory]] = relationship(
        back_populates="order",
        order_by="OrderStatusHistory.sequence",
        passive_deletes="all",
    )

    __table_args__ = (
        CheckConstraint(
            "status IN ('created', 'accepted', 'preparing', 'ready', "
            "'completed', 'cancelled')",
            name="status_allowed",
        ),
        CheckConstraint(
            "order_type IN ('dine_in', 'takeaway')",
            name="order_type_allowed",
        ),
        CheckConstraint(
            "(order_type = 'takeaway' AND table_id IS NULL "
            "AND table_number_snapshot IS NULL) OR "
            "(order_type = 'dine_in' AND table_id IS NOT NULL "
            "AND table_number_snapshot IS NOT NULL "
            "AND table_number_snapshot > 0)",
            name="order_type_table_consistency",
        ),
        CheckConstraint(
            "table_number_snapshot IS NULL OR table_number_snapshot > 0",
            name="table_number_snapshot_positive",
        ),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="currency_format"),
        CheckConstraint("subtotal_amount > 0", name="subtotal_amount_positive"),
        CheckConstraint("total_amount > 0", name="total_amount_positive"),
        CheckConstraint(
            "public_order_number ~ " "'^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$'",
            name="public_order_number_format",
        ),
        CheckConstraint(
            "order_access_token_hash ~ '^[0-9a-f]{64}$'",
            name="access_token_hash_format",
        ),
    )


class OrderItem(Base):
    """Store one immutable product and money snapshot within an order."""

    __tablename__ = "order_items"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, nullable=False
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("orders.id", ondelete="RESTRICT"),
        nullable=False,
    )
    menu_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("menu_items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    category_name_snapshot: Mapped[str] = mapped_column(String(120), nullable=False)
    name_snapshot: Mapped[str] = mapped_column(String(120), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_cost_amount: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tax_rate_bps_snapshot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    discount_amount_snapshot: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default=text("0"), nullable=False
    )
    line_total_amount: Mapped[int] = mapped_column(BigInteger, nullable=False)

    order: Mapped[Order] = relationship(back_populates="items")

    __table_args__ = (
        CheckConstraint(
            "char_length(btrim(category_name_snapshot)) > 0",
            name="category_name_snapshot_not_blank",
        ),
        CheckConstraint(
            "char_length(btrim(name_snapshot)) > 0",
            name="name_snapshot_not_blank",
        ),
        CheckConstraint("quantity BETWEEN 1 AND 99", name="quantity_range"),
        CheckConstraint("unit_price_amount > 0", name="unit_price_amount_positive"),
        CheckConstraint(
            "unit_cost_amount IS NULL OR unit_cost_amount >= 0",
            name="unit_cost_amount_nonnegative",
        ),
        CheckConstraint(
            "tax_rate_bps_snapshot IS NULL OR "
            "tax_rate_bps_snapshot BETWEEN 0 AND 10000",
            name="tax_rate_bps_snapshot_range",
        ),
        CheckConstraint(
            "discount_amount_snapshot >= 0",
            name="discount_amount_snapshot_nonnegative",
        ),
        CheckConstraint("line_total_amount > 0", name="line_total_amount_positive"),
        CheckConstraint("position >= 0", name="position_nonnegative"),
        CheckConstraint(
            "line_total_amount = CAST(unit_price_amount AS BIGINT) "
            "* CAST(quantity AS BIGINT)",
            name="line_total_matches_quantity",
        ),
        UniqueConstraint(
            "order_id",
            "position",
            name="uq_order_items_order_id_position",
        ),
        UniqueConstraint(
            "order_id",
            "menu_item_id",
            name="uq_order_items_order_id_menu_item_id",
        ),
    )


class OrderStatusHistory(Base):
    """Record one ordered change in an order's fulfilment status."""

    __tablename__ = "order_status_history"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, nullable=False
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("orders.id", ondelete="RESTRICT"),
        nullable=False,
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    new_status: Mapped[str] = mapped_column(String(16), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    order: Mapped[Order] = relationship(back_populates="status_history")

    __table_args__ = (
        CheckConstraint("sequence >= 0", name="sequence_nonnegative"),
        CheckConstraint(
            "previous_status IS NULL OR previous_status IN "
            "('created', 'accepted', 'preparing', 'ready', 'completed', "
            "'cancelled')",
            name="previous_status_allowed",
        ),
        CheckConstraint(
            "new_status IN ('created', 'accepted', 'preparing', 'ready', "
            "'completed', 'cancelled')",
            name="new_status_allowed",
        ),
        CheckConstraint(
            "(sequence = 0 AND previous_status IS NULL "
            "AND new_status = 'created') OR "
            "(sequence > 0 AND previous_status IS NOT NULL)",
            name="initial_entry",
        ),
        UniqueConstraint(
            "order_id",
            "sequence",
            name="uq_order_status_history_order_id_sequence",
        ),
    )
