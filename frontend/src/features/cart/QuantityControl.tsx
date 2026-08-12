import { CART_MAX_QUANTITY, CART_MIN_QUANTITY } from './cartReducer';
import styles from './CartPage.module.css';

interface QuantityControlProps {
  itemName: string;
  onDecrement: () => void;
  onIncrement: () => void;
  quantity: number;
}

export default function QuantityControl({
  itemName,
  onDecrement,
  onIncrement,
  quantity,
}: QuantityControlProps) {
  return (
    <div className={styles.quantityControl} aria-label={`Quantity for ${itemName}`}>
      <button
        type="button"
        aria-label={`Decrease quantity for ${itemName}`}
        disabled={quantity <= CART_MIN_QUANTITY}
        onClick={onDecrement}
      >
        −
      </button>
      <output aria-live="polite" aria-label={`${itemName} quantity`}>
        {quantity}
      </output>
      <button
        type="button"
        aria-label={`Increase quantity for ${itemName}`}
        disabled={quantity >= CART_MAX_QUANTITY}
        onClick={onIncrement}
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
