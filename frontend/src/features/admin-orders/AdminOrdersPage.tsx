import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { AdminApiRequestError } from '../../api/adminApi';
import { useAdminAuth } from '../admin-auth/AdminAuthContext';
import {
  type AdminOrderListResponse,
  fetchAdminOrders,
  formatAdminDate,
  formatAdminMoney,
  getOrderStatusLabel,
  getOrderTypeLabel,
  ORDER_STATUSES,
  type OrderStatus,
  type OrderType,
} from './adminOrdersApi';
import styles from './AdminOrdersPage.module.css';

const PAGE_LIMIT = 50;

interface OrdersQuery {
  offset: number;
  orderType: OrderType | '';
  status: OrderStatus | '';
}

type OrdersState =
  | { kind: 'loading' }
  | { data: AdminOrderListResponse; kind: 'success' }
  | { kind: 'error'; message: string };

function getListErrorMessage(error: unknown): string {
  if (!(error instanceof AdminApiRequestError)) {
    return 'The orders could not be loaded. Check your connection and try again.';
  }
  if (error.kind === 'timeout' || error.kind === 'network') {
    return 'The orders service could not be reached. Check your connection and try again.';
  }
  if (error.kind === 'invalid-response') {
    return 'The orders service returned an unexpected response. Try again later.';
  }
  if (error.status === 422) {
    return 'The selected order filters are not valid. Reset them and try again.';
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return 'The orders service is temporarily unavailable. Try again later.';
  }
  return 'The orders could not be loaded. Try again.';
}

