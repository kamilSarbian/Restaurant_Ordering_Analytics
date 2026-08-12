import { vi } from 'vitest';

import {
  CART_MAX_QUANTITY,
  CART_MAX_UNIQUE_ITEMS,
  cartReducer,
  EMPTY_CART_STATE,
  getAddResult,
  getSetQuantityResult,
  type CartState,
} from './cartReducer';
import {
  CART_STORAGE_KEY,
  CART_STORAGE_VERSION,
  loadCartState,
  saveCartState,
} from './cartStorage';

const ITEM_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ITEM_ID = '00000000-0000-4000-8000-000000000002';

function itemId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function stateWith(quantity: number): CartState {
  return { items: [{ menuItemId: ITEM_ID, quantity }] };
}

describe('cartReducer', () => {
  it('starts with a stable empty state', () => {
    expect(EMPTY_CART_STATE).toEqual({ items: [] });
  });

  it('adds a new item without display metadata', () => {
    expect(cartReducer(EMPTY_CART_STATE, { menuItemId: ITEM_ID, type: 'add' })).toEqual(
      { items: [{ menuItemId: ITEM_ID, quantity: 1 }] },
    );
  });

  it('merges a duplicate add into the existing line', () => {
    expect(cartReducer(stateWith(1), { menuItemId: ITEM_ID, type: 'add' })).toEqual(
      stateWith(2),
    );
  });

  it('increments an existing item', () => {
    expect(
      cartReducer(stateWith(2), { menuItemId: ITEM_ID, type: 'increment' }),
    ).toEqual(stateWith(3));
  });

  it('decrements an existing item', () => {
    expect(
      cartReducer(stateWith(2), { menuItemId: ITEM_ID, type: 'decrement' }),
    ).toEqual(stateWith(1));
  });

  it('does not decrement below one', () => {
    const state = stateWith(1);
    expect(cartReducer(state, { menuItemId: ITEM_ID, type: 'decrement' })).toBe(state);
  });

  it('sets a valid quantity', () => {
    expect(
      cartReducer(stateWith(1), {
        menuItemId: ITEM_ID,
        quantity: 12,
        type: 'setQuantity',
      }),
    ).toEqual(stateWith(12));
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid quantity %s', (quantity) => {
    const state = stateWith(3);
    expect(
      cartReducer(state, { menuItemId: ITEM_ID, quantity, type: 'setQuantity' }),
    ).toBe(state);
    expect(getSetQuantityResult(state, ITEM_ID, quantity)).toBe('invalid-quantity');
  });

  it('reports and enforces the quantity maximum', () => {
    const state = stateWith(CART_MAX_QUANTITY);
    expect(getAddResult(state, ITEM_ID)).toBe('quantity-limit');
    expect(cartReducer(state, { menuItemId: ITEM_ID, type: 'increment' })).toBe(state);
    expect(getSetQuantityResult(state, ITEM_ID, 100)).toBe('quantity-limit');
  });

  it('accepts exactly 50 unique items and rejects a 51st', () => {
    const state = {
      items: Array.from({ length: CART_MAX_UNIQUE_ITEMS }, (_, index) => ({
        menuItemId: itemId(index + 1),
        quantity: 1,
      })),
    };
    const nextId = itemId(CART_MAX_UNIQUE_ITEMS + 1);
    expect(getAddResult(state, nextId)).toBe('item-limit');
    expect(cartReducer(state, { menuItemId: nextId, type: 'add' })).toBe(state);
  });

  it('keeps stable line ordering during quantity changes', () => {
    const state = {
      items: [
        { menuItemId: ITEM_ID, quantity: 1 },
        { menuItemId: SECOND_ITEM_ID, quantity: 2 },
      ],
    };
    const next = cartReducer(state, { menuItemId: ITEM_ID, type: 'increment' });
    expect(next.items.map((item) => item.menuItemId)).toEqual([
      ITEM_ID,
      SECOND_ITEM_ID,
    ]);
  });

  it('uses safe no-ops for unknown item operations', () => {
    const state = stateWith(2);
    expect(cartReducer(state, { menuItemId: SECOND_ITEM_ID, type: 'increment' })).toBe(
      state,
    );
    expect(cartReducer(state, { menuItemId: itemId(99), type: 'decrement' })).toBe(
      state,
    );
    expect(
      cartReducer(state, {
        menuItemId: itemId(99),
        quantity: 2,
        type: 'setQuantity',
      }),
    ).toBe(state);
    expect(cartReducer(state, { menuItemId: itemId(99), type: 'remove' })).toBe(state);
  });

  it('removes an item explicitly', () => {
    expect(cartReducer(stateWith(2), { menuItemId: ITEM_ID, type: 'remove' })).toEqual(
      EMPTY_CART_STATE,
    );
  });

  it('clears the cart', () => {
    expect(cartReducer(stateWith(2), { type: 'clear' })).toEqual(EMPTY_CART_STATE);
  });
});

