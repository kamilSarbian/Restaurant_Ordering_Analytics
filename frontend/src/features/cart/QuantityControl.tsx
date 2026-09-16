import { useEffect, useRef } from 'react';

import { CART_MAX_QUANTITY, CART_MIN_QUANTITY } from './cartReducer';
import styles from './CartPage.module.css';

interface QuantityControlProps {
  disabled?: boolean;
  itemName: string;
  onDecrement: () => void;
  onIncrement: () => void;
  quantity: number;
}

export default function QuantityControl({
  disabled = false,
  itemName,
  onDecrement,
  onIncrement,
  quantity,
}: QuantityControlProps) {
  const decrementButtonRef = useRef<HTMLButtonElement>(null);
  const incrementButtonRef = useRef<HTMLButtonElement>(null);
  const pendingBoundaryFocusRef = useRef<'decrement' | 'increment' | null>(null);

  useEffect(() => {
    const targetName = pendingBoundaryFocusRef.current;
    if (targetName === null) {
      return;
    }

    const sourceButton =
      targetName === 'increment'
        ? decrementButtonRef.current
        : incrementButtonRef.current;
    const targetButton =
      targetName === 'increment'
        ? incrementButtonRef.current
        : decrementButtonRef.current;
    pendingBoundaryFocusRef.current = null;

    const activeElement = document.activeElement;
    if (
      activeElement === sourceButton ||
      activeElement === document.body ||
      activeElement === null
    ) {
      targetButton?.focus();
    }
  }, [quantity]);

  const decrementQuantity = () => {
    pendingBoundaryFocusRef.current =
      quantity === CART_MIN_QUANTITY + 1 ? 'increment' : null;
    onDecrement();
  };

  const incrementQuantity = () => {
    pendingBoundaryFocusRef.current =
      quantity === CART_MAX_QUANTITY - 1 ? 'decrement' : null;
    onIncrement();
  };

  return (
    <div
      aria-disabled={disabled || undefined}
      aria-label={`Quantity for ${itemName}`}
      className={styles.quantityControl}
      data-disabled={disabled || undefined}
      role={'group'}
    >
      <button
        ref={decrementButtonRef}
        type="button"
        aria-label={`Decrease quantity for ${itemName}`}
        disabled={disabled || quantity <= CART_MIN_QUANTITY}
        onClick={decrementQuantity}
      >
        −
      </button>
      <output aria-live="polite" aria-label={`${itemName} quantity`}>
        {quantity}
      </output>
      <button
        ref={incrementButtonRef}
        type="button"
        aria-label={`Increase quantity for ${itemName}`}
        disabled={disabled || quantity >= CART_MAX_QUANTITY}
        onClick={incrementQuantity}
      >
        +
      </button>
      {quantity === CART_MIN_QUANTITY && (
        <small className={styles.quantityLimit}>Minimum quantity is 1.</small>
      )}
      {quantity === CART_MAX_QUANTITY && (
        <small className={styles.quantityLimit}>Maximum quantity of 99 reached.</small>
      )}
    </div>
  );
}
