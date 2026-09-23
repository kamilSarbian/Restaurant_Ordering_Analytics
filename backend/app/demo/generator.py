"""Pure deterministic portfolio dataset generation."""

from __future__ import annotations

import hashlib
import random
from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID, uuid5
from zoneinfo import ZoneInfo

from app.catalog import (
    CATEGORY_SEEDS,
    MENU_ITEM_SEEDS,
    CategorySeed,
    MenuItemSeed,
)
from app.demo.dataset import (
    OrderItemSeedRow,
    OrderSeedRow,
    OrderStatusHistorySeedRow,
    PaymentSeedRow,
    PortfolioDatasetError,
    PortfolioSeedMetadata,
    PortfolioSeedPlan,
    RestaurantTableSeedRow,
)
from app.orders.origins import OrderDataOrigin
from app.orders.statuses import OrderStatus
from app.payments.providers import PaymentProvider
from app.payments.statuses import PaymentStatus

DEFAULT_SEED_VERSION = "portfolio-60d-v1"
DEFAULT_RNG_SEED = 220060500
OSLO_TIMEZONE = "Europe/Oslo"

_ORDER_COUNT = 500
_COMPLETED_LOCAL_DAYS = 60
_TABLE_COUNT = 12
_MINIMUM_DAILY_ORDERS = 6
_DINNER_ORDER_COUNT = 350
_DINE_IN_ORDER_COUNT = 320
_CANCELLED_ORDER_COUNT = 48
_NONTERMINAL_COUNT_PER_STATUS = 3
_PUBLIC_ORDER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_PROJECT_NAMESPACE = UUID("3d5dcf95-673f-5b93-bc40-c0735b4a8de8")
_NON_CAPABILITY_HASH_DOMAIN = b"\xffportfolio-seed-access-hash\x00"
_WEEKDAY_WEIGHTS = (70, 75, 90, 105, 140, 150, 85)
_LINE_COUNT_VALUES = (1, 2, 3, 4)
_LINE_COUNT_WEIGHTS = (12, 42, 34, 12)
_QUANTITY_VALUES = (1, 2, 3)
_QUANTITY_WEIGHTS = (55, 32, 13)
_PRODUCT_WEIGHTS_BY_CATEGORY_KEY = {
    "category_starters": 12,
    "category_main_courses": 24,
    "category_burgers": 22,
    "category_desserts": 9,
    "category_drinks": 17,
}


