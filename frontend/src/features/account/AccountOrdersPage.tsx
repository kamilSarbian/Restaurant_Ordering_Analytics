import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { AuthenticatedApiRequestError } from '../../api/authenticatedApi';
import BrandMark from '../../components/branding/BrandMark';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import StatusBadge, { type StatusBadgeVariant } from '../../components/ui/StatusBadge';
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

interface OrdersState {
  data: AccountOrdersResponse | null;
  error: string | null;
  loading: boolean;
}

interface OrderStatusPresentation {
  label: string;
  variant: StatusBadgeVariant;
}

interface CollectionFocusIntent {
  readonly origin: HTMLElement | null;
}

function getFocusOrigin(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function shouldRestoreAsyncFocus(origin: HTMLElement | null): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement === null ||
    activeElement === document.body ||
    activeElement === origin ||
    !activeElement.isConnected ||
    (activeElement instanceof HTMLButtonElement && activeElement.disabled)
  );
}

const ORDER_STATUS_PRESENTATIONS: Record<
  AccountOrderListItem['status'],
  OrderStatusPresentation
> = {
  accepted: { label: 'Accepted', variant: 'info' },
  cancelled: { label: 'Cancelled', variant: 'danger' },
  completed: { label: 'Completed', variant: 'success' },
  created: { label: 'Order received', variant: 'neutral' },
  preparing: { label: 'Preparing', variant: 'warning' },
  ready: { label: 'Ready', variant: 'info' },
};

function getOrderTypeLabel(orderType: AccountOrderListItem['orderType']): string {
  return orderType === 'dine_in' ? 'Dine-in' : 'Takeaway';
}

