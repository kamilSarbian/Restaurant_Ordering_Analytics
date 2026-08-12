import {
  CART_MAX_QUANTITY,
  CART_MAX_UNIQUE_ITEMS,
  CART_MIN_QUANTITY,
  EMPTY_CART_STATE,
  type CartItem,
  type CartState,
} from './cartReducer';

export const CART_STORAGE_KEY = 'restaurant-ordering:cart:v1';
export const CART_STORAGE_VERSION = 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function parseStoredItems(value: unknown): CartItem[] | null {
  if (!Array.isArray(value) || value.length > CART_MAX_UNIQUE_ITEMS) {
    return null;
  }

  const seenIds = new Set<string>();
  const items: CartItem[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['menuItemId', 'quantity']) ||
      typeof candidate.menuItemId !== 'string' ||
      !UUID_PATTERN.test(candidate.menuItemId) ||
      !Number.isInteger(candidate.quantity) ||
      Number(candidate.quantity) < CART_MIN_QUANTITY ||
      Number(candidate.quantity) > CART_MAX_QUANTITY ||
      seenIds.has(candidate.menuItemId)
    ) {
      return null;
    }
    seenIds.add(candidate.menuItemId);
    items.push({
      menuItemId: candidate.menuItemId,
      quantity: Number(candidate.quantity),
    });
  }
  return items;
}

function resolveSessionStorage(storage?: Storage): Storage {
  return storage ?? window.sessionStorage;
}

export function loadCartState(storage?: Storage): CartState {
  try {
    const serialized = resolveSessionStorage(storage).getItem(CART_STORAGE_KEY);
    if (serialized === null) {
      return EMPTY_CART_STATE;
    }

    const candidate: unknown = JSON.parse(serialized);
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['items', 'version']) ||
      candidate.version !== CART_STORAGE_VERSION
    ) {
      return EMPTY_CART_STATE;
    }

    const items = parseStoredItems(candidate.items);
    return items === null ? EMPTY_CART_STATE : { items };
  } catch (error: unknown) {
    if (error instanceof Error) {
      return EMPTY_CART_STATE;
    }
    return EMPTY_CART_STATE;
  }
}

export function saveCartState(state: CartState, storage?: Storage): boolean {
  try {
    resolveSessionStorage(storage).setItem(
      CART_STORAGE_KEY,
      JSON.stringify({ items: state.items, version: CART_STORAGE_VERSION }),
    );
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return false;
    }
    return false;
  }
}
