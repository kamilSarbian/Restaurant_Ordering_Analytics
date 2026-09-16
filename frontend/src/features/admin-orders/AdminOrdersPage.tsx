import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { AdminApiRequestError } from '../../api/adminApi';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import StatusBadge, { type StatusBadgeVariant } from '../../components/ui/StatusBadge';
import { useAuth } from '../auth/AuthContext';
import {
  type AdminOrderListResponse,
  fetchAdminOrders,
  formatAdminDate,
  formatAdminMoney,
  getOrderStatusLabel,
  getOrderTypeLabel,
  ORDER_STATUSES,
  ORDER_TYPES,
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

type OrdersState = {
  data: AdminOrderListResponse | null;
  dataQueryKey: string | null;
  error: string | null;
  errorQueryKey: string | null;
  loading: boolean;
  requestMode: LoadMode | null;
};

type LoadMode = 'refresh' | 'replace' | 'retry';

interface ActiveRequest {
  controller: AbortController;
  queryKey: string;
}

interface PendingOrdersFocus {
  origin: HTMLButtonElement;
  target: 'result' | 'trigger';
}

function shouldRestoreAsyncFocus(origin: HTMLElement): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement === null ||
    activeElement === document.body ||
    activeElement === origin ||
    !activeElement.isConnected
  );
}

function isOrderStatus(value: string | null): value is OrderStatus {
  return value !== null && (ORDER_STATUSES as readonly string[]).includes(value);
}

function isOrderType(value: string | null): value is OrderType {
  return value !== null && (ORDER_TYPES as readonly string[]).includes(value);
}

function parseOffset(value: string | null): number {
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) return 0;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset % PAGE_LIMIT === 0 ? offset : 0;
}

function parseOrdersQuery(searchParams: URLSearchParams): OrdersQuery {
  const status = searchParams.get('status');
  const orderType = searchParams.get('order_type');
  return {
    offset: parseOffset(searchParams.get('offset')),
    orderType: isOrderType(orderType) ? orderType : '',
    status: isOrderStatus(status) ? status : '',
  };
}

function buildOrdersSearchParams(query: OrdersQuery): URLSearchParams {
  const searchParams = new URLSearchParams();
  if (query.status !== '') searchParams.set('status', query.status);
  if (query.orderType !== '') searchParams.set('order_type', query.orderType);
  if (query.offset > 0) searchParams.set('offset', String(query.offset));
  return searchParams;
}

function buildQueryKey(query: OrdersQuery): string {
  return `${query.status}|${query.orderType}|${query.offset}`;
}

function statusVariant(status: OrderStatus): StatusBadgeVariant {
  return {
    accepted: 'info',
    cancelled: 'danger',
    completed: 'success',
    created: 'neutral',
    preparing: 'warning',
    ready: 'info',
  }[status] as StatusBadgeVariant;
}

