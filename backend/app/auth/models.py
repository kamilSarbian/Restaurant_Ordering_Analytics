"""Persistent registered user identity model."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.auth.roles import UserRole
from app.database.base import Base


class User(Base):
    """Represent one persisted registered user identity."""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, nullable=False
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(
            UserRole,
            native_enum=False,
            create_constraint=False,
            length=11,
            values_callable=lambda role_type: [role.value for role in role_type],
        ),
        nullable=False,
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

    __table_args__ = (
        CheckConstraint(
            "btrim(email) <> ''",
            name="email_not_blank",
        ),
        CheckConstraint(
            "email = lower(btrim(email))",
            name="email_normalized",
        ),
        CheckConstraint(
            "btrim(password_hash) <> ''",
            name="password_hash_not_blank",
        ),
        CheckConstraint(
            "role IN ('customer', 'admin', 'super_admin')",
            name="role_allowed",
        ),
        UniqueConstraint("email", name="uq_users_email"),
    )


__all__ = ["User"]