def generate_portfolio_dataset(
    reference_end: datetime,
    *,
    seed_version: str = DEFAULT_SEED_VERSION,
    rng_seed: int = DEFAULT_RNG_SEED,
) -> PortfolioSeedPlan:
    """Build the complete deterministic in-memory portfolio seed plan.

    Args:
        reference_end: Explicit instant representing an exact Europe/Oslo
            midnight at the exclusive end of the completed-day window.
        seed_version: Stable dataset contract identifier included in every
            deterministic identity.
        rng_seed: Seed for an isolated local pseudo-random generator.

    Returns:
        An immutable plan containing tables, orders, items, histories, and
        provider-neutral demo payments.

    Raises:
        PortfolioDatasetError: If inputs or the canonical menu violate the
            approved B2-1 contract.
    """
    normalized_version = _validate_seed_version(seed_version)
    normalized_rng_seed = _validate_rng_seed(rng_seed)
    reference_end_local, window_start_local = _normalize_reference_end(reference_end)
    category_seeds = CATEGORY_SEEDS
    menu_item_seeds = MENU_ITEM_SEEDS
    _validate_catalog(
        category_seeds=category_seeds,
        menu_item_seeds=menu_item_seeds,
    )

    reference_end_utc = reference_end_local.astimezone(UTC)
    window_start_utc = window_start_local.astimezone(UTC)
    metadata = PortfolioSeedMetadata(
        seed_version=normalized_version,
        rng_seed=normalized_rng_seed,
        timezone=OSLO_TIMEZONE,
        reference_end_utc=reference_end_utc,
        window_start_utc=window_start_utc,
        reference_end_local_date=reference_end_local.date(),
        window_start_local_date=window_start_local.date(),
        completed_local_days=_COMPLETED_LOCAL_DAYS,
        expected_order_count=_ORDER_COUNT,
        category_count=len(category_seeds),
        menu_item_count=len(menu_item_seeds),
    )
    reference_identity = _utc_identity(reference_end_utc)
    rng = random.Random(normalized_rng_seed)

    tables = _build_tables(
        metadata=metadata,
        reference_identity=reference_identity,
    )
    local_dates = tuple(
        window_start_local.date() + timedelta(days=offset)
        for offset in range(_COMPLETED_LOCAL_DAYS)
    )
    created_instants = _build_order_schedule(
        local_dates=local_dates,
        rng=rng,
    )
    final_statuses = _build_final_statuses(
        created_instants=created_instants,
        reference_end_local_date=reference_end_local.date(),
        rng=rng,
    )
    order_types = _build_order_types(rng)
    cancelled_payment_statuses, created_payment_statuses = _build_payment_assignments(
        final_statuses
    )

    orders: list[OrderSeedRow] = []
    order_items: list[OrderItemSeedRow] = []
    histories: list[OrderStatusHistorySeedRow] = []
    payments: list[PaymentSeedRow] = []
    dine_in_sequence = 0

    category_names = {seed.id: seed.name for seed in category_seeds}
    for order_index, created_at in enumerate(created_instants):
        order_id = _stable_uuid(
            metadata=metadata,
            reference_identity=reference_identity,
            entity_type="order",
            stable_key=str(order_index),
        )
        selected_items = _select_menu_items(
            rng=rng,
            order_index=order_index,
            category_seeds=category_seeds,
            menu_item_seeds=menu_item_seeds,
        )
        item_rows = _build_order_items(
            metadata=metadata,
            reference_identity=reference_identity,
            order_id=order_id,
            order_index=order_index,
            selected_items=selected_items,
            category_names=category_names,
            rng=rng,
        )
        total_amount = sum(item.line_total_amount for item in item_rows)
        final_status = final_statuses[order_index]
        history_rows = _build_status_history(
            metadata=metadata,
            reference_identity=reference_identity,
            order_id=order_id,
            order_index=order_index,
            final_status=final_status,
            created_at=created_at,
        )
        updated_at = history_rows[-1].changed_at

        order_type = order_types[order_index]
        table_id: UUID | None = None
        table_number_snapshot: int | None = None
        if order_type == "dine_in":
            table = tables[dine_in_sequence % len(tables)]
            table_id = table.id
            table_number_snapshot = table.number
            dine_in_sequence += 1

        orders.append(
            OrderSeedRow(
                id=order_id,
                public_order_number=_public_order_number(
                    metadata=metadata,
                    reference_identity=reference_identity,
                    order_index=order_index,
                ),
                order_access_token_hash=_access_token_hash(
                    metadata=metadata,
                    reference_identity=reference_identity,
                    order_index=order_index,
                ),
                customer_user_id=None,
                data_origin=OrderDataOrigin.PORTFOLIO_SEED.value,
                order_type=order_type,
                table_id=table_id,
                table_number_snapshot=table_number_snapshot,
                status=final_status,
                currency="NOK",
                subtotal_amount=total_amount,
                total_amount=total_amount,
                created_at=created_at,
                updated_at=updated_at,
            )
        )
        order_items.extend(item_rows)
        histories.extend(history_rows)

        payment_status = _payment_status_for_order(
            order_index=order_index,
            final_status=final_status,
            cancelled_payment_statuses=cancelled_payment_statuses,
            created_payment_statuses=created_payment_statuses,
        )
        if payment_status is not None:
            payments.append(
                _build_payment(
                    metadata=metadata,
                    reference_identity=reference_identity,
                    order_id=order_id,
                    order_index=order_index,
                    status=payment_status,
                    amount=total_amount,
                    order_created_at=created_at,
                )
            )

    plan = PortfolioSeedPlan(
        metadata=metadata,
        tables=tables,
        orders=tuple(orders),
        order_items=tuple(order_items),
        order_status_history=tuple(histories),
        payments=tuple(payments),
    )
    _validate_generated_plan(plan, menu_item_seeds=menu_item_seeds)
    return plan