function OrderTable({ data }: { data: AdminOrderListResponse }) {
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <caption>Administrator orders, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Status</th>
            <th scope="col">Type</th>
            <th scope="col">Table</th>
            <th scope="col">Total</th>
            <th scope="col">Created</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((order) => (
            <tr key={order.publicOrderNumber}>
              <th scope="row">
                <Link to={`/admin/orders/${order.publicOrderNumber}`}>
                  {order.publicOrderNumber}
                </Link>
              </th>
              <td>
                <span className={styles.status} data-status={order.status}>
                  {getOrderStatusLabel(order.status)}
                </span>
              </td>
              <td>{getOrderTypeLabel(order.orderType)}</td>
              <td>{order.tableNumber ?? 'Not applicable'}</td>
              <td>{formatAdminMoney(order.totalAmount, order.currency)}</td>
              <td>
                <time dateTime={order.createdAt}>
                  {formatAdminDate(order.createdAt)}
                </time>
              </td>
              <td>
                <time dateTime={order.updatedAt}>
                  {formatAdminDate(order.updatedAt)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrderCards({ data }: { data: AdminOrderListResponse }) {
  return (
    <ul className={styles.cards} aria-label="Administrator orders, newest first">
      {data.items.map((order) => {
        const headingId = `order-${order.publicOrderNumber}`;
        return (
          <li className={styles.card} key={order.publicOrderNumber}>
            <article aria-labelledby={headingId}>
              <h2 id={headingId}>
                <Link to={`/admin/orders/${order.publicOrderNumber}`}>
                  {order.publicOrderNumber}
                </Link>
              </h2>
              <dl className={styles.cardDetails}>
                <div>
                  <dt>Status</dt>
                  <dd>
                    <span className={styles.status} data-status={order.status}>
                      {getOrderStatusLabel(order.status)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{getOrderTypeLabel(order.orderType)}</dd>
                </div>
                <div>
                  <dt>Table</dt>
                  <dd>{order.tableNumber ?? 'Not applicable'}</dd>
                </div>
                <div>
                  <dt>Total</dt>
                  <dd>{formatAdminMoney(order.totalAmount, order.currency)}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={order.createdAt}>
                      {formatAdminDate(order.createdAt)}
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

export default function AdminOrdersPage() {
  const { expireSession, getAccessToken } = useAdminAuth();
  const [query, setQuery] = useState<OrdersQuery>({
    offset: 0,
    orderType: '',
    status: '',
  });
  const [state, setState] = useState<OrdersState>({ kind: 'loading' });
  const activeControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const loadOrders = useCallback(async () => {
    const accessToken = getAccessToken();
    if (accessToken === null) {
      expireSession();
      return;
    }

    generationRef.current += 1;
    const generation = generationRef.current;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    setState({ kind: 'loading' });

    try {
      const data = await fetchAdminOrders(
        accessToken,
        {
          limit: PAGE_LIMIT,
          offset: query.offset,
          orderType: query.orderType || undefined,
          status: query.status || undefined,
        },
        controller.signal,
      );
      if (generation === generationRef.current) {
        activeControllerRef.current = null;
        setState({ data, kind: 'success' });
      }
    } catch (error: unknown) {
      if (generation !== generationRef.current) {
        return;
      }
      activeControllerRef.current = null;
      if (error instanceof AdminApiRequestError && error.kind === 'aborted') {
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 401) {
        expireSession();
        return;
      }
      setState({ kind: 'error', message: getListErrorMessage(error) });
    }
  }, [expireSession, getAccessToken, query]);

  useEffect(() => {
    const requestStartId = window.setTimeout(() => void loadOrders(), 0);
    return () => {
      window.clearTimeout(requestStartId);
      generationRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, [loadOrders]);

  const filtersActive = query.status !== '' || query.orderType !== '';
  const page = Math.floor(query.offset / PAGE_LIMIT) + 1;

  return (
    <section className={styles.page} aria-labelledby="orders-heading">
      <header className={styles.pageHeader}>
        <div>
          <p className="eyebrow">Order operations</p>
          <h1 id="orders-heading">Orders</h1>
          <p>Review current orders and their read-only operational history.</p>
        </div>
        <button
          className={styles.secondaryButton}
          type="button"
          disabled={state.kind === 'loading'}
          onClick={() => void loadOrders()}
        >
          Refresh
        </button>
      </header>

      <div className={styles.filters} aria-label="Order filters">
        <label>
          Status
          <select
            value={query.status}
            onChange={(event) =>
              setQuery((current) => ({
                ...current,
                offset: 0,
                status: event.target.value as OrderStatus | '',
              }))
            }
          >
            <option value="">All statuses</option>
            {ORDER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {getOrderStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Order type
          <select
            value={query.orderType}
            onChange={(event) =>
              setQuery((current) => ({
                ...current,
                offset: 0,
                orderType: event.target.value as OrderType | '',
              }))
            }
          >
            <option value="">All order types</option>
            <option value="dine_in">Dine in</option>
            <option value="takeaway">Takeaway</option>
          </select>
        </label>
      </div>

      {state.kind === 'loading' ? (
        <div className={styles.statePanel} role="status" aria-live="polite">
          <h2>Loading orders</h2>
          <p>The latest order page is being requested.</p>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div className={styles.statePanel} role="alert" aria-live="assertive">
          <h2>Unable to load orders</h2>
          <p>{state.message}</p>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => void loadOrders()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === 'success' && state.data.items.length === 0 ? (
        <div className={styles.statePanel}>
          <h2>{filtersActive ? 'No matching orders' : 'No orders yet'}</h2>
          <p>
            {filtersActive
              ? 'No orders match the selected filters.'
              : 'Orders will appear here after they are created.'}
          </p>
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
        <nav className={styles.pagination} aria-label="Orders pagination">
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={query.offset === 0}
            onClick={() =>
              setQuery((current) => ({
                ...current,
                offset: Math.max(0, current.offset - PAGE_LIMIT),
              }))
            }
          >
            Previous
          </button>
          <span aria-current="page">Page {page}</span>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={state.data.offset + state.data.items.length >= state.data.total}
            onClick={() =>
              setQuery((current) => ({
                ...current,
                offset: current.offset + PAGE_LIMIT,
              }))
            }
          >
            Next
          </button>
        </nav>
      ) : null}
    </section>
  );
}
