import { Link, useParams } from 'react-router-dom';

import type { OrderStatusResponse } from '../../api/types';
import { isPublicOrderNumber, loadOrderAccess } from '../checkout/orderAccessStorage';
import styles from './OrderStatusPage.module.css';
import OrderStatusTimeline from './OrderStatusTimeline';
import { useOrderStatusPolling } from './useOrderStatusPolling';

const ORDER_STATUS_LABELS: Record<OrderStatusResponse['status'], string> = {
  accepted: 'Accepted',
  cancelled: 'Cancelled',
  completed: 'Completed',
  created: 'Order received',
  preparing: 'Preparing',
  ready: 'Ready',
};

function formatAmount(amount: number, currency: string): string {
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

function formatDatetime(value: string): string {
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

function OrderSummary({ order }: { order: OrderStatusResponse }) {
  return (
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
          <dd>{formatDatetime(order.created_at)}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{formatDatetime(order.updated_at)}</dd>
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
              {formatAmount(item.line_total_amount, order.currency)}
            </span>
          </li>
        ))}
      </ul>

      <dl className={styles.totals}>
        <div>
          <dt>Subtotal</dt>
          <dd>{formatAmount(order.subtotal_amount, order.currency)}</dd>
        </div>
        <div className={styles.totalRow}>
          <dt>Total</dt>
          <dd>{formatAmount(order.total_amount, order.currency)}</dd>
        </div>
      </dl>
    </section>
  );
}

/** Display and safely refresh one guest-visible fulfilment snapshot. */
export default function OrderStatusPage() {
  const { publicOrderNumber } = useParams();
  const validPublicOrderNumber = isPublicOrderNumber(publicOrderNumber)
    ? publicOrderNumber
    : null;
  const token =
    validPublicOrderNumber === null ? null : loadOrderAccess(validPublicOrderNumber);
  const polling = useOrderStatusPolling(
    validPublicOrderNumber ?? '',
    token,
    validPublicOrderNumber !== null && token !== null,
  );

  if (validPublicOrderNumber === null || token === null) {
    return (
      <div className={styles.page}>
        <section className={styles.panel} aria-labelledby="status-unavailable-title">
          <p className={styles.eyebrow}>Order access</p>
          <h1 id="status-unavailable-title">Order status unavailable</h1>
          <p>
            This browser session does not have the guest access needed to view this
            order. Access credentials cannot be recovered from the URL.
          </p>
          <Link className={styles.actionLink} to="/">
            Browse the menu
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>Live fulfilment status</p>
        <h1>Order status</h1>
        <p className={styles.orderNumberLabel}>Public order number</p>
        <p className={styles.orderNumber}>{validPublicOrderNumber}</p>
      </header>

      {polling.isLoading && polling.data === null && (
        <div className={styles.notice} role="status" aria-live="polite">
          Loading order status…
        </div>
      )}

      {polling.error !== null && (
        <div className={styles.errorNotice} role="alert" aria-live="assertive">
          <p>{polling.error.message}</p>
          {polling.error.retryable && (
            <button
              className={styles.retryButton}
              disabled={polling.isPaused || polling.isRefreshing}
              onClick={polling.retryNow}
              type="button"
            >
              Retry status
            </button>
          )}
        </div>
      )}

      {polling.data !== null && (
        <>
          <section
            className={styles.currentPanel}
            aria-labelledby="current-status-title"
          >
            <p>Current fulfilment status</p>
            <h2 id="current-status-title" aria-live="polite">
              {ORDER_STATUS_LABELS[polling.data.status]}
            </h2>
            {polling.isRefreshing && (
              <p className={styles.refreshing} role="status" aria-live="polite">
                Refreshing status…
              </p>
            )}
            {polling.isStopped && (
              <p className={styles.terminalNotice}>
                Automatic updates have stopped for this final order state.
              </p>
            )}
          </section>
          <OrderStatusTimeline status={polling.data.status} />
          <OrderSummary order={polling.data} />
        </>
      )}

      {polling.isPaused && (
        <p className={styles.pausedNotice} role="status" aria-live="polite">
          Status updates are paused while this tab is hidden or the browser is offline.
        </p>
      )}

      <nav className={styles.navigation} aria-label="Order status navigation">
        <Link className={styles.actionLink} to="/">
          Browse the menu
        </Link>
      </nav>
    </div>
  );
}
