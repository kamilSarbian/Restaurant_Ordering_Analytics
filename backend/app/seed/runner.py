"""Transactional PostgreSQL runner for the canonical demonstration menu."""

from dataclasses import dataclass

from sqlalchemy import func, or_, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, sessionmaker

from app.categories.models import Category
from app.menu.models import MenuItem
from app.seed.data import CATEGORY_SEEDS, MENU_ITEM_SEEDS


class SeedConflictError(Exception):
    """Report an unrelated record that conflicts with a canonical seed name."""


@dataclass(frozen=True, slots=True)
class SeedResult:
    """Summarize the number of canonical records processed by the seed."""

    categories_processed: int
    menu_items_processed: int


def _normalized_name(value: str) -> str:
    return value.strip().lower()


def _preflight_category_conflicts(session: Session) -> None:
    canonical_by_name = {_normalized_name(seed.name): seed for seed in CATEGORY_SEEDS}
    rows = session.execute(
        select(Category.id, Category.name).where(
            func.lower(func.btrim(Category.name)).in_(canonical_by_name)
        )
    )
    for category_id, category_name in rows:
        canonical = canonical_by_name[_normalized_name(category_name)]
        if category_id != canonical.id:
            raise SeedConflictError(
                f"Category name conflicts with seed data: {canonical.name}."
            )


def _preflight_menu_item_conflicts(session: Session) -> None:
    canonical_by_identity = {
        (seed.category_id, _normalized_name(seed.name)): seed
        for seed in MENU_ITEM_SEEDS
    }
    rows = session.execute(
        select(MenuItem.id, MenuItem.category_id, MenuItem.name).where(
            tuple_(
                MenuItem.category_id,
                func.lower(func.btrim(MenuItem.name)),
            ).in_(canonical_by_identity)
        )
    )
    for menu_item_id, category_id, menu_item_name in rows:
        canonical = canonical_by_identity[
            (category_id, _normalized_name(menu_item_name))
        ]
        if menu_item_id != canonical.id:
            raise SeedConflictError(
                f"Menu item name conflicts with seed data: {canonical.name}."
            )


def _upsert_categories(session: Session) -> None:
    table = Category.__table__
    statement = insert(table).values(
        [
            {
                "id": seed.id,
                "name": seed.name,
                "description": seed.description,
                "display_order": seed.display_order,
                "is_active": seed.is_active,
            }
            for seed in CATEGORY_SEEDS
        ]
    )
    excluded = statement.excluded
    session.execute(
        statement.on_conflict_do_update(
            index_elements=[table.c.id],
            set_={
                "name": excluded.name,
                "description": excluded.description,
                "display_order": excluded.display_order,
                "is_active": excluded.is_active,
                "updated_at": func.now(),
            },
            where=or_(
                table.c.name.is_distinct_from(excluded.name),
                table.c.description.is_distinct_from(excluded.description),
                table.c.display_order.is_distinct_from(excluded.display_order),
                table.c.is_active.is_distinct_from(excluded.is_active),
            ),
        )
    )


def _upsert_menu_items(session: Session) -> None:
    table = MenuItem.__table__
    statement = insert(table).values(
        [
            {
                "id": seed.id,
                "category_id": seed.category_id,
                "name": seed.name,
                "description": seed.description,
                "image_url": seed.image_url,
                "price_amount": seed.price_amount,
                "cost_amount": seed.cost_amount,
                "currency": seed.currency,
                "allergens": list(seed.allergens),
                "display_order": seed.display_order,
                "is_active": seed.is_active,
                "is_available": seed.is_available,
            }
            for seed in MENU_ITEM_SEEDS
        ]
    )
    excluded = statement.excluded
    session.execute(
        statement.on_conflict_do_update(
            index_elements=[table.c.id],
            set_={
                "category_id": excluded.category_id,
                "name": excluded.name,
                "description": excluded.description,
                "image_url": excluded.image_url,
                "price_amount": excluded.price_amount,
                "cost_amount": excluded.cost_amount,
                "currency": excluded.currency,
                "allergens": excluded.allergens,
                "display_order": excluded.display_order,
                "is_active": excluded.is_active,
                "is_available": excluded.is_available,
                "updated_at": func.now(),
            },
            where=or_(
                table.c.category_id.is_distinct_from(excluded.category_id),
                table.c.name.is_distinct_from(excluded.name),
                table.c.description.is_distinct_from(excluded.description),
                table.c.image_url.is_distinct_from(excluded.image_url),
                table.c.price_amount.is_distinct_from(excluded.price_amount),
                table.c.cost_amount.is_distinct_from(excluded.cost_amount),
                table.c.currency.is_distinct_from(excluded.currency),
                table.c.allergens.is_distinct_from(excluded.allergens),
                table.c.display_order.is_distinct_from(excluded.display_order),
                table.c.is_active.is_distinct_from(excluded.is_active),
                table.c.is_available.is_distinct_from(excluded.is_available),
            ),
        )
    )


def seed_menu_data(session_factory: sessionmaker[Session]) -> SeedResult:
    """Seed the canonical menu in one transaction using the supplied factory."""
    with session_factory.begin() as session:
        _preflight_category_conflicts(session)
        _preflight_menu_item_conflicts(session)
        _upsert_categories(session)
        _upsert_menu_items(session)

    return SeedResult(
        categories_processed=len(CATEGORY_SEEDS),
        menu_items_processed=len(MENU_ITEM_SEEDS),
    )


__all__ = ["SeedConflictError", "SeedResult", "seed_menu_data"]
