"""Order data-origin domain values."""

from enum import StrEnum


class OrderDataOrigin(StrEnum):
    """Identify whether an order is live or portfolio-demo data."""

    LIVE = "live"
    PORTFOLIO_SEED = "portfolio_seed"
    PORTFOLIO_RUNTIME = "portfolio_runtime"