function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <StatusBadge
      className={status === 'ready' ? styles.readyStatus : undefined}
      variant={statusVariant(status)}
    >
      {getOrderStatusLabel(status)}
    </StatusBadge>
  );
}

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
                <Link
                  className={styles.orderLink}
                  to={`/admin/orders/${order.publicOrderNumber}`}
                >
                  {order.publicOrderNumber}
                </Link>
              </th>
              <td>
                <OrderStatusBadge status={order.status} />
              </td>
              <td>{getOrderTypeLabel(order.orderType)}</td>
              <td>{order.tableNumber ?? 'Not applicable'}</td>
              <td className={styles.amount}>
                {formatAdminMoney(order.totalAmount, order.currency)}
              </td>
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
              <header className={styles.cardHeader}>
                <div>
                  <p>Order</p>
                  <h2 id={headingId}>{order.publicOrderNumber}</h2>
                </div>
                <OrderStatusBadge status={order.status} />
              </header>
              <dl className={styles.cardDetails}>
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
                  <dd className={styles.amount}>
                    {formatAdminMoney(order.totalAmount, order.currency)}
                  </dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={order.createdAt}>
                      {formatAdminDate(order.createdAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>
                    <time dateTime={order.updatedAt}>
                      {formatAdminDate(order.updatedAt)}
                    </time>
                  </dd>
                </div>
              </dl>
              <Link
                aria-label={`View order ${order.publicOrderNumber}`}
                className={styles.cardAction}
                to={`/admin/orders/${order.publicOrderNumber}`}
              >
                View order
              </Link>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export default function AdminOrdersPage() {
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    refreshCurrentUser,
  } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const serializedSearch = searchParams.toString();
  const query = useMemo(
    () => parseOrdersQuery(new URLSearchParams(serializedSearch)),
    [serializedSearch],
  );
  const canonicalSearch = useMemo(
    () => buildOrdersSearchParams(query).toString(),
    [query],
  );
  const queryKey = buildQueryKey(query);
  const [state, setState] = useState<OrdersState>({
    data: null,
    dataQueryKey: null,
    error: null,
    errorQueryKey: null,
    loading: true,
    requestMode: 'replace',
  });
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const emptyHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const generationRef = useRef(0);
  const pendingFocusRef = useRef<PendingOrdersFocus | null>(null);
  const restoreFilterFocusRef = useRef(false);
  const resultSummaryRef = useRef<HTMLParagraphElement | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);
  const statusSelectRef = useRef<HTMLSelectElement | null>(null);

  const loadOrders = useCallback(
    async (mode: LoadMode) => {
      if (activeRequestRef.current?.queryKey === queryKey) return;
      const authSession = getAuthenticatedSession();
      if (authSession === null) {
        logout();
        return;
      }

      generationRef.current += 1;
      const generation = generationRef.current;
      activeRequestRef.current?.controller.abort();
      const controller = new AbortController();
      activeRequestRef.current = { controller, queryKey };
      setState((current) => {
        const retainData = mode !== 'replace' && current.dataQueryKey === queryKey;
        const retainError = mode === 'retry' && current.errorQueryKey === queryKey;
        return {
          data: retainData ? current.data : null,
          dataQueryKey: retainData ? current.dataQueryKey : null,
          error: retainError ? current.error : null,
          errorQueryKey: retainError ? current.errorQueryKey : null,
          loading: true,
          requestMode: mode,
        };
      });

      try {
        const data = await fetchAdminOrders(
          authSession.accessToken,
          {
            limit: PAGE_LIMIT,
            offset: query.offset,
            orderType: query.orderType || undefined,
            status: query.status || undefined,
          },
          controller.signal,
        );
        if (generation !== generationRef.current) return;
        activeRequestRef.current = null;
        setState({
          data,
          dataQueryKey: queryKey,
          error: null,
          errorQueryKey: null,
          loading: false,
          requestMode: null,
        });
      } catch (error: unknown) {
        if (generation !== generationRef.current) return;
        activeRequestRef.current = null;
        if (error instanceof AdminApiRequestError && error.kind === 'aborted') {
          return;
        }
        if (error instanceof AdminApiRequestError && error.status === 401) {
          invalidateSessionIfCurrent(authSession);
          return;
        }
        if (error instanceof AdminApiRequestError && error.status === 403) {
          await refreshCurrentUser();
          if (generation !== generationRef.current) return;
        }
        setState((current) => {
          const retainData = current.dataQueryKey === queryKey;
          return {
            data: retainData ? current.data : null,
            dataQueryKey: retainData ? current.dataQueryKey : null,
            error: getListErrorMessage(error),
            errorQueryKey: queryKey,
            loading: false,
            requestMode: null,
          };
        });
      }
    },
    [
      getAuthenticatedSession,
      invalidateSessionIfCurrent,
      logout,
      query.offset,
      query.orderType,
      query.status,
      queryKey,
      refreshCurrentUser,
    ],
  );

  useEffect(() => {
    if (serializedSearch !== canonicalSearch) {
      setSearchParams(buildOrdersSearchParams(query), { replace: true });
    }
  }, [canonicalSearch, query, serializedSearch, setSearchParams]);

  useEffect(() => {
    const requestStartId = window.setTimeout(() => void loadOrders('replace'), 0);
    return () => {
      window.clearTimeout(requestStartId);
      generationRef.current += 1;
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
    };
  }, [loadOrders]);

  const activeData = state.dataQueryKey === queryKey ? state.data : null;
  const activeError = state.errorQueryKey === queryKey ? state.error : null;
  const filtersActive = query.status !== '' || query.orderType !== '';
  const hasPreviousPage = activeData !== null && activeData.offset > 0;
  const hasNextPage =
    activeData !== null &&
    activeData.offset + activeData.items.length < activeData.total;
  const showPagination = hasPreviousPage || hasNextPage;
  const page =
    activeData === null
      ? Math.floor(query.offset / PAGE_LIMIT) + 1
      : Math.floor(activeData.offset / activeData.limit) + 1;
  const appliedFilters = [
    query.status === '' ? null : `Status: ${getOrderStatusLabel(query.status)}`,
    query.orderType === '' ? null : `Type: ${getOrderTypeLabel(query.orderType)}`,
  ].filter((value): value is string => value !== null);

  useEffect(() => {
    if (!restoreFilterFocusRef.current) return;
    restoreFilterFocusRef.current = false;
    statusSelectRef.current?.focus();
  }, [canonicalSearch]);

  useEffect(() => {
    const pendingFocus = pendingFocusRef.current;
    if (state.loading || pendingFocus === null) return;
    if (activeData === null && activeError === null) return;
    pendingFocusRef.current = null;
    if (!shouldRestoreAsyncFocus(pendingFocus.origin)) return;
    if (pendingFocus.target === 'trigger') {
      if (pendingFocus.origin.isConnected && !pendingFocus.origin.disabled) {
        pendingFocus.origin.focus();
      }
      return;
    }
    if (activeError !== null) {
      retryButtonRef.current?.focus();
      return;
    }
    if (activeData?.items.length === 0) {
      emptyHeadingRef.current?.focus();
      return;
    }
    resultSummaryRef.current?.focus();
  }, [activeData, activeError, state.loading]);

  const updateQuery = useCallback(
    (nextQuery: OrdersQuery) => {
      setSearchParams(buildOrdersSearchParams(nextQuery));
    },
    [setSearchParams],
  );

  const retryOrders = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      pendingFocusRef.current = {
        origin: event.currentTarget,
        target: 'result',
      };
      void loadOrders('retry');
    },
    [loadOrders],
  );

  return (
    <section className={styles.page} aria-labelledby="orders-heading">
      <header className={styles.pageHeader}>
        <div>
          <p className="eyebrow">Order operations</p>
          <h1 id="orders-heading">Orders</h1>
          <p>Review server-ordered fulfilment records and open exact order details.</p>
        </div>
        <Button
          disabled={state.loading}
          loading={state.loading && state.requestMode === 'refresh'}
          loadingLabel="Refreshing orders"
          size="md"
          type="button"
          variant="secondary"
          onClick={(event) => {
            pendingFocusRef.current = {
              origin: event.currentTarget,
              target: 'trigger',
            };
            void loadOrders('refresh');
          }}
        >
          Refresh
        </Button>
      </header>

      <fieldset className={styles.filters} aria-describedby="filter-guidance">
        <legend>Filter orders</legend>
        <p id="filter-guidance" className={styles.filterGuidance}>
          Selections apply immediately and always restart at page 1.
        </p>
        <div className={styles.filterFields}>
          <label>
            Status
            <select
              ref={statusSelectRef}
              value={query.status}
              onChange={(event) => {
                pendingFocusRef.current = null;
                const value = event.target.value;
                updateQuery({
                  ...query,
                  offset: 0,
                  status: isOrderStatus(value) ? value : '',
                });
              }}
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
              onChange={(event) => {
                pendingFocusRef.current = null;
                const value = event.target.value;
                updateQuery({
                  ...query,
                  offset: 0,
                  orderType: isOrderType(value) ? value : '',
                });
              }}
            >
              <option value="">All order types</option>
              <option value="dine_in">Dine in</option>
              <option value="takeaway">Takeaway</option>
            </select>
          </label>
        </div>
        <div className={styles.appliedFilters}>
          <p>
            <span>Applied view</span>
            <strong>
              {appliedFilters.length === 0
                ? 'All statuses and order types'
                : appliedFilters.join(' / ')}
            </strong>
          </p>
          {filtersActive ? (
            <Button
              size="md"
              type="button"
              variant="ghost"
              onClick={() => {
                pendingFocusRef.current = null;
                restoreFilterFocusRef.current = true;
                updateQuery({ offset: 0, orderType: '', status: '' });
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      </fieldset>

      {state.loading && activeData === null && activeError === null ? (
        <Notice role="status" title="Loading orders" variant="info">
          The current server-ordered page is being requested.
        </Notice>
      ) : null}

      {state.loading && activeData !== null && activeError === null ? (
        <Notice role="status" title="Refreshing current page" variant="info">
          Existing rows remain visible while the same authoritative query is refreshed.
        </Notice>
      ) : null}

      {activeError !== null ? (
        <Notice
          role="alert"
          title={
            activeData === null ? 'Unable to load orders' : 'Orders refresh failed'
          }
          variant="danger"
        >
          <div className={styles.errorBody}>
            <p>{activeError}</p>
            <Button
              ref={retryButtonRef}
              disabled={state.loading}
              loading={state.loading && state.requestMode === 'retry'}
              loadingLabel="Retrying orders"
              size="md"
              type="button"
              variant="secondary"
              onClick={retryOrders}
            >
              Retry orders
            </Button>
          </div>
        </Notice>
      ) : null}

      {activeData !== null && activeData.items.length === 0 && activeError === null ? (
        <section className={styles.statePanel} aria-labelledby="orders-empty-heading">
          <h2 ref={emptyHeadingRef} id="orders-empty-heading" tabIndex={-1}>
            {activeData.offset > 0
              ? 'No orders on this page'
              : filtersActive
                ? 'No matching orders'
                : 'No orders yet'}
          </h2>
          <p>
            {activeData.offset > 0
              ? 'Return to the previous page to continue reviewing orders.'
              : filtersActive
                ? 'No orders match the applied filters.'
                : 'Orders will appear here after they are created.'}
          </p>
        </section>
      ) : null}

      {activeData !== null && activeData.items.length > 0 ? (
        <section
          className={styles.results}
          aria-busy={state.loading}
          aria-labelledby="orders-results-heading"
        >
          <p
            ref={resultSummaryRef}
            className={styles.resultSummary}
            id="orders-results-heading"
            tabIndex={-1}
            aria-live="polite"
          >
            Showing {activeData.offset + 1}&ndash;
            {activeData.offset + activeData.items.length} of {activeData.total}
          </p>
          <OrderTable data={activeData} />
          <OrderCards data={activeData} />
        </section>
      ) : null}

      {activeData !== null && showPagination ? (
        <nav className={styles.pagination} aria-label="Orders pagination">
          <Button
            disabled={state.loading || !hasPreviousPage}
            size="md"
            type="button"
            variant="secondary"
            onClick={(event) => {
              pendingFocusRef.current = {
                origin: event.currentTarget,
                target: 'result',
              };
              updateQuery({
                ...query,
                offset: Math.max(0, query.offset - PAGE_LIMIT),
              });
            }}
          >
            Previous
          </Button>
          <span aria-current="page">Page {page}</span>
          <Button
            disabled={state.loading || !hasNextPage}
            size="md"
            type="button"
            variant="secondary"
            onClick={(event) => {
              pendingFocusRef.current = {
                origin: event.currentTarget,
                target: 'result',
              };
              updateQuery({ ...query, offset: query.offset + PAGE_LIMIT });
            }}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
