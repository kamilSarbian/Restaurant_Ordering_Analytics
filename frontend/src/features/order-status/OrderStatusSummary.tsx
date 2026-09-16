import type { OrderStatusResponse } from '../../api/types';
import StatusBadge, { type StatusBadgeVariant } from '../../components/ui/StatusBadge';

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

const ACCOUNT_STATUS_VARIANTS: Record<
  OrderStatusResponse['status'],
  StatusBadgeVariant
> = {
  accepted: 'info',
  cancelled: 'danger',
  completed: 'success',
  created: 'neutral',
  preparing: 'warning',
  ready: 'info',
};

const ACCOUNT_STATUS_COPY: Record<OrderStatusResponse['status'], string> = {
  accepted: 'The kitchen accepted your order.',
  cancelled: 'This order was cancelled.',
  completed: 'This order is complete.',
  created: 'We received your order.',
  preparing: 'The kitchen is preparing your order.',
  ready: 'Your order is ready.',
};

interface OrderStatusSummaryProps {
  isRefreshing?: boolean;
  isStopped?: boolean;
  order: OrderStatusResponse;
  presentation?: 'account-detail' | 'default' | 'public-status';
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
  presentation = 'default',
}: OrderStatusSummaryProps) {
  const isAccountDetail = presentation === 'account-detail';
  const isPublicStatus = presentation === 'public-status';
  const isFinalStatus = order.status === 'completed' || order.status === 'cancelled';

  if (isAccountDetail) {
    return (
      <div className={styles.accountDetail}>
        <section
          className={styles.accountStatusPanel}
          aria-labelledby="account-current-status-title"
          data-order-status={order.status}
        >
          <div className={styles.accountStatusHeading}>
            <p>Current order status</p>
            <StatusBadge
              className={styles.accountStatusBadge}
              variant={ACCOUNT_STATUS_VARIANTS[order.status]}
            >
              {ORDER_STATUS_LABELS[order.status]}
            </StatusBadge>
          </div>
          <h2 id="account-current-status-title">{ORDER_STATUS_LABELS[order.status]}</h2>
          <p className={styles.accountStatusCopy}>
            {ACCOUNT_STATUS_COPY[order.status]}
          </p>
          <dl className={styles.accountStatusMetadata}>
            <div>
              <dt>Last updated</dt>
              <dd>
                <time dateTime={order.updated_at}>
                  {formatCustomerDate(order.updated_at)}
                </time>
              </dd>
            </div>
          </dl>
        </section>

        <section
          className={styles.accountSummaryPanel}
          aria-labelledby="account-order-summary-heading"
        >
          <div className={styles.accountSectionHeading}>
            <p>Order items</p>
            <h2 id="account-order-summary-heading">What you ordered</h2>
          </div>

          <dl className={styles.accountMetadata}>
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
              <dd>
                <time dateTime={order.created_at}>
                  {formatCustomerDate(order.created_at)}
                </time>
              </dd>
            </div>
          </dl>

          <ul className={styles.accountItemList} aria-label="Ordered items">
            {order.items.map((item) => (
              <li key={item.menu_item_id} data-order-item-id={item.menu_item_id}>
                <div className={styles.accountItemIdentity}>
                  <strong>{item.name}</strong>
                  <span>Quantity: {item.quantity}</span>
                </div>
                <dl className={styles.accountItemAmounts}>
                  <div>
                    <dt>Unit price</dt>
                    <dd>
                      {formatCustomerMoney(item.unit_price_amount, order.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt>Line total</dt>
                    <dd>
                      {formatCustomerMoney(item.line_total_amount, order.currency)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>

          <div className={styles.accountTotalsBlock}>
            <p>Amounts in {order.currency} from your confirmed order.</p>
            <dl className={styles.accountTotals}>
              <div>
                <dt>Subtotal</dt>
                <dd>{formatCustomerMoney(order.subtotal_amount, order.currency)}</dd>
              </div>
              <div className={styles.accountTotalRow}>
                <dt>Total</dt>
                <dd>{formatCustomerMoney(order.total_amount, order.currency)}</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>
    );
  }

  return (
    <>
      {isPublicStatus ? (
        <>
          <OrderStatusTimeline mode="authoritative-current" status={order.status} />
          <div className={styles.orderContext}>
            <p className={styles.orderNumberLabel}>Public order number</p>
            <p className={styles.orderNumber}>{order.public_order_number}</p>
          </div>
          <section
            className={styles.freshnessPanel}
            aria-label="Order update information"
          >
            <div className={styles.freshnessTimestamp}>
              <p>Order updated</p>
              <time dateTime={order.updated_at}>
                {formatCustomerDate(order.updated_at)}
              </time>
            </div>
            {isRefreshing ? (
              <p className={styles.refreshing} aria-hidden="true" aria-live="off">
                <span className={styles.refreshSpinner} />
                Checking for the latest update…
              </p>
            ) : (
              <p className={styles.updateMode}>
                {isStopped
                  ? isFinalStatus
                    ? 'Automatic updates have stopped for this final fulfilment state.'
                    : 'Automatic updates have stopped.'
                  : 'This page checks automatically while it is open and online.'}
              </p>
            )}
          </section>
        </>
      ) : (
        <>
          <section
            className={styles.currentPanel}
            aria-labelledby="current-status-title"
          >
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
        </>
      )}

      <section
        className={`${styles.summaryPanel} ${
          isPublicStatus ? styles.publicSummaryPanel : ''
        }`}
        aria-labelledby="order-summary-heading"
      >
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
          {!isPublicStatus && (
            <div>
              <dt>Last updated</dt>
              <dd>{formatCustomerDate(order.updated_at)}</dd>
            </div>
          )}
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
