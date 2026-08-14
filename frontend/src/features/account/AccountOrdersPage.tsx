import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { AuthenticatedApiRequestError } from '../../api/authenticatedApi';
import { useAuth } from '../auth/AuthContext';
import {
  formatCustomerDate,
  formatCustomerMoney,
} from '../order-status/OrderStatusSummary';
import {
  type AccountOrderListItem,
  type AccountOrdersResponse,
  fetchAccountOrders,
} from './accountApi';
import styles from './AccountOrdersPage.module.css';

const PAGE_LIMIT = 50;

type OrdersState =
  | { kind: 'loading' }
  | { data: AccountOrdersResponse; kind: 'success' }
  | { kind: 'error'; message: string };

const ORDER_STATUS_LABELS: Record<AccountOrderListItem['status'], string> = {
  accepted: 'Accepted',
  cancelled: 'Cancelled',
  completed: 'Completed',
  created: 'Order received',
  preparing: 'Preparing',
  ready: 'Ready',
};

function getOrderTypeLabel(orderType: AccountOrderListItem['orderType']): string {
  return orderType === 'dine_in' ? 'Dine-in' : 'Takeaway';
}

function getListErrorMessage(error: unknown): string {
  if (!(error instanceof AuthenticatedApiRequestError)) {
    return 'Your orders could not be loaded. Check your connection and try again.';
  }
  if (error.kind === 'timeout' || error.kind === 'network') {
    return 'The orders service could not be reached. Check your connection and try again.';
  }
  if (error.kind === 'invalid-response') {
    return 'The orders service returned an unexpected response. Try again later.';
  }
  if (error.status === 422) {
    return 'The requested order page is not valid. Return to the first page and try again.';
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return 'The orders service is temporarily unavailable. Try again later.';
  }
  return 'Your orders could not be loaded. Try again.';
}

function OrderTotal({ order }: { order: AccountOrderListItem }) {
  return (
    <span className={styles.total}>
      <span>{formatCustomerMoney(order.totalAmount, order.currency)}</span>
      <small>{order.currency}</small>
    </span>
  );
}

