"""SQLAlchemy model for menu categories."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base

if TYPE_CHECKING:
    from app.menu.models import MenuItem


class Category(Base):
    """Represent a displayable category in the restaurant menu."""

    __tablename__ = "categories"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    display_order: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0"), nullable=False
    )
    is_active: Mapped[bool] = mapped_column(
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

    menu_items: Mapped[list[MenuItem]] = relationship(
        back_populates="category", passive_deletes="all"
    )

    __table_args__ = (
        CheckConstraint(
            "char_length(btrim(name)) > 0",
            name="name_not_blank",
        ),
        CheckConstraint(
            "display_order >= 0",
            name="display_order_nonnegative",
        ),
        Index(
            "ix_categories_name_normalized_unique",
            func.lower(func.btrim(name)),
            unique=True,
        ),
        Index(
            "ix_categories_active_display_order",
            display_order,
            id,
            postgresql_where=text("is_active IS TRUE"),
        ),
    )
