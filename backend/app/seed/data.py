"""Immutable canonical data for the local demonstration menu seed."""

from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True, slots=True)
class CategorySeed:
    """Describe one canonical category owned by the demonstration seed."""

    key: str
    id: UUID
    name: str
    description: str
    display_order: int
    is_active: bool


@dataclass(frozen=True, slots=True)
class MenuItemSeed:
    """Describe one canonical menu item owned by the demonstration seed."""

    id: UUID
    category_id: UUID
    name: str
    description: str
    image_url: str | None
    price_amount: int
    cost_amount: int | None
    currency: str
    allergens: tuple[str, ...]
    display_order: int
    is_active: bool
    is_available: bool


CATEGORY_STARTERS_ID = UUID("7676b28c-7d41-4582-b8b5-e66c5d4be7f1")
CATEGORY_MAIN_COURSES_ID = UUID("b23ede57-9751-40ea-a3bd-b89bf7cf2e88")
CATEGORY_BURGERS_ID = UUID("688dcf82-8b8b-4e79-ad51-4079c9877e53")
CATEGORY_DESSERTS_ID = UUID("c6396579-544d-48fc-8fdc-9d9d1383f695")
CATEGORY_DRINKS_ID = UUID("5a6a1cd7-d1a7-4cae-a672-e5322ad1f2cf")

CATEGORY_SEEDS: tuple[CategorySeed, ...] = (
    CategorySeed(
        key="category_starters",
        id=CATEGORY_STARTERS_ID,
        name="Starters",
        description="Small plates to begin the meal.",
        display_order=0,
        is_active=True,
    ),
    CategorySeed(
        key="category_main_courses",
        id=CATEGORY_MAIN_COURSES_ID,
        name="Main Courses",
        description="Seasonal Norwegian-inspired main dishes.",
        display_order=1,
        is_active=True,
    ),
    CategorySeed(
        key="category_burgers",
        id=CATEGORY_BURGERS_ID,
        name="Burgers",
        description="Burgers served with oven-roasted potatoes.",
        display_order=2,
        is_active=True,
    ),
    CategorySeed(
        key="category_desserts",
        id=CATEGORY_DESSERTS_ID,
        name="Desserts",
        description="House-made desserts and sweet finishes.",
        display_order=3,
        is_active=True,
    ),
    CategorySeed(
        key="category_drinks",
        id=CATEGORY_DRINKS_ID,
        name="Drinks",
        description="Alcohol-free cold drinks.",
        display_order=4,
        is_active=True,
    ),
)