def _validate_seed_version(seed_version: str) -> str:
    if not isinstance(seed_version, str):
        raise PortfolioDatasetError("Seed version must be a string.")
    if not seed_version or seed_version != seed_version.strip():
        raise PortfolioDatasetError("Seed version must be nonblank and normalized.")
    return seed_version


def _validate_rng_seed(rng_seed: int) -> int:
    if isinstance(rng_seed, bool) or not isinstance(rng_seed, int):
        raise PortfolioDatasetError("RNG seed must be an integer.")
    return rng_seed


def _normalize_reference_end(reference_end: datetime) -> tuple[datetime, datetime]:
    if not isinstance(reference_end, datetime):
        raise PortfolioDatasetError("Reference end must be a datetime.")
    if reference_end.tzinfo is None or reference_end.utcoffset() is None:
        raise PortfolioDatasetError("Reference end must be timezone-aware.")

    oslo = ZoneInfo(OSLO_TIMEZONE)
    try:
        local_end = reference_end.astimezone(oslo)
    except OverflowError as exc:
        raise PortfolioDatasetError(
            "Reference end is outside the supported range."
        ) from exc
    if any(
        (
            local_end.hour,
            local_end.minute,
            local_end.second,
            local_end.microsecond,
        )
    ):
        raise PortfolioDatasetError(
            "Reference end must represent exact Europe/Oslo midnight."
        )
    try:
        start_date = local_end.date() - timedelta(days=_COMPLETED_LOCAL_DAYS)
        local_start = datetime.combine(start_date, time.min, tzinfo=oslo)
    except OverflowError as exc:
        raise PortfolioDatasetError(
            "Reference end cannot cover 60 local days."
        ) from exc
    return local_end, local_start


def _validate_catalog(
    *,
    category_seeds: tuple[CategorySeed, ...],
    menu_item_seeds: tuple[MenuItemSeed, ...],
) -> None:
    if len(category_seeds) != 5 or len(menu_item_seeds) != 15:
        raise PortfolioDatasetError(
            "Canonical menu must contain 5 categories and 15 items."
        )
    category_ids = {category.id for category in category_seeds}
    if len(category_ids) != len(category_seeds):
        raise PortfolioDatasetError("Canonical category identifiers must be unique.")
    menu_item_ids = {item.id for item in menu_item_seeds}
    if len(menu_item_ids) != len(menu_item_seeds):
        raise PortfolioDatasetError("Canonical menu-item identifiers must be unique.")
    if any(item.category_id not in category_ids for item in menu_item_seeds):
        raise PortfolioDatasetError(
            "Every canonical menu item must reference a category."
        )
    if any(item.currency != "NOK" for item in menu_item_seeds):
        raise PortfolioDatasetError("Canonical portfolio menu must be NOK only.")
    if len(tuple(item for item in menu_item_seeds if item.is_available)) != 14:
        raise PortfolioDatasetError(
            "Canonical menu must expose exactly 14 available items."
        )


def _build_tables(
    *,
    metadata: PortfolioSeedMetadata,
    reference_identity: str,
) -> tuple[RestaurantTableSeedRow, ...]:
    return tuple(
        RestaurantTableSeedRow(
            id=_stable_uuid(
                metadata=metadata,
                reference_identity=reference_identity,
                entity_type="restaurant-table",
                stable_key=str(number),
            ),
            number=number,
            is_active=True,
            created_at=metadata.window_start_utc,
            updated_at=metadata.window_start_utc,
        )
        for number in range(1, _TABLE_COUNT + 1)
    )


def _build_order_schedule(
    *,
    local_dates: tuple[date, ...],
    rng: random.Random,
) -> tuple[datetime, ...]:
    daily_counts = _daily_order_counts(local_dates)
    sessions = ["dinner"] * _DINNER_ORDER_COUNT + ["lunch"] * (
        _ORDER_COUNT - _DINNER_ORDER_COUNT
    )
    rng.shuffle(sessions)

    oslo = ZoneInfo(OSLO_TIMEZONE)
    scheduled: list[datetime] = []
    session_index = 0
    for local_date, count in zip(local_dates, daily_counts, strict=True):
        for _ in range(count):
            session = sessions[session_index]
            session_index += 1
            if session == "dinner":
                minute_of_day = rng.randrange(17 * 60, 21 * 60 + 46)
            else:
                minute_of_day = rng.randrange(11 * 60, 15 * 60 + 46)
            local_created_at = datetime.combine(
                local_date,
                time(
                    hour=minute_of_day // 60,
                    minute=minute_of_day % 60,
                    second=rng.randrange(60),
                ),
                tzinfo=oslo,
            )
            scheduled.append(local_created_at.astimezone(UTC))
    return tuple(sorted(scheduled))


