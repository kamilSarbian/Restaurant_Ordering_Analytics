"""Public schemas for hosted payment checkout."""

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.orders.schemas import PublicOrderNumber
from app.payments.statuses import PaymentStatus


class CheckoutSessionResponse(BaseModel):
    """Expose the hosted checkout session created for an order."""

    model_config = ConfigDict(extra="forbid", strict=True)

    public_order_number: PublicOrderNumber
    payment_status: PaymentStatus
    checkout_url: str = Field(min_length=1)
    expires_at: AwareDatetime