MENU_ITEM_SEEDS: tuple[MenuItemSeed, ...] = (
    MenuItemSeed(
        id=UUID("372b82fc-dd0c-465e-ae9a-7b585d03f7c7"),
        category_id=CATEGORY_STARTERS_ID,
        name="Roasted Root Vegetable Soup",
        description="Carrot, parsnip and celeriac soup with herb oil.",
        image_url=None,
        price_amount=10900,
        cost_amount=3200,
        currency="NOK",
        allergens=("celery",),
        display_order=0,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("9a5225fd-c749-4d26-99d6-965267b0ce26"),
        category_id=CATEGORY_STARTERS_ID,
        name="Smoked Salmon Toast",
        description="Rye toast with smoked salmon, dill cream and pickled cucumber.",
        image_url=None,
        price_amount=14900,
        cost_amount=6100,
        currency="NOK",
        allergens=("gluten", "milk", "fish"),
        display_order=1,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("90bec893-ece6-40bb-886e-45e1a640f980"),
        category_id=CATEGORY_STARTERS_ID,
        name="Crispy Cauliflower",
        description="Roasted cauliflower with mustard mayonnaise and sesame.",
        image_url=None,
        price_amount=12900,
        cost_amount=3600,
        currency="NOK",
        allergens=("mustard", "egg", "sesame"),
        display_order=2,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("e3fd81c3-0fe6-4e7a-8e1d-2fdf413222ff"),
        category_id=CATEGORY_MAIN_COURSES_ID,
        name="Pan-Seared Cod",
        description="Cod with potato purée, seasonal greens and herb butter.",
        image_url=None,
        price_amount=28900,
        cost_amount=12100,
        currency="NOK",
        allergens=("fish", "milk"),
        display_order=0,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("f870c8df-510e-43a4-8b69-e8b6d5e5db2c"),
        category_id=CATEGORY_MAIN_COURSES_ID,
        name="Nordic Chicken Plate",
        description="Roasted chicken with potatoes, cabbage and mustard sauce.",
        image_url=None,
        price_amount=25900,
        cost_amount=9800,
        currency="NOK",
        allergens=("milk", "mustard"),
        display_order=1,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("a10c4ba3-57a3-43da-8be7-c2d52ab1e7fa"),
        category_id=CATEGORY_MAIN_COURSES_ID,
        name="Mushroom Barley Bowl",
        description="Pearl barley with mushrooms, kale and herb broth.",
        image_url=None,
        price_amount=21900,
        cost_amount=None,
        currency="NOK",
        allergens=("gluten", "celery"),
        display_order=2,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("9933957b-7f5d-47d8-84c3-ba8ad21b2d8c"),
        category_id=CATEGORY_BURGERS_ID,
        name="Classic Beef Burger",
        description="Beef patty, cheddar, pickles, lettuce and mustard mayonnaise.",
        image_url=None,
        price_amount=22900,
        cost_amount=8700,
        currency="NOK",
        allergens=("gluten", "milk", "egg", "mustard"),
        display_order=0,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("34157d9d-2123-4e75-acde-4f513da73bcb"),
        category_id=CATEGORY_BURGERS_ID,
        name="Fjord Fish Burger",
        description="Crispy white fish, cabbage slaw and dill mayonnaise.",
        image_url=None,
        price_amount=23900,
        cost_amount=9400,
        currency="NOK",
        allergens=("gluten", "fish", "egg", "mustard"),
        display_order=1,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("e7aafb70-8bbd-4280-bdba-bd503dc884ac"),
        category_id=CATEGORY_BURGERS_ID,
        name="Plant Burger",
        description="Plant-based patty, tomato, pickles and mustard dressing.",
        image_url=None,
        price_amount=21900,
        cost_amount=7600,
        currency="NOK",
        allergens=("gluten", "soy", "mustard"),
        display_order=2,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("95abd9ff-dea5-48fa-aa81-0632fb5caef7"),
        category_id=CATEGORY_DESSERTS_ID,
        name="Warm Apple Cake",
        description="Spiced apple cake with vanilla cream.",
        image_url=None,
        price_amount=11900,
        cost_amount=3200,
        currency="NOK",
        allergens=("gluten", "milk", "egg"),
        display_order=0,
        is_active=True,
        is_available=False,
    ),
    MenuItemSeed(
        id=UUID("c0ec6110-60ab-49bf-bc6f-13eda579fb1a"),
        category_id=CATEGORY_DESSERTS_ID,
        name="Dark Chocolate Mousse",
        description="Dark chocolate mousse with berry compote.",
        image_url=None,
        price_amount=12900,
        cost_amount=3900,
        currency="NOK",
        allergens=("milk", "egg"),
        display_order=1,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("f6448f8c-db21-4096-903a-facafc5a729c"),
        category_id=CATEGORY_DESSERTS_ID,
        name="Vanilla Panna Cotta",
        description="Vanilla panna cotta with cloudberry sauce.",
        image_url=None,
        price_amount=11900,
        cost_amount=3400,
        currency="NOK",
        allergens=("milk",),
        display_order=2,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("c496b9cc-268c-4549-9e36-e8225e57561f"),
        category_id=CATEGORY_DRINKS_ID,
        name="Cloudberry Spritz",
        description="Cloudberry, lemon and sparkling water.",
        image_url=None,
        price_amount=7900,
        cost_amount=1900,
        currency="NOK",
        allergens=(),
        display_order=0,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("99655656-bab2-4844-8557-6d73d1d4c07a"),
        category_id=CATEGORY_DRINKS_ID,
        name="Norwegian Apple Juice",
        description="Cold-pressed Norwegian apple juice.",
        image_url=None,
        price_amount=6900,
        cost_amount=1600,
        currency="NOK",
        allergens=(),
        display_order=1,
        is_active=True,
        is_available=True,
    ),
    MenuItemSeed(
        id=UUID("a80988ed-27ae-4470-a768-25109a16963a"),
        category_id=CATEGORY_DRINKS_ID,
        name="Sparkling Water",
        description="Chilled sparkling mineral water.",
        image_url=None,
        price_amount=4900,
        cost_amount=1100,
        currency="NOK",
        allergens=(),
        display_order=2,
        is_active=True,
        is_available=True,
    ),
)

SEED_CATEGORY_IDS = frozenset(item.id for item in CATEGORY_SEEDS)
SEED_MENU_ITEM_IDS = frozenset(item.id for item in MENU_ITEM_SEEDS)

__all__ = [
    "CATEGORY_SEEDS",
    "MENU_ITEM_SEEDS",
    "SEED_CATEGORY_IDS",
    "SEED_MENU_ITEM_IDS",
    "CategorySeed",
    "MenuItemSeed",
]