describe('cartStorage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('round-trips only version 1 and cart items', () => {
    const state = stateWith(4);
    expect(saveCartState(state)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(CART_STORAGE_KEY) ?? '')).toEqual({
      items: state.items,
      version: CART_STORAGE_VERSION,
    });
    expect(loadCartState()).toEqual(state);
  });

  it('returns an empty cart for malformed JSON', () => {
    sessionStorage.setItem(CART_STORAGE_KEY, '{broken');
    expect(loadCartState()).toEqual(EMPTY_CART_STATE);
  });

  it('rejects a wrong version or extra outer fields', () => {
    sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify({ items: [], version: 2 }));
    expect(loadCartState()).toEqual(EMPTY_CART_STATE);
    sessionStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({ extra: true, items: [], version: 1 }),
    );
    expect(loadCartState()).toEqual(EMPTY_CART_STATE);
  });

  it.each([
    { menuItemId: ITEM_ID, quantity: 0 },
    { menuItemId: ITEM_ID, quantity: 100 },
    { menuItemId: ITEM_ID, quantity: 1.5 },
    { menuItemId: 'not-a-uuid', quantity: 1 },
    { extra: true, menuItemId: ITEM_ID, quantity: 1 },
  ])('rejects an invalid stored item %#', (item) => {
    sessionStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({ items: [item], version: 1 }),
    );
    expect(loadCartState()).toEqual(EMPTY_CART_STATE);
  });

  it('rejects duplicate persisted IDs instead of merging them', () => {
    sessionStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({
        items: [
          { menuItemId: ITEM_ID, quantity: 1 },
          { menuItemId: ITEM_ID, quantity: 2 },
        ],
        version: 1,
      }),
    );
    expect(loadCartState()).toEqual(EMPTY_CART_STATE);
  });

  it('rejects more than 50 persisted lines', () => {
    sessionStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({
        items: Array.from({ length: 51 }, (_, index) => ({
          menuItemId: itemId(index + 1),
          quantity: 1,
        })),
        version: 1,
      }),
    );
    expect(loadCartState()).toEqual(EMPTY_CART_STATE);
  });

  it('continues with memory state when session storage is unavailable', () => {
    const unavailableStorage = {
      getItem: vi.fn(() => {
        throw new DOMException('Blocked', 'SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new DOMException('Blocked', 'SecurityError');
      }),
    } as unknown as Storage;

    expect(loadCartState(unavailableStorage)).toEqual(EMPTY_CART_STATE);
    expect(saveCartState(stateWith(1), unavailableStorage)).toBe(false);
  });

  it('never reads from or writes to localStorage', () => {
    const localGet = vi.spyOn(window.localStorage, 'getItem');
    const localSet = vi.spyOn(window.localStorage, 'setItem');

    saveCartState(stateWith(1), window.sessionStorage);
    loadCartState(window.sessionStorage);

    expect(localGet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
  });
});