function getListErrorMessage(error: unknown): string {
  if (!(error instanceof AuthenticatedApiRequestError)) {
    return 'Your orders could not be loaded. Check your connection and try again.';
  }
  if (error.kind === 'timeout' || error.kind === 'network') {
    return 'Your orders could not be reached. Check your connection and try again.';
  }
  if (error.kind === 'invalid-response') {
    return 'We received an unexpected response while loading your orders. Try again shortly.';
  }
  if (error.status === 422) {
    return 'This page of orders could not be loaded. Try again.';
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return 'Your orders are temporarily unavailable. Try again shortly.';
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

function OrderStatus({ status }: { status: AccountOrderListItem['status'] }) {
  const presentation = ORDER_STATUS_PRESENTATIONS[status];
  return (
    <StatusBadge className={styles.statusBadge} variant={presentation.variant}>
      {presentation.label}
    </StatusBadge>
  );
}

function OrderList({ data }: { data: AccountOrdersResponse }) {
  return (
    <div className={styles.orderCollection}>
      <div className={styles.columnHeadings} aria-hidden="true">
        <span>Order</span>
        <span>Status</span>
        <span>Type</span>
        <span>Total</span>
        <span>Created</span>
        <span>Updated</span>
      </div>
      <ul className={styles.orderList} aria-label="Your orders, newest first">
        {data.items.map((order) => {
          const headingId = `account-order-${order.publicOrderNumber}`;
          return (
            <li
              className={styles.orderItem}
              data-order-number={order.publicOrderNumber}
              key={order.publicOrderNumber}
            >
              <article className={styles.orderRow} aria-labelledby={headingId}>
                <div className={styles.orderIdentity}>
                  <span className={styles.fieldLabel}>Order</span>
                  <h2 id={headingId}>
                    <Link
                      className={styles.orderLink}
                      to={`/account/orders/${order.publicOrderNumber}`}
                    >
                      <span className={styles.orderNumber}>
                        {order.publicOrderNumber}
                      </span>
                    </Link>
                  </h2>
                </div>
                <dl className={styles.orderDetails}>
                  <div className={styles.statusField}>
                    <dt className={styles.fieldLabel}>Status</dt>
                    <dd>
                      <OrderStatus status={order.status} />
                    </dd>
                  </div>
                  <div>
                    <dt className={styles.fieldLabel}>Type</dt>
                    <dd>{getOrderTypeLabel(order.orderType)}</dd>
                  </div>
                  <div>
                    <dt className={styles.fieldLabel}>Total</dt>
                    <dd>
                      <OrderTotal order={order} />
                    </dd>
                  </div>
                  <div>
                    <dt className={styles.fieldLabel}>Created</dt>
                    <dd>
                      <time dateTime={order.createdAt}>
                        {formatCustomerDate(order.createdAt)}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt className={styles.fieldLabel}>Updated</dt>
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
    </div>
  );
}

/** Display one authenticated user's personally owned order history. */
export default function AccountOrdersPage() {
  const { getAuthenticatedSession, invalidateSessionIfCurrent, logout, phase } =
    useAuth();
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState<OrdersState>({
    data: null,
    error: null,
    loading: true,
  });
  const activeControllerRef = useRef<AbortController | null>(null);
  const emptyStateRef = useRef<HTMLDivElement | null>(null);
  const focusAfterRequestRef = useRef<CollectionFocusIntent | null>(null);
  const generationRef = useRef(0);
  const resultSummaryRef = useRef<HTMLParagraphElement | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);

  const loadOrders = useCallback(async () => {
    if (phase !== 'authenticated') {
      return;
    }
    if (activeControllerRef.current !== null) {
      return;
    }
    const authSession = getAuthenticatedSession();
    if (authSession === null) {
      logout();
      return;
    }

    generationRef.current += 1;
    const generation = generationRef.current;
    const controller = new AbortController();
    activeControllerRef.current = controller;
    setState((current) => ({ ...current, error: null, loading: true }));

    try {
      const data = await fetchAccountOrders({
        accessToken: authSession.accessToken,
        limit: PAGE_LIMIT,
        offset,
        signal: controller.signal,
      });
      if (generation === generationRef.current) {
        activeControllerRef.current = null;
        setState({ data, error: null, loading: false });
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
      setState((current) => ({
        ...current,
        error: getListErrorMessage(error),
        loading: false,
      }));
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

  useEffect(() => {
    const focusIntent = focusAfterRequestRef.current;
    if (focusIntent === null || state.loading) {
      return;
    }
    focusAfterRequestRef.current = null;
    if (!shouldRestoreAsyncFocus(focusIntent.origin)) {
      return;
    }
    if (state.error !== null) {
      retryButtonRef.current?.focus();
      return;
    }
    if (state.data === null) {
      return;
    }

    const focusTarget =
      state.data.items.length > 0 ? resultSummaryRef.current : emptyStateRef.current;
    focusTarget?.focus();
  }, [state.data, state.error, state.loading]);

  const data = state.data;
  const hasPreviousPage = data !== null && data.offset > 0;
  const hasNextPage = data !== null && data.offset + data.items.length < data.total;
  const showPagination = hasPreviousPage || hasNextPage;
  const page = data === null ? 1 : Math.floor(data.offset / PAGE_LIMIT) + 1;

  function requestPage(nextOffset: number): void {
    if (state.loading || state.error !== null || nextOffset === offset) {
      return;
    }
    focusAfterRequestRef.current = { origin: getFocusOrigin() };
    setState((current) => ({ ...current, loading: true }));
    setOffset(nextOffset);
  }

  function retryOrders(): void {
    if (state.loading) {
      return;
    }
    focusAfterRequestRef.current = { origin: getFocusOrigin() };
    void loadOrders();
  }

  return (
    <section
      className={`${styles.page} ${styles.overviewPage}`}
      aria-labelledby="account-orders-heading"
    >
      <header className={styles.overviewHeader}>
        <div className={styles.brandLockup}>
          <BrandMark size={24} />
          <span>Nordic Hearth</span>
        </div>
        <div className={styles.headingGroup}>
          <p className="eyebrow">My account</p>
          <h1 id="account-orders-heading">My orders</h1>
          <p>Review orders placed while signed in to this account.</p>
        </div>
      </header>

      {state.loading && data === null && state.error === null ? (
        <Notice className={styles.stateNotice} role="status" variant="info">
          <h2>Loading your orders</h2>
          <p>We are gathering the latest orders for this account.</p>
        </Notice>
      ) : null}

      {state.error !== null ? (
        <Notice className={styles.stateNotice} role="alert" variant="danger">
          <h2>Unable to load your orders</h2>
          <p>{state.error}</p>
          <Button
            ref={retryButtonRef}
            aria-busy={state.loading || undefined}
            className={styles.retryAction}
            disabled={state.loading}
            variant="secondary"
            onClick={retryOrders}
          >
            Retry
          </Button>
        </Notice>
      ) : null}

      {state.loading && data !== null && state.error === null ? (
        <Notice className={styles.progressNotice} role="status" variant="info">
          <p>Updating your orders while the current page stays available.</p>
        </Notice>
      ) : null}

      {data !== null && data.items.length === 0 && state.error === null ? (
        <div ref={emptyStateRef} className={styles.overviewState} tabIndex={-1}>
          <h2>{data.offset === 0 ? 'No orders yet' : 'No orders on this page'}</h2>
          <p>
            {data.offset === 0
              ? 'Orders placed while you are signed in will appear here.'
              : 'Return to an earlier page to continue reviewing your orders.'}
          </p>
          {data.offset === 0 ? (
            <Link className={styles.menuAction} to="/menu">
              Explore the menu
            </Link>
          ) : null}
        </div>
      ) : null}

      {data !== null && data.items.length > 0 ? (
        <div className={styles.results} aria-busy={state.loading}>
          <p
            ref={resultSummaryRef}
            className={styles.resultSummary}
            aria-live="polite"
            tabIndex={-1}
          >
            Showing {data.offset + 1}&ndash;{data.offset + data.items.length} of{' '}
            {data.total}
          </p>
          <OrderList data={data} />
        </div>
      ) : null}

      {data !== null && showPagination ? (
        <nav className={styles.pagination} aria-label="Your orders pagination">
          <Button
            className={styles.paginationAction}
            disabled={!hasPreviousPage || state.loading || state.error !== null}
            variant="secondary"
            onClick={() => requestPage(Math.max(0, data.offset - PAGE_LIMIT))}
          >
            Previous
          </Button>
          <span aria-current="page">Page {page}</span>
          <Button
            className={styles.paginationAction}
            disabled={!hasNextPage || state.loading || state.error !== null}
            variant="secondary"
            onClick={() => requestPage(data.offset + PAGE_LIMIT)}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
