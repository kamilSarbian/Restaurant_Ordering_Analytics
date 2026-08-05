"""Register all SQLAlchemy models in the shared metadata."""

from app.categories.models import Category
from app.database.base import Base
from app.menu.models import MenuItem

metadata = Base.metadata

__all__ = ["Category", "MenuItem", "metadata"]
