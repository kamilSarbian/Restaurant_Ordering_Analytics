import type { OrderStatusResponse } from '../../api/types';

import styles from './OrderStatusPage.module.css';
import OrderStatusTimeline from './OrderStatusTimeline';

const ORDER_STATUS_LABELS: Record<OrderStatusResponse['status'], string> = {
  accepted: 'Accepted',
  cancelled: 'Cancelled',
  completed: 'Completed',
  created: 'Order received',
  preparing: 'Preparing',
  ready: 'Ready',
};

interface OrderStatusSummaryProps {
  isRefreshing?: boolean;
  isStopped?: boolean;
  order: OrderStatusResponse;
}

/** Format an integer minor-unit amount with the currency's standard precision. */
// The exact F4 scope co-locates shared customer formatters with this presentation.
// eslint-disable-next-line react-refresh/only-export-components
export function formatCustomerMoney(amount: number, currency: string): string {
  const fallback = `${amount} minor units ${currency}`;
  try {
    const formatter = new Intl.NumberFormat('en-NO', { currency, style: 'currency' });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
    const divisor = 10 ** fractionDigits;
    return Number.isSafeInteger(divisor) && divisor > 0
      ? formatter.format(amount / divisor)
      : fallback;
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      return fallback;
    }
    return fallback;
  }
}

/** Format one validated backend timestamp for the customer locale. */
// The exact F4 scope co-locates shared customer formatters with this presentation.
// eslint-disable-next-line react-refresh/only-export-components
export function formatCustomerDate(value: string): string {
  try {
    return new Intl.DateTimeFormat('en-NO', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      return 'Date unavailable';
    }
    return 'Date unavailable';
  }
}

/** Present one customer-safe order snapshot without transport or authorization logic. */
export default function OrderStatusSummary({
  isRefreshing = false,
  isStopped = false,
  order,
}: OrderStatusSummaryProps) {
  return (
    <>
      <section className={styles.currentPanel} aria-labelledby="current-status-title">
        <p>Current fulfilment status</p>
        <h2 id="current-status-title" aria-live="polite">
          {ORDER_STATUS_LABELS[order.status]}
        </h2>
        {isRefreshing && (
          <p className={styles.refreshing} role="status" aria-live="polite">
            Refreshing status…
          </p>
        )}
        {isStopped && (
          <p className={styles.terminalNotice}>
            Automatic updates have stopped for this final order state.
          </p>
        )}
      </section>

      <OrderStatusTimeline status={order.status} />

      <section className={styles.summaryPanel} aria-labelledby="order-summary-heading">
        <h2 id="order-summary-heading">Order summary</h2>
        <dl className={styles.metadata}>
          <div>
            <dt>Order type</dt>
            <dd>{order.order_type === 'dine_in' ? 'Dine-in' : 'Takeaway'}</dd>
          </div>
          {order.table_number !== null && (
            <div>
              <dt>Table number</dt>
              <dd>{order.table_number}</dd>
            </div>
          )}
          <div>
            <dt>Created</dt>
            <dd>{formatCustomerDate(order.created_at)}</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>{formatCustomerDate(order.updated_at)}</dd>
          </div>
        </dl>

        <ul className={styles.itemList} aria-label="Ordered items">
          {order.items.map((item) => (
            <li key={item.menu_item_id}>
              <span>
                <strong>{item.name}</strong>
                <small>Quantity: {item.quantity}</small>
              </span>
              <span className={styles.amount}>
                {formatCustomerMoney(item.line_total_amount, order.currency)}
              </span>
            </li>
          ))}
        </ul>

        <dl className={styles.totals}>
          <div>
            <dt>Subtotal</dt>
            <dd>{formatCustomerMoney(order.subtotal_amount, order.currency)}</dd>
          </div>
          <div className={styles.totalRow}>
            <dt>Total</dt>
            <dd>{formatCustomerMoney(order.total_amount, order.currency)}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}
