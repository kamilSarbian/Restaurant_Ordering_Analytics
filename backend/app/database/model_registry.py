"""Register all SQLAlchemy models in the shared metadata."""

from app.auth.models import AdminUser
from app.categories.models import Category
from app.database.base import Base
from app.menu.models import MenuItem
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.payments.models import Payment, StripeEvent
from app.restaurant_tables.models import RestaurantTable

metadata = Base.metadata

__all__ = [
    "AdminUser",
    "Category",
    "MenuItem",
    "Order",
    "OrderItem",
    "OrderStatusHistory",
    "Payment",
    "RestaurantTable",
    "StripeEvent",
    "metadata",
]
