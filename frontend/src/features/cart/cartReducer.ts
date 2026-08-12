export const CART_MIN_QUANTITY = 1;
export const CART_MAX_QUANTITY = 99;
export const CART_MAX_UNIQUE_ITEMS = 50;

export interface CartItem {
  menuItemId: string;
  quantity: number;
}

export interface CartState {
  items: CartItem[];
}

export type CartMutationResult =
  'invalid-quantity' | 'item-limit' | 'item-not-found' | 'ok' | 'quantity-limit';

export type CartAction =
  | { menuItemId: string; type: 'add' }
  | { menuItemId: string; quantity: number; type: 'setQuantity' }
  | { menuItemId: string; type: 'increment' }
  | { menuItemId: string; type: 'decrement' }
  | { menuItemId: string; type: 'remove' }
  | { type: 'clear' };

export const EMPTY_CART_STATE: CartState = { items: [] };

function findItem(state: CartState, menuItemId: string): CartItem | undefined {
  return state.items.find((item) => item.menuItemId === menuItemId);
}

export function getAddResult(state: CartState, menuItemId: string): CartMutationResult {
  const existingItem = findItem(state, menuItemId);
  if (existingItem !== undefined) {
    return existingItem.quantity >= CART_MAX_QUANTITY ? 'quantity-limit' : 'ok';
  }
  return state.items.length >= CART_MAX_UNIQUE_ITEMS ? 'item-limit' : 'ok';
}

export function getSetQuantityResult(
  state: CartState,
  menuItemId: string,
  quantity: number,
): CartMutationResult {
  if (!Number.isInteger(quantity) || quantity < CART_MIN_QUANTITY) {
    return 'invalid-quantity';
  }
  if (quantity > CART_MAX_QUANTITY) {
    return 'quantity-limit';
  }
  return findItem(state, menuItemId) === undefined ? 'item-not-found' : 'ok';
}

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add': {
      if (getAddResult(state, action.menuItemId) !== 'ok') {
        return state;
      }
      const existingItem = findItem(state, action.menuItemId);
      if (existingItem === undefined) {
        return {
          items: [...state.items, { menuItemId: action.menuItemId, quantity: 1 }],
        };
      }
      return {
        items: state.items.map((item) =>
          item.menuItemId === action.menuItemId
            ? { ...item, quantity: item.quantity + 1 }
            : item,
        ),
      };
    }
    case 'setQuantity':
      if (getSetQuantityResult(state, action.menuItemId, action.quantity) !== 'ok') {
        return state;
      }
      return {
        items: state.items.map((item) =>
          item.menuItemId === action.menuItemId
            ? { ...item, quantity: action.quantity }
            : item,
        ),
      };
    case 'increment': {
      const existingItem = findItem(state, action.menuItemId);
      if (existingItem === undefined || existingItem.quantity >= CART_MAX_QUANTITY) {
        return state;
      }
      return cartReducer(state, {
        menuItemId: action.menuItemId,
        quantity: existingItem.quantity + 1,
        type: 'setQuantity',
      });
    }
    case 'decrement': {
      const existingItem = findItem(state, action.menuItemId);
      if (existingItem === undefined || existingItem.quantity <= CART_MIN_QUANTITY) {
        return state;
      }
      return cartReducer(state, {
        menuItemId: action.menuItemId,
        quantity: existingItem.quantity - 1,
        type: 'setQuantity',
      });
    }
    case 'remove': {
      if (findItem(state, action.menuItemId) === undefined) {
        return state;
      }
      return {
        items: state.items.filter((item) => item.menuItemId !== action.menuItemId),
      };
    }
    case 'clear':
      return state.items.length === 0 ? state : EMPTY_CART_STATE;
  }
}
