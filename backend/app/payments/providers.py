"""Payment-provider domain values."""

from enum import StrEnum

from app.orders.origins import OrderDataOrigin


class PaymentProvider(StrEnum):
    """Identify the backend provider responsible for a payment attempt."""

    STRIPE_TEST = "stripe_test"
    DEMO = "demo"


def order_data_origin_for_runtime(
    *,
    portfolio_demo_mode: bool,
    payment_provider: str,
) -> OrderDataOrigin:
    """Return the server-owned order provenance for one validated runtime mode.

    Args:
        portfolio_demo_mode: Whether the application is running as a portfolio demo.
        payment_provider: Configured payment provider from validated application state.

    Returns:
        The provenance assigned to newly created public orders.

    Raises:
        ValueError: If runtime mode and payment provider are not the approved pair.
    """
    provider = PaymentProvider(payment_provider)
    if portfolio_demo_mode is True:
        if provider is not PaymentProvider.DEMO:
            raise ValueError("Portfolio demo mode requires the demo payment provider")
        return OrderDataOrigin.PORTFOLIO_RUNTIME
    if portfolio_demo_mode is not False or provider is not PaymentProvider.STRIPE_TEST:
        raise ValueError("Live runtime requires the Stripe test payment provider")
    return OrderDataOrigin.LIVE
