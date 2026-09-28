"""Public schemas for payment checkout."""

from typing import Annotated, Self
from urllib.parse import urlsplit

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    TypeAdapter,
    ValidationError,
    field_validator,
    model_validator,
)

from app.orders.schemas import PublicOrderNumber
from app.payments.statuses import PaymentStatus

_HTTP_URL_ADAPTER = TypeAdapter(HttpUrl)


class CheckoutSessionResponse(BaseModel):
    """Expose either hosted checkout details or an authoritative terminal result."""

    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        hide_input_in_errors=True,
    )

    public_order_number: PublicOrderNumber
    payment_status: PaymentStatus
    checkout_url: Annotated[str, Field(min_length=1)] | None
    expires_at: AwareDatetime | None

    @field_validator("checkout_url")
    @classmethod
    def _validate_checkout_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if any(character.isspace() for character in value):
            raise ValueError("Checkout URL must not contain whitespace.")
        try:
            _HTTP_URL_ADAPTER.validate_python(value, strict=True)
            parsed = urlsplit(value)
            hostname = parsed.hostname
            username = parsed.username
            password = parsed.password
            _ = parsed.port
        except (ValidationError, ValueError):
            raise ValueError(
                "Checkout URL must be a safe absolute HTTP(S) URL."
            ) from None
        if hostname is None or username is not None or password is not None:
            raise ValueError("Checkout URL must be a safe absolute HTTP(S) URL.")
        scheme = parsed.scheme.lower()
        if scheme == "https":
            return value
        if scheme == "http" and hostname.lower() in {
            "localhost",
            "127.0.0.1",
            "::1",
        }:
            return value
        raise ValueError("Checkout URL must be HTTPS except on a loopback host.")

    @model_validator(mode="after")
    def _validate_status_shape(self) -> Self:
        if self.payment_status is PaymentStatus.PENDING:
            if self.checkout_url is None or self.expires_at is None:
                raise ValueError(
                    "Pending checkout requires both checkout_url and expires_at."
                )
            return self
        if self.checkout_url is not None or self.expires_at is not None:
            raise ValueError(
                "Terminal checkout requires null checkout_url and expires_at."
            )
        return self