function OrderTable({ data }: { data: AccountOrdersResponse }) {
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <caption>Your orders, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Status</th>
            <th scope="col">Type</th>
            <th scope="col">Total</th>
            <th scope="col">Created</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((order) => (
            <tr key={order.publicOrderNumber}>
              <th scope="row">
                <Link to={`/account/orders/${order.publicOrderNumber}`}>
                  {order.publicOrderNumber}
                </Link>
              </th>
              <td>
                <span className={styles.status} data-status={order.status}>
                  {ORDER_STATUS_LABELS[order.status]}
                </span>
              </td>
              <td>{getOrderTypeLabel(order.orderType)}</td>
              <td>
                <OrderTotal order={order} />
              </td>
              <td>
                <time dateTime={order.createdAt}>
                  {formatCustomerDate(order.createdAt)}
                </time>
              </td>
              <td>
                <time dateTime={order.updatedAt}>
                  {formatCustomerDate(order.updatedAt)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrderCards({ data }: { data: AccountOrdersResponse }) {
  return (
    <ul className={styles.cards} aria-label="Your orders, newest first">
      {data.items.map((order) => {
        const headingId = `account-order-${order.publicOrderNumber}`;
        return (
          <li className={styles.card} key={order.publicOrderNumber}>
            <article aria-labelledby={headingId}>
              <h2 id={headingId}>
                <Link to={`/account/orders/${order.publicOrderNumber}`}>
                  {order.publicOrderNumber}
                </Link>
              </h2>
              <dl className={styles.cardDetails}>
                <div>
                  <dt>Status</dt>
                  <dd>
                    <span className={styles.status} data-status={order.status}>
                      {ORDER_STATUS_LABELS[order.status]}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{getOrderTypeLabel(order.orderType)}</dd>
                </div>
                <div>
                  <dt>Total</dt>
                  <dd>
                    <OrderTotal order={order} />
                  </dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={order.createdAt}>
                      {formatCustomerDate(order.createdAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>
                    <time dateTime={order.updatedAt}>
                      {formatCustomerDate(order.updatedAt)}
                    </time>
                  </dd>
                </div>
              </dl>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

/** Display one authenticated user's personally owned order history. */
export default function AccountOrdersPage() {
  const { getAuthenticatedSession, invalidateSessionIfCurrent, logout, phase } =
    useAuth();
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState<OrdersState>({ kind: 'loading' });
  const activeControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const loadOrders = useCallback(async () => {
    if (phase !== 'authenticated') {
      return;
    }
    const authSession = getAuthenticatedSession();
    if (authSession === null) {
      logout();
      return;
    }

    generationRef.current += 1;
    const generation = generationRef.current;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    setState({ kind: 'loading' });

    try {
      const data = await fetchAccountOrders({
        accessToken: authSession.accessToken,
        limit: PAGE_LIMIT,
        offset,
        signal: controller.signal,
      });
      if (generation === generationRef.current) {
        activeControllerRef.current = null;
        setState({ data, kind: 'success' });
      }
    } catch (error: unknown) {
      if (generation !== generationRef.current) {
        return;
      }
      activeControllerRef.current = null;
      if (error instanceof AuthenticatedApiRequestError && error.kind === 'aborted') {
        return;
      }
      if (error instanceof AuthenticatedApiRequestError && error.status === 401) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      setState({ kind: 'error', message: getListErrorMessage(error) });
    }
  }, [getAuthenticatedSession, invalidateSessionIfCurrent, logout, offset, phase]);

  useEffect(() => {
    if (phase !== 'authenticated') {
      return undefined;
    }
    const requestStartId = window.setTimeout(() => void loadOrders(), 0);
    return () => {
      window.clearTimeout(requestStartId);
      generationRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, [loadOrders, phase]);

  const page = Math.floor(offset / PAGE_LIMIT) + 1;

  return (
    <section className={styles.page} aria-labelledby="account-orders-heading">
      <header className={styles.pageHeader}>
        <div>
          <p className="eyebrow">My account</p>
          <h1 id="account-orders-heading">My orders</h1>
          <p>Review orders placed while signed in to this account.</p>
        </div>
      </header>

      {state.kind === 'loading' ? (
        <div className={styles.statePanel} role="status" aria-live="polite">
          <h2>Loading your orders</h2>
          <p>Your latest order page is being requested.</p>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div className={styles.statePanel} role="alert" aria-live="assertive">
          <h2>Unable to load your orders</h2>
          <p>{state.message}</p>
          <button
            className={styles.retryButton}
            type="button"
            onClick={() => void loadOrders()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === 'success' && state.data.items.length === 0 ? (
        <div className={styles.statePanel}>
          <h2>No orders yet</h2>
          <p>Orders placed while you are signed in will appear here.</p>
        </div>
      ) : null}

      {state.kind === 'success' && state.data.items.length > 0 ? (
        <div className={styles.results}>
          <p className={styles.resultSummary} aria-live="polite">
            Showing {state.data.offset + 1}–
            {state.data.offset + state.data.items.length} of {state.data.total}
          </p>
          <OrderTable data={state.data} />
          <OrderCards data={state.data} />
        </div>
      ) : null}

      {state.kind === 'success' && state.data.total > 0 ? (
        <nav className={styles.pagination} aria-label="Your orders pagination">
          <button
            className={styles.retryButton}
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset((current) => Math.max(0, current - PAGE_LIMIT))}
          >
            Previous
          </button>
          <span aria-current="page">Page {page}</span>
          <button
            className={styles.retryButton}
            type="button"
            disabled={state.data.offset + state.data.items.length >= state.data.total}
            onClick={() => setOffset((current) => current + PAGE_LIMIT)}
          >
            Next
          </button>
        </nav>
      ) : null}
    </section>
  );
}
