"""SQLAlchemy model for restaurant menu items."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.ext.mutable import MutableList
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base

if TYPE_CHECKING:
    from app.categories.models import Category


class MenuItem(Base):
    """Represent a sellable item assigned to one menu category."""

    __tablename__ = "menu_items"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, nullable=False
    )
    category_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("categories.id", ondelete="RESTRICT"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    price_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    cost_amount: Mapped[int | None] = mapped_column(Integer, nullable=True)
    currency: Mapped[str] = mapped_column(
        String(3), default="NOK", server_default=text("'NOK'"), nullable=False
    )
    allergens: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(ARRAY(Text)),
        default=list,
        server_default=text("'{}'::text[]"),
        nullable=False,
    )
    display_order: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0"), nullable=False
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true"), nullable=False
    )
    is_available: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=text("true"), nullable=False
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

    category: Mapped[Category] = relationship(back_populates="menu_items")

    __table_args__ = (
        CheckConstraint(
            "char_length(btrim(name)) > 0",
            name="name_not_blank",
        ),
        CheckConstraint(
            "price_amount > 0",
            name="price_amount_positive",
        ),
        CheckConstraint(
            "cost_amount IS NULL OR cost_amount >= 0",
            name="cost_amount_nonnegative",
        ),
        CheckConstraint(
            "currency ~ '^[A-Z]{3}$'",
            name="currency_format",
        ),
        CheckConstraint(
            "display_order >= 0",
            name="display_order_nonnegative",
        ),
        Index(
            "ix_menu_items_category_name_normalized_unique",
            category_id,
            func.lower(func.btrim(name)),
            unique=True,
        ),
        Index(
            "ix_menu_items_active_category_display_order",
            category_id,
            display_order,
            id,
            postgresql_where=text("is_active IS TRUE"),
        ),
    )
