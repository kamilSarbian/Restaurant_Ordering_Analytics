import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';

import {
  cartReducer,
  getAddResult,
  getSetQuantityResult,
  type CartItem,
  type CartMutationResult,
} from './cartReducer';
import { loadCartState, saveCartState } from './cartStorage';

interface CartContextValue {
  addItem: (menuItemId: string) => CartMutationResult;
  clearCart: () => void;
  decrementItem: (menuItemId: string) => void;
  getQuantity: (menuItemId: string) => number;
  incrementItem: (menuItemId: string) => CartMutationResult;
  items: CartItem[];
  removeItem: (menuItemId: string) => void;
  setQuantity: (menuItemId: string, quantity: number) => CartMutationResult;
  totalQuantity: number;
  uniqueItemCount: number;
}

interface CartProviderProps {
  children: ReactNode;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children }: CartProviderProps) {
  const [state, dispatch] = useReducer(cartReducer, undefined, loadCartState);

  useEffect(() => {
    saveCartState(state);
  }, [state]);

  const addItem = useCallback(
    (menuItemId: string): CartMutationResult => {
      const result = getAddResult(state, menuItemId);
      if (result === 'ok') {
        dispatch({ menuItemId, type: 'add' });
      }
      return result;
    },
    [state],
  );

  const setQuantity = useCallback(
    (menuItemId: string, quantity: number): CartMutationResult => {
      const result = getSetQuantityResult(state, menuItemId, quantity);
      if (result === 'ok') {
        dispatch({ menuItemId, quantity, type: 'setQuantity' });
      }
      return result;
    },
    [state],
  );

  const incrementItem = useCallback(
    (menuItemId: string): CartMutationResult => {
      const item = state.items.find((candidate) => candidate.menuItemId === menuItemId);
      if (item === undefined) {
        return 'item-not-found';
      }
      const result = getSetQuantityResult(state, menuItemId, item.quantity + 1);
      if (result === 'ok') {
        dispatch({ menuItemId, type: 'increment' });
      }
      return result;
    },
    [state],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      addItem,
      clearCart: () => dispatch({ type: 'clear' }),
      decrementItem: (menuItemId) => dispatch({ menuItemId, type: 'decrement' }),
      getQuantity: (menuItemId) =>
        state.items.find((item) => item.menuItemId === menuItemId)?.quantity ?? 0,
      incrementItem,
      items: state.items,
      removeItem: (menuItemId) => dispatch({ menuItemId, type: 'remove' }),
      setQuantity,
      totalQuantity: state.items.reduce((total, item) => total + item.quantity, 0),
      uniqueItemCount: state.items.length,
    }),
    [addItem, incrementItem, setQuantity, state.items],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

// The hook stays beside its provider to keep the cart's public API in one small module.
// eslint-disable-next-line react-refresh/only-export-components
export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (context === null) {
    throw new Error('useCart must be used within a CartProvider.');
  }
  return context;
}