def _daily_order_counts(local_dates: tuple[date, ...]) -> tuple[int, ...]:
    base_total = _MINIMUM_DAILY_ORDERS * len(local_dates)
    remaining = _ORDER_COUNT - base_total
    day_weights = tuple(_WEEKDAY_WEIGHTS[value.weekday()] for value in local_dates)
    total_weight = sum(day_weights)
    allocations: list[int] = []
    remainders: list[tuple[int, int]] = []
    for index, weight in enumerate(day_weights):
        quotient, remainder = divmod(remaining * weight, total_weight)
        allocations.append(_MINIMUM_DAILY_ORDERS + quotient)
        remainders.append((remainder, index))
    undistributed = _ORDER_COUNT - sum(allocations)
    for _, index in sorted(remainders, key=lambda item: (-item[0], item[1]))[
        :undistributed
    ]:
        allocations[index] += 1
    return tuple(allocations)


def _build_final_statuses(
    *,
    created_instants: tuple[datetime, ...],
    reference_end_local_date: date,
    rng: random.Random,
) -> tuple[str, ...]:
    oslo = ZoneInfo(OSLO_TIMEZONE)
    nonterminal_start = reference_end_local_date - timedelta(days=2)
    recent_indices = [
        index
        for index, created_at in enumerate(created_instants)
        if created_at.astimezone(oslo).date() >= nonterminal_start
    ]
    required_nonterminal = _NONTERMINAL_COUNT_PER_STATUS * 4
    if len(recent_indices) < required_nonterminal:
        raise PortfolioDatasetError("Final two local dates lack nonterminal capacity.")

    statuses = [OrderStatus.COMPLETED.value] * len(created_instants)
    selected_nonterminal = recent_indices[-required_nonterminal:]
    nonterminal_values = (
        (OrderStatus.READY.value,) * _NONTERMINAL_COUNT_PER_STATUS
        + (OrderStatus.PREPARING.value,) * _NONTERMINAL_COUNT_PER_STATUS
        + (OrderStatus.ACCEPTED.value,) * _NONTERMINAL_COUNT_PER_STATUS
        + (OrderStatus.CREATED.value,) * _NONTERMINAL_COUNT_PER_STATUS
    )
    for index, status in zip(selected_nonterminal, nonterminal_values, strict=True):
        statuses[index] = status

    terminal_candidates = [
        index
        for index, status in enumerate(statuses)
        if status == OrderStatus.COMPLETED.value
    ]
    for index in rng.sample(terminal_candidates, _CANCELLED_ORDER_COUNT):
        statuses[index] = OrderStatus.CANCELLED.value
    return tuple(statuses)


def _build_order_types(rng: random.Random) -> tuple[str, ...]:
    values = ["dine_in"] * _DINE_IN_ORDER_COUNT + ["takeaway"] * (
        _ORDER_COUNT - _DINE_IN_ORDER_COUNT
    )
    rng.shuffle(values)
    return tuple(values)


def _build_payment_assignments(
    final_statuses: tuple[str, ...],
) -> tuple[dict[int, str | None], dict[int, str]]:
    cancelled_indices = [
        index
        for index, status in enumerate(final_statuses)
        if status == OrderStatus.CANCELLED.value
    ]
    cancelled: dict[int, str | None] = {}
    for rank, order_index in enumerate(cancelled_indices):
        if rank < 16:
            cancelled[order_index] = PaymentStatus.FAILED.value
        elif rank < 32:
            cancelled[order_index] = PaymentStatus.EXPIRED.value
        else:
            cancelled[order_index] = None

    created_indices = [
        index
        for index, status in enumerate(final_statuses)
        if status == OrderStatus.CREATED.value
    ]
    created_statuses = (
        PaymentStatus.PENDING.value,
        PaymentStatus.FAILED.value,
        PaymentStatus.EXPIRED.value,
    )
    created = dict(zip(created_indices, created_statuses, strict=True))
    return cancelled, created


