"""Integration tests for authenticated administrator menu management."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable, Generator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import AdminUser
from app.auth.tokens import AdminTokenService
from app.categories.models import Category
from app.core.config import Settings
from app.database.session import create_session_factory
from app.main import create_app
from app.menu import admin_service
from app.menu.admin_schemas import (
    AdminCategoryUpdateRequest,
    AdminMenuItemUpdateRequest,
)
from app.menu.admin_service import (
    update_admin_category,
    update_admin_menu_item,
)
from app.menu.models import MenuItem
from app.orders.access import generate_public_order_number
from app.orders.models import Order, OrderItem, OrderStatusHistory
from app.orders.quoting import (
    MenuItemNotFoundError,
    MenuItemUnavailableError,
    quote_order,
)
from app.orders.schemas import OrderQuoteItemRequest, OrderQuoteRequest, OrderType
from app.orders.statuses import OrderStatus
from app.payments.models import Payment, StripeEvent
from app.restaurant_tables.models import RestaurantTable

pytestmark = pytest.mark.integration

CATEGORIES_PATH = "/api/v1/admin/menu/categories"
ITEMS_PATH = "/api/v1/admin/menu/items"
SYNTHETIC_SECRET = "m" * 32
FIXED_NOW = datetime(2026, 8, 11, 12, tzinfo=UTC)


@dataclass(frozen=True)
class AdminMenuClient:
    """Hold an authenticated client and isolated session factory."""

    client: TestClient
    token: str
    session_factory: sessionmaker[Session]

    @property
    def headers(self) -> dict[str, str]:
        """Return the synthetic administrator authorization header."""
        return {"Authorization": f"Bearer {self.token}"}


@pytest.fixture(autouse=True)
def empty_admin_menu_tables(
    test_database_engine: Engine,
) -> Generator[None, None, None]:
    """Keep every menu-management test isolated from persisted records."""

    def clear() -> None:
        with test_database_engine.begin() as connection:
            connection.execute(delete(StripeEvent))
            connection.execute(delete(Payment))
            connection.execute(delete(OrderStatusHistory))
            connection.execute(delete(OrderItem))
            connection.execute(delete(Order))
            connection.execute(delete(RestaurantTable))
            connection.execute(delete(MenuItem))
            connection.execute(delete(Category))
            connection.execute(delete(AdminUser))

    clear()
    try:
        yield
    finally:
        clear()


@pytest.fixture
def api_session_factory(
    test_database_engine: Engine,
) -> sessionmaker[Session]:
    """Create sessions bound only to the isolated integration database."""
    return create_session_factory(test_database_engine)


@pytest.fixture
def token_service() -> AdminTokenService:
    """Create a deterministic synthetic administrator token service."""
    return AdminTokenService(
        SYNTHETIC_SECRET,
        access_token_expire_minutes=30,
        now_provider=lambda: FIXED_NOW,
    )


@pytest.fixture
def admin_client(
    api_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
) -> Generator[AdminMenuClient, None, None]:
    """Run the application with one active synthetic administrator."""
    admin_id = _store_admin(api_session_factory)
    application = _application(api_session_factory, token_service)
    with TestClient(application) as client:
        yield AdminMenuClient(
            client=client,
            token=token_service.create_access_token(admin_id),
            session_factory=api_session_factory,
        )


def _application(
    factory: sessionmaker[Session],
    token_service: AdminTokenService | None,
):
    return create_app(
        settings=Settings(
            _env_file=None,
            database_url=None,
            admin_jwt_secret=None,
        ),
        session_factory=factory,
        admin_token_service=token_service,
    )


def _store_admin(
    factory: sessionmaker[Session],
    *,
    email: str = "menu-admin@example.com",
    is_active: bool = True,
) -> UUID:
    with factory.begin() as session:
        admin = AdminUser(
            email=email,
            password_hash="$argon2id$synthetic-menu-test-hash",
            is_active=is_active,
        )
        session.add(admin)
        session.flush()
        return admin.id


def _category(
    *,
    name: str,
    display_order: int = 0,
    is_active: bool = True,
    category_id: UUID | None = None,
) -> Category:
    return Category(
        id=category_id or uuid4(),
        name=name,
        description=f"{name} description",
        display_order=display_order,
        is_active=is_active,
    )


def _item(
    category: Category,
    *,
    name: str,
    display_order: int = 0,
    is_active: bool = True,
    is_available: bool = True,
    item_id: UUID | None = None,
) -> MenuItem:
    return MenuItem(
        id=item_id or uuid4(),
        category=category,
        name=name,
        description=f"{name} description",
        image_url=None,
        price_amount=9900,
        cost_amount=4500,
        currency="NOK",
        allergens=["milk"],
        display_order=display_order,
        is_active=is_active,
        is_available=is_available,
    )


def _store(
    factory: sessionmaker[Session],
    *records: Category | MenuItem,
) -> None:
    with factory.begin() as session:
        session.add_all(records)
        session.flush()
        session.expunge_all()


def test_all_six_routes_require_admin_bearer(
    api_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
) -> None:
    application = _application(api_session_factory, token_service)
    paths = [
        ("get", CATEGORIES_PATH, None),
        ("post", CATEGORIES_PATH, {"name": "Category"}),
        ("patch", f"{CATEGORIES_PATH}/{uuid4()}", {"name": "Category"}),
        ("get", ITEMS_PATH, None),
        (
            "post",
            ITEMS_PATH,
            {"category_id": str(uuid4()), "name": "Item", "price_amount": 100},
        ),
        ("patch", f"{ITEMS_PATH}/{uuid4()}", {"name": "Item"}),
    ]
    with TestClient(application) as client:
        for method, path, payload in paths:
            response = client.request(method, path, json=payload)
            assert response.status_code == 401
            assert response.json() == {"detail": "Invalid authentication credentials"}
            assert response.headers["WWW-Authenticate"] == "Bearer"


def test_representative_invalid_inactive_and_unavailable_authentication(
    api_session_factory: sessionmaker[Session],
    token_service: AdminTokenService,
) -> None:
    inactive_id = _store_admin(
        api_session_factory,
        email="inactive-menu-admin@example.com",
        is_active=False,
    )
    application = _application(api_session_factory, token_service)
    with TestClient(application) as client:
        invalid = client.get(
            CATEGORIES_PATH,
            headers={"Authorization": "Bearer not-a-jwt"},
        )
        inactive = client.get(
            ITEMS_PATH,
            headers={
                "Authorization": (
                    f"Bearer {token_service.create_access_token(inactive_id)}"
                )
            },
        )
    unavailable_application = _application(api_session_factory, None)
    with TestClient(unavailable_application) as client:
        unavailable = client.get(CATEGORIES_PATH)

    for response in (invalid, inactive):
        assert response.status_code == 401
        assert response.json() == {"detail": "Invalid authentication credentials"}
    assert unavailable.status_code == 503
    assert unavailable.json() == {"detail": "Authentication service unavailable"}


def test_category_list_paginates_orders_and_includes_inactive_rows(
    admin_client: AdminMenuClient,
) -> None:
    first_id = UUID("00000000-0000-0000-0000-000000000001")
    second_id = UUID("00000000-0000-0000-0000-000000000002")
    categories = [
        _category(name="Later", display_order=2),
        _category(name="Second tie", display_order=1, category_id=second_id),
        _category(
            name="First tie",
            display_order=1,
            is_active=False,
            category_id=first_id,
        ),
    ]
    _store(admin_client.session_factory, *categories)

    response = admin_client.client.get(
        f"{CATEGORIES_PATH}?limit=2&offset=0",
        headers=admin_client.headers,
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 3
    assert payload["limit"] == 2
    assert payload["offset"] == 0
    assert [item["id"] for item in payload["items"]] == [
        str(first_id),
        str(second_id),
    ]
    assert payload["items"][0]["is_active"] is False
    assert set(payload["items"][0]) == {
        "id",
        "name",
        "description",
        "display_order",
        "is_active",
        "created_at",
        "updated_at",
    }


def test_category_create_defaults_normalization_conflict_and_no_item_side_effect(
    admin_client: AdminMenuClient,
) -> None:
    created = admin_client.client.post(
        CATEGORIES_PATH,
        json={"name": "  Drinks  "},
        headers=admin_client.headers,
    )
    duplicate = admin_client.client.post(
        CATEGORIES_PATH,
        json={"name": " DRINKS ", "is_active": False},
        headers=admin_client.headers,
    )

    assert created.status_code == 201
    assert created.json()["name"] == "Drinks"
    assert created.json()["description"] is None
    assert created.json()["display_order"] == 0
    assert created.json()["is_active"] is True
    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": "Category already exists"}
    with admin_client.session_factory() as session:
        assert len(session.scalars(select(Category)).all()) == 1
        assert session.scalar(select(MenuItem).limit(1)) is None


def test_category_patch_is_partial_locked_and_does_not_change_child_flags(
    admin_client: AdminMenuClient,
) -> None:
    category = _category(name="Category")
    item = _item(category, name="Item", is_active=True, is_available=False)
    other = _category(name="Other")
    _store(admin_client.session_factory, category, item, other)

    response = admin_client.client.patch(
        f"{CATEGORIES_PATH}/{category.id}",
        json={
            "name": "  Renamed  ",
            "description": None,
            "display_order": 7,
            "is_active": False,
        },
        headers=admin_client.headers,
    )
    conflict = admin_client.client.patch(
        f"{CATEGORIES_PATH}/{category.id}",
        json={"name": " OTHER "},
        headers=admin_client.headers,
    )

    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"
    assert response.json()["description"] is None
    assert response.json()["display_order"] == 7
    assert response.json()["is_active"] is False
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": "Category already exists"}
    with admin_client.session_factory() as session:
        stored = session.get(MenuItem, item.id)
        assert stored is not None
        assert (stored.is_active, stored.is_available) == (True, False)


def test_category_patch_not_found_malformed_empty_and_null_contract(
    admin_client: AdminMenuClient,
) -> None:
    unknown = admin_client.client.patch(
        f"{CATEGORIES_PATH}/{uuid4()}",
        json={"name": "Unknown"},
        headers=admin_client.headers,
    )
    malformed = admin_client.client.patch(
        f"{CATEGORIES_PATH}/not-a-uuid",
        json={"name": "Unknown"},
        headers=admin_client.headers,
    )
    empty = admin_client.client.patch(
        f"{CATEGORIES_PATH}/{uuid4()}",
        json={},
        headers=admin_client.headers,
    )
    null_name = admin_client.client.patch(
        f"{CATEGORIES_PATH}/{uuid4()}",
        json={"name": None},
        headers=admin_client.headers,
    )

    assert unknown.status_code == 404
    assert unknown.json() == {"detail": "Category not found"}
    assert malformed.status_code == 422
    assert empty.status_code == 422
    assert null_name.status_code == 422


def test_item_list_paginates_orders_and_exposes_all_operational_fields(
    admin_client: AdminMenuClient,
) -> None:
    first_category = _category(
        name="First",
        category_id=UUID("00000000-0000-0000-0000-000000000001"),
    )
    second_category = _category(
        name="Second",
        is_active=False,
        category_id=UUID("00000000-0000-0000-0000-000000000002"),
    )
    items = [
        _item(first_category, name="Later", display_order=2, is_active=False),
        _item(
            first_category,
            name="First",
            display_order=1,
            is_available=False,
        ),
        _item(second_category, name="Other", display_order=0),
    ]
    _store(admin_client.session_factory, first_category, second_category, *items)

    response = admin_client.client.get(
        f"{ITEMS_PATH}?limit=2&offset=1",
        headers=admin_client.headers,
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 3
    assert payload["limit"] == 2
    assert payload["offset"] == 1
    assert [item["name"] for item in payload["items"]] == ["Later", "Other"]
    assert set(payload["items"][0]) == {
        "id",
        "category_id",
        "name",
        "description",
        "image_url",
        "price_amount",
        "cost_amount",
        "currency",
        "allergens",
        "display_order",
        "is_active",
        "is_available",
        "created_at",
        "updated_at",
    }
    assert payload["items"][0]["cost_amount"] == 4500


def test_item_create_allows_inactive_category_defaults_and_scoped_names(
    admin_client: AdminMenuClient,
) -> None:
    first = _category(name="Inactive", is_active=False)
    second = _category(name="Second")
    _store(admin_client.session_factory, first, second)
    payload = {
        "category_id": str(first.id),
        "name": "  Coffee  ",
        "price_amount": 4900,
        "allergens": [" milk ", "milk"],
    }
    created = admin_client.client.post(
        ITEMS_PATH,
        json=payload,
        headers=admin_client.headers,
    )
    conflict = admin_client.client.post(
        ITEMS_PATH,
        json=payload | {"name": " COFFEE "},
        headers=admin_client.headers,
    )
    other_category = admin_client.client.post(
        ITEMS_PATH,
        json=payload | {"category_id": str(second.id)},
        headers=admin_client.headers,
    )

    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "Coffee"
    assert body["category_id"] == str(first.id)
    assert body["currency"] == "NOK"
    assert body["allergens"] == ["milk", "milk"]
    assert body["image_url"] is None
    assert body["cost_amount"] is None
    assert body["display_order"] == 0
    assert body["is_active"] is True
    assert body["is_available"] is True
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": "Menu item already exists"}
    assert other_category.status_code == 201


def test_item_create_unknown_category_and_validation_contract(
    admin_client: AdminMenuClient,
) -> None:
    unknown = admin_client.client.post(
        ITEMS_PATH,
        json={
            "category_id": str(uuid4()),
            "name": "Item",
            "price_amount": 100,
        },
        headers=admin_client.headers,
    )
    assert unknown.status_code == 404
    assert unknown.json() == {"detail": "Category not found"}

    invalid_values = [
        {"price_amount": 0},
        {"price_amount": True},
        {"price_amount": "100"},
        {"price_amount": 100, "cost_amount": -1},
        {"price_amount": 100, "currency": "nok"},
        {"price_amount": 100, "allergens": [""]},
        {"price_amount": 100, "unexpected": True},
    ]
    for changed in invalid_values:
        response = admin_client.client.post(
            ITEMS_PATH,
            json={
                "category_id": str(uuid4()),
                "name": "Item",
                **changed,
            },
            headers=admin_client.headers,
        )
        assert response.status_code == 422


def test_item_patch_updates_every_field_reassigns_and_preserves_unspecified_values(
    admin_client: AdminMenuClient,
) -> None:
    original = _category(name="Original")
    target = _category(name="Target", is_active=False)
    item = _item(original, name="Item")
    _store(admin_client.session_factory, original, target, item)

    response = admin_client.client.patch(
        f"{ITEMS_PATH}/{item.id}",
        json={
            "category_id": str(target.id),
            "name": "  Updated  ",
            "description": None,
            "image_url": "https://example.invalid/item.png",
            "price_amount": 12000,
            "cost_amount": None,
            "currency": "EUR",
            "allergens": [" gluten "],
            "display_order": 9,
            "is_active": False,
            "is_available": False,
        },
        headers=admin_client.headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert body | {} == body
    assert body["category_id"] == str(target.id)
    assert body["name"] == "Updated"
    assert body["description"] is None
    assert body["image_url"] == "https://example.invalid/item.png"
    assert body["price_amount"] == 12000
    assert body["cost_amount"] is None
    assert body["currency"] == "EUR"
    assert body["allergens"] == ["gluten"]
    assert body["display_order"] == 9
    assert body["is_active"] is False
    assert body["is_available"] is False

    partial = admin_client.client.patch(
        f"{ITEMS_PATH}/{item.id}",
        json={"is_active": True},
        headers=admin_client.headers,
    )
    assert partial.status_code == 200
    assert partial.json()["is_active"] is True
    assert partial.json()["is_available"] is False
    assert partial.json()["price_amount"] == 12000


def test_item_patch_not_found_category_conflict_empty_and_malformed_contract(
    admin_client: AdminMenuClient,
) -> None:
    category = _category(name="Category")
    first = _item(category, name="First")
    second = _item(category, name="Second")
    _store(admin_client.session_factory, category, first, second)

    unknown_item = admin_client.client.patch(
        f"{ITEMS_PATH}/{uuid4()}",
        json={"name": "Unknown"},
        headers=admin_client.headers,
    )
    unknown_category = admin_client.client.patch(
        f"{ITEMS_PATH}/{first.id}",
        json={"category_id": str(uuid4())},
        headers=admin_client.headers,
    )
    conflict = admin_client.client.patch(
        f"{ITEMS_PATH}/{first.id}",
        json={"name": " SECOND "},
        headers=admin_client.headers,
    )
    empty = admin_client.client.patch(
        f"{ITEMS_PATH}/{first.id}",
        json={},
        headers=admin_client.headers,
    )
    malformed = admin_client.client.patch(
        f"{ITEMS_PATH}/not-a-uuid",
        json={"name": "Name"},
        headers=admin_client.headers,
    )

    assert unknown_item.status_code == 404
    assert unknown_item.json() == {"detail": "Menu item not found"}
    assert unknown_category.status_code == 404
    assert unknown_category.json() == {"detail": "Category not found"}
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": "Menu item already exists"}
    assert empty.status_code == 422
    assert malformed.status_code == 422


def test_admin_mutations_preserve_public_visibility_and_quote_rules(
    admin_client: AdminMenuClient,
) -> None:
    category = _category(name="Public")
    item = _item(category, name="Public item")
    _store(admin_client.session_factory, category, item)
    request = OrderQuoteRequest(
        items=[OrderQuoteItemRequest(menu_item_id=item.id, quantity=1)]
    )

    assert admin_client.client.get("/api/v1/menu").status_code == 200
    assert admin_client.client.get(f"/api/v1/menu/items/{item.id}").status_code == 200
    with admin_client.session_factory() as session:
        assert quote_order(session, request).total_amount == 9900

    unavailable = admin_client.client.patch(
        f"{ITEMS_PATH}/{item.id}",
        json={"is_available": False},
        headers=admin_client.headers,
    )
    assert unavailable.status_code == 200
    default_menu = admin_client.client.get("/api/v1/menu").json()
    available_menu = admin_client.client.get("/api/v1/menu?available_only=true").json()
    assert default_menu["categories"][0]["items"][0]["is_available"] is False
    assert available_menu == {"categories": []}
    with admin_client.session_factory() as session:
        with pytest.raises(MenuItemUnavailableError):
            quote_order(session, request)

    inactive_item = admin_client.client.patch(
        f"{ITEMS_PATH}/{item.id}",
        json={"is_active": False},
        headers=admin_client.headers,
    )
    assert inactive_item.status_code == 200
    assert admin_client.client.get(f"/api/v1/menu/items/{item.id}").status_code == 404
    with admin_client.session_factory() as session:
        with pytest.raises(MenuItemNotFoundError):
            quote_order(session, request)

    admin_client.client.patch(
        f"{ITEMS_PATH}/{item.id}",
        json={"is_active": True, "is_available": True},
        headers=admin_client.headers,
    )
    admin_client.client.patch(
        f"{CATEGORIES_PATH}/{category.id}",
        json={"is_active": False},
        headers=admin_client.headers,
    )
    assert admin_client.client.get("/api/v1/menu").json() == {"categories": []}
    with admin_client.session_factory() as session:
        stored = session.get(MenuItem, item.id)
        assert stored is not None
        assert (stored.is_active, stored.is_available) == (True, True)
        with pytest.raises(MenuItemNotFoundError):
            quote_order(session, request)

    admin_client.client.patch(
        f"{CATEGORIES_PATH}/{category.id}",
        json={"is_active": True},
        headers=admin_client.headers,
    )
    assert admin_client.client.get(f"/api/v1/menu/items/{item.id}").status_code == 200
    public_item = admin_client.client.get(f"/api/v1/menu/items/{item.id}").json()
    assert "cost_amount" not in public_item


def test_admin_menu_mutations_do_not_change_historical_order_item_snapshot(
    admin_client: AdminMenuClient,
) -> None:
    category = _category(name="Current category")
    item = _item(category, name="Current item")
    _store(admin_client.session_factory, category, item)
    with admin_client.session_factory.begin() as session:
        order = Order(
            public_order_number=generate_public_order_number(),
            order_access_token_hash=uuid.uuid4().hex + uuid.uuid4().hex,
            order_type=OrderType.TAKEAWAY.value,
            status=OrderStatus.CREATED.value,
            currency="NOK",
            subtotal_amount=9900,
            total_amount=9900,
        )
        session.add(order)
        session.flush()
        snapshot = OrderItem(
            order=order,
            menu_item_id=item.id,
            position=0,
            category_name_snapshot="Historical category",
            name_snapshot="Historical item",
            quantity=1,
            unit_price_amount=7000,
            unit_cost_amount=3000,
            tax_rate_bps_snapshot=None,
            discount_amount_snapshot=0,
            line_total_amount=7000,
        )
        session.add(snapshot)
        session.flush()
        order_number = order.public_order_number
        snapshot_id = snapshot.id

    admin_client.client.patch(
        f"{CATEGORIES_PATH}/{category.id}",
        json={"name": "Renamed category", "is_active": False},
        headers=admin_client.headers,
    )
    admin_client.client.patch(
        f"{ITEMS_PATH}/{item.id}",
        json={
            "name": "Renamed item",
            "price_amount": 12000,
            "cost_amount": 8000,
            "is_active": False,
        },
        headers=admin_client.headers,
    )

    detail = admin_client.client.get(
        f"/api/v1/admin/orders/{order_number}",
        headers=admin_client.headers,
    )
    assert detail.status_code == 200
    assert detail.json()["items"][0]["category_name"] == "Historical category"
    assert detail.json()["items"][0]["name"] == "Historical item"
    assert detail.json()["items"][0]["unit_price_amount"] == 7000
    assert detail.json()["items"][0]["unit_cost_amount"] == 3000
    with admin_client.session_factory() as session:
        stored = session.get(OrderItem, snapshot_id)
        assert stored is not None
        assert (
            stored.category_name_snapshot,
            stored.name_snapshot,
            stored.unit_price_amount,
            stored.unit_cost_amount,
        ) == ("Historical category", "Historical item", 7000, 3000)


@pytest.mark.parametrize(
    ("service", "model", "path_name"),
    [
        (admin_service.list_admin_categories, Category, "categories"),
        (admin_service.list_admin_menu_items, MenuItem, "menu_items"),
    ],
)
def test_list_services_use_one_count_one_page_select_and_zero_dml(
    api_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    service: Callable[..., object],
    model: type[Category] | type[MenuItem],
    path_name: str,
) -> None:
    category = _category(name="Category")
    item = _item(category, name="Item")
    _store(api_session_factory, category, item)
    statements: list[str] = []

    def capture(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture)
    try:
        with api_session_factory() as session:
            service(session, limit=50, offset=0)
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    assert model in {Category, MenuItem}
    assert path_name in {"categories", "menu_items"}
    verbs = [
        statement.lstrip().split(maxsplit=1)[0].upper() for statement in statements
    ]
    assert verbs == ["SELECT", "SELECT"]
    assert all("DELETE" not in statement.upper() for statement in statements)


def test_category_and_item_patch_use_target_row_locks_without_delete(
    api_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
) -> None:
    category = _category(name="Category")
    item = _item(category, name="Item")
    _store(api_session_factory, category, item)
    statements: list[str] = []

    def capture(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(test_database_engine, "before_cursor_execute", capture)
    try:
        with api_session_factory() as session:
            update_admin_category(
                session,
                category_id=category.id,
                request=AdminCategoryUpdateRequest(description="Updated"),
            )
        with api_session_factory() as session:
            update_admin_menu_item(
                session,
                item_id=item.id,
                request=AdminMenuItemUpdateRequest(is_available=False),
            )
    finally:
        event.remove(test_database_engine, "before_cursor_execute", capture)

    normalized = [" ".join(statement.upper().split()) for statement in statements]
    locked_selects = [
        statement for statement in normalized if "FOR UPDATE" in statement
    ]
    assert len(locked_selects) == 2
    assert any("UPDATE CATEGORIES" in statement for statement in normalized)
    assert any("UPDATE MENU_ITEMS" in statement for statement in normalized)
    assert all("DELETE" not in statement for statement in normalized)
    assert all("ORDERS" not in statement for statement in normalized)


@pytest.mark.parametrize("resource", ["category", "item"])
def test_concurrent_patch_operations_serialize_without_lost_partial_updates(
    api_session_factory: sessionmaker[Session],
    test_database_engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
    resource: str,
) -> None:
    category = _category(name=f"{resource} category")
    item = _item(category, name=f"{resource} item")
    _store(api_session_factory, category, item)
    first_ready = threading.Event()
    second_select_started = threading.Event()
    release_first = threading.Event()
    original_builder = (
        admin_service._build_category_response
        if resource == "category"
        else admin_service._build_menu_item_response
    )

    def pausing_builder(record: Category | MenuItem):
        response = original_builder(record)
        if threading.current_thread().name.startswith("first-update"):
            first_ready.set()
            if not release_first.wait(timeout=10):
                raise RuntimeError("Timed out waiting to release the first update")
        return response

    builder_name = (
        "_build_category_response"
        if resource == "category"
        else "_build_menu_item_response"
    )
    monkeypatch.setattr(admin_service, builder_name, pausing_builder)

    def capture_second_select(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        if (
            threading.current_thread().name.startswith("second-update")
            and "FOR UPDATE" in statement.upper()
        ):
            second_select_started.set()

    def first_update() -> None:
        with api_session_factory() as session:
            if resource == "category":
                update_admin_category(
                    session,
                    category_id=category.id,
                    request=AdminCategoryUpdateRequest(description="First committed"),
                )
            else:
                update_admin_menu_item(
                    session,
                    item_id=item.id,
                    request=AdminMenuItemUpdateRequest(description="First committed"),
                )

    def second_update() -> None:
        with api_session_factory() as session:
            if resource == "category":
                update_admin_category(
                    session,
                    category_id=category.id,
                    request=AdminCategoryUpdateRequest(display_order=7),
                )
            else:
                update_admin_menu_item(
                    session,
                    item_id=item.id,
                    request=AdminMenuItemUpdateRequest(is_available=False),
                )

    event.listen(test_database_engine, "before_cursor_execute", capture_second_select)
    try:
        with (
            ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="first-update",
            ) as first_executor,
            ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="second-update",
            ) as second_executor,
        ):
            first_future = first_executor.submit(first_update)
            assert first_ready.wait(timeout=10)
            second_future = second_executor.submit(second_update)
            assert second_select_started.wait(timeout=10)
            release_first.set()
            first_future.result(timeout=10)
            second_future.result(timeout=10)
    finally:
        release_first.set()
        event.remove(
            test_database_engine, "before_cursor_execute", capture_second_select
        )

    with api_session_factory() as session:
        stored = session.get(
            Category if resource == "category" else MenuItem,
            category.id if resource == "category" else item.id,
        )
        assert stored is not None
        assert stored.description == "First committed"
        if resource == "category":
            assert stored.display_order == 7
        else:
            assert stored.is_available is False
