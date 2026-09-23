"""Compatibility exports for the canonical menu catalog."""

from app import catalog as _catalog

CATEGORY_BURGERS_ID = _catalog.CATEGORY_BURGERS_ID
CATEGORY_DESSERTS_ID = _catalog.CATEGORY_DESSERTS_ID
CATEGORY_DRINKS_ID = _catalog.CATEGORY_DRINKS_ID
CATEGORY_MAIN_COURSES_ID = _catalog.CATEGORY_MAIN_COURSES_ID
CATEGORY_SEEDS = _catalog.CATEGORY_SEEDS
CATEGORY_STARTERS_ID = _catalog.CATEGORY_STARTERS_ID
MENU_ITEM_SEEDS = _catalog.MENU_ITEM_SEEDS
SEED_CATEGORY_IDS = _catalog.SEED_CATEGORY_IDS
SEED_MENU_ITEM_IDS = _catalog.SEED_MENU_ITEM_IDS
CategorySeed = _catalog.CategorySeed
MenuItemSeed = _catalog.MenuItemSeed

__all__ = [
    "CATEGORY_SEEDS",
    "MENU_ITEM_SEEDS",
    "SEED_CATEGORY_IDS",
    "SEED_MENU_ITEM_IDS",
    "CategorySeed",
    "MenuItemSeed",
]