def _select_menu_items(
    *,
    rng: random.Random,
    order_index: int,
    category_seeds: tuple[CategorySeed, ...],
    menu_item_seeds: tuple[MenuItemSeed, ...],
) -> tuple[MenuItemSeed, ...]:
    available = tuple(item for item in menu_item_seeds if item.is_available)
    target_count = rng.choices(
        _LINE_COUNT_VALUES,
        weights=_LINE_COUNT_WEIGHTS,
        k=1,
    )[0]
    selected: list[MenuItemSeed] = []
    if order_index < len(available):
        selected.append(available[order_index])

    category_key_by_id = {category.id: category.key for category in category_seeds}
    while len(selected) < target_count:
        candidates = [item for item in available if item not in selected]
        weights = [
            _PRODUCT_WEIGHTS_BY_CATEGORY_KEY[category_key_by_id[item.category_id]]
            for item in candidates
        ]
        selected.append(rng.choices(candidates, weights=weights, k=1)[0])
    return tuple(selected)


def _build_order_items(
    *,
    metadata: PortfolioSeedMetadata,
    reference_identity: str,
    order_id: UUID,
    order_index: int,
    selected_items: tuple[MenuItemSeed, ...],
    category_names: dict[UUID, str],
    rng: random.Random,
) -> tuple[OrderItemSeedRow, ...]:
    rows: list[OrderItemSeedRow] = []
    for position, menu_item in enumerate(selected_items):
        quantity = rng.choices(
            _QUANTITY_VALUES,
            weights=_QUANTITY_WEIGHTS,
            k=1,
        )[0]
        rows.append(
            OrderItemSeedRow(
                id=_stable_uuid(
                    metadata=metadata,
                    reference_identity=reference_identity,
                    entity_type="order-item",
                    stable_key=f"{order_index}:{position}",
                ),
                order_id=order_id,
                menu_item_id=menu_item.id,
                position=position,
                category_name_snapshot=category_names[menu_item.category_id],
                name_snapshot=menu_item.name,
                quantity=quantity,
                unit_price_amount=menu_item.price_amount,
                unit_cost_amount=menu_item.cost_amount,
                tax_rate_bps_snapshot=None,
                discount_amount_snapshot=0,
                line_total_amount=menu_item.price_amount * quantity,
                currency=menu_item.currency,
            )
        )
    return tuple(rows)


def _build_status_history(
    *,
    metadata: PortfolioSeedMetadata,
    reference_identity: str,
    order_id: UUID,
    order_index: int,
    final_status: str,
    created_at: datetime,
) -> tuple[OrderStatusHistorySeedRow, ...]:
    path = _status_path(final_status)
    offsets = _transition_offsets(final_status)
    rows: list[OrderStatusHistorySeedRow] = []
    previous_status: str | None = None
    for sequence, (new_status, minute_offset) in enumerate(
        zip(path, offsets, strict=True)
    ):
        rows.append(
            OrderStatusHistorySeedRow(
                id=_stable_uuid(
                    metadata=metadata,
                    reference_identity=reference_identity,
                    entity_type="order-status-history",
                    stable_key=f"{order_index}:{sequence}",
                ),
                order_id=order_id,
                sequence=sequence,
                previous_status=previous_status,
                new_status=new_status,
                changed_at=created_at + timedelta(minutes=minute_offset),
            )
        )
        previous_status = new_status
    return tuple(rows)


def _status_path(final_status: str) -> tuple[str, ...]:
    standard = (
        OrderStatus.CREATED.value,
        OrderStatus.ACCEPTED.value,
        OrderStatus.PREPARING.value,
        OrderStatus.READY.value,
        OrderStatus.COMPLETED.value,
    )
    if final_status == OrderStatus.CANCELLED.value:
        return (OrderStatus.CREATED.value, OrderStatus.CANCELLED.value)
    try:
        endpoint = standard.index(final_status)
    except ValueError as exc:
        raise PortfolioDatasetError("Unsupported generated order status.") from exc
    return standard[: endpoint + 1]


def _transition_offsets(final_status: str) -> tuple[int, ...]:
    if final_status == OrderStatus.CANCELLED.value:
        return (0, 5)
    offsets = (0, 5, 15, 32, 50)
    return offsets[: len(_status_path(final_status))]


def _payment_status_for_order(
    *,
    order_index: int,
    final_status: str,
    cancelled_payment_statuses: dict[int, str | None],
    created_payment_statuses: dict[int, str],
) -> str | None:
    if final_status in {
        OrderStatus.ACCEPTED.value,
        OrderStatus.PREPARING.value,
        OrderStatus.READY.value,
        OrderStatus.COMPLETED.value,
    }:
        return PaymentStatus.SUCCEEDED.value
    if final_status == OrderStatus.CANCELLED.value:
        return cancelled_payment_statuses[order_index]
    if final_status == OrderStatus.CREATED.value:
        return created_payment_statuses[order_index]
    raise PortfolioDatasetError("Unsupported order status for payment planning.")


def _build_payment(
    *,
    metadata: PortfolioSeedMetadata,
    reference_identity: str,
    order_id: UUID,
    order_index: int,
    status: str,
    amount: int,
    order_created_at: datetime,
) -> PaymentSeedRow:
    payment_id = _stable_uuid(
        metadata=metadata,
        reference_identity=reference_identity,
        entity_type="payment",
        stable_key=str(order_index),
    )
    request_key = _stable_uuid(
        metadata=metadata,
        reference_identity=reference_identity,
        entity_type="payment-request",
        stable_key=str(order_index),
    )
    created_at = order_created_at + timedelta(minutes=1)
    succeeded_at = (
        order_created_at + timedelta(minutes=2)
        if status == PaymentStatus.SUCCEEDED.value
        else None
    )
    updated_at = (
        succeeded_at
        if succeeded_at is not None
        else created_at
        + (
            timedelta(minutes=2)
            if status in {PaymentStatus.FAILED.value, PaymentStatus.EXPIRED.value}
            else timedelta(0)
        )
    )
    return PaymentSeedRow(
        id=payment_id,
        order_id=order_id,
        status=status,
        amount=amount,
        currency="NOK",
        request_idempotency_key=request_key,
        provider=PaymentProvider.DEMO.value,
        provider_idempotency_key=f"demo:{request_key.hex}",
        provider_session_id=None,
        provider_checkout_url=None,
        provider_checkout_expires_at=None,
        succeeded_at=succeeded_at,
        created_at=created_at,
        updated_at=updated_at,
    )


def _stable_uuid(
    *,
    metadata: PortfolioSeedMetadata,
    reference_identity: str,
    entity_type: str,
    stable_key: str,
) -> UUID:
    material = _stable_material(
        metadata=metadata,
        reference_identity=reference_identity,
        entity_type=entity_type,
        stable_key=stable_key,
    )
    return uuid5(_PROJECT_NAMESPACE, material)


def _public_order_number(
    *,
    metadata: PortfolioSeedMetadata,
    reference_identity: str,
    order_index: int,
) -> str:
    material = _stable_material(
        metadata=metadata,
        reference_identity=reference_identity,
        entity_type="public-order-number",
        stable_key=str(order_index),
    )
    value = int.from_bytes(hashlib.sha256(material.encode("utf-8")).digest(), "big")
    encoded: list[str] = []
    for _ in range(12):
        value, remainder = divmod(value, len(_PUBLIC_ORDER_ALPHABET))
        encoded.append(_PUBLIC_ORDER_ALPHABET[remainder])
    return "ROA-" + "".join(reversed(encoded))


def _access_token_hash(
    *,
    metadata: PortfolioSeedMetadata,
    reference_identity: str,
    order_index: int,
) -> str:
    material = _stable_material(
        metadata=metadata,
        reference_identity=reference_identity,
        entity_type="order-access-capability",
        stable_key=str(order_index),
    )
    # The persisted value must not have a reconstructible UTF-8 guest token.
    # 0xff cannot occur in UTF-8 output, so the existing token verifier cannot
    # accept this deterministic domain input except through a SHA-256 collision.
    return hashlib.sha256(
        _NON_CAPABILITY_HASH_DOMAIN + material.encode("utf-8")
    ).hexdigest()


def _stable_material(
    *,
    metadata: PortfolioSeedMetadata,
    reference_identity: str,
    entity_type: str,
    stable_key: str,
) -> str:
    return "|".join(
        (
            "restaurant-ordering-analytics",
            metadata.seed_version,
            str(metadata.rng_seed),
            reference_identity,
            entity_type,
            stable_key,
        )
    )


def _utc_identity(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _validate_generated_plan(
    plan: PortfolioSeedPlan,
    *,
    menu_item_seeds: tuple[MenuItemSeed, ...],
) -> None:
    summary = plan.summary
    expected_order_types = (("dine_in", 320), ("takeaway", 180))
    expected_statuses = (
        (OrderStatus.ACCEPTED.value, 3),
        (OrderStatus.CANCELLED.value, 48),
        (OrderStatus.COMPLETED.value, 440),
        (OrderStatus.CREATED.value, 3),
        (OrderStatus.PREPARING.value, 3),
        (OrderStatus.READY.value, 3),
    )
    expected_payments = (
        (PaymentStatus.EXPIRED.value, 17),
        (PaymentStatus.FAILED.value, 17),
        (PaymentStatus.PENDING.value, 1),
        (PaymentStatus.SUCCEEDED.value, 449),
    )
    if summary.table_count != _TABLE_COUNT or summary.order_count != _ORDER_COUNT:
        raise PortfolioDatasetError("Generated plan has invalid core counts.")
    if summary.local_date_count != _COMPLETED_LOCAL_DAYS:
        raise PortfolioDatasetError("Generated plan does not cover 60 local dates.")
    if summary.order_type_counts != expected_order_types:
        raise PortfolioDatasetError("Generated plan has invalid order-type counts.")
    if summary.order_status_counts != expected_statuses:
        raise PortfolioDatasetError("Generated plan has invalid status counts.")
    if summary.payment_status_counts != expected_payments:
        raise PortfolioDatasetError("Generated plan has invalid payment counts.")

    if len({order.id for order in plan.orders}) != len(plan.orders):
        raise PortfolioDatasetError("Generated Order identifiers are not unique.")
    if len({order.public_order_number for order in plan.orders}) != len(plan.orders):
        raise PortfolioDatasetError("Generated public order numbers are not unique.")
    if len({order.order_access_token_hash for order in plan.orders}) != len(
        plan.orders
    ):
        raise PortfolioDatasetError("Generated access-token hashes are not unique.")
    if any(
        timestamp >= plan.metadata.reference_end_utc
        for timestamp in _all_plan_timestamps(plan)
    ):
        raise PortfolioDatasetError("Generated timestamps must precede reference end.")

    available_ids = {item.id for item in menu_item_seeds if item.is_available}
    represented_ids = {item.menu_item_id for item in plan.order_items}
    if represented_ids != available_ids:
        raise PortfolioDatasetError("Generated items must cover the available menu.")
    if plan.canonical_size_bytes >= 10 * 1024 * 1024:
        raise PortfolioDatasetError("Canonical dataset exceeds the 10 MiB limit.")


def _all_plan_timestamps(plan: PortfolioSeedPlan) -> tuple[datetime, ...]:
    table_times = tuple(
        timestamp
        for table in plan.tables
        for timestamp in (table.created_at, table.updated_at)
    )
    order_times = tuple(
        timestamp
        for order in plan.orders
        for timestamp in (order.created_at, order.updated_at)
    )
    history_times = tuple(item.changed_at for item in plan.order_status_history)
    payment_times = tuple(
        timestamp
        for payment in plan.payments
        for timestamp in (
            payment.created_at,
            payment.updated_at,
            payment.succeeded_at,
        )
        if timestamp is not None
    )
    return table_times + order_times + history_times + payment_times


__all__ = [
    "DEFAULT_RNG_SEED",
    "DEFAULT_SEED_VERSION",
    "OSLO_TIMEZONE",
    "generate_portfolio_dataset",
]
