import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';

import { AdminApiRequestError } from '../../api/adminApi';
import {
  buildAdminAwareDateRange,
  getDefaultAdminDateRange,
} from '../../components/admin/adminDateRange';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import StatusBadge, { type StatusBadgeVariant } from '../../components/ui/StatusBadge';
import {
  type AdminAnalyticsOverview,
  fetchAdminAnalyticsOverview,
  formatAnalyticsMoney,
} from '../admin-analytics/adminAnalyticsApi';
import {
  type AdminMenuItemListResponse,
  fetchAdminMenuItems,
} from '../admin-menu/adminMenuApi';
import {
  type AdminOrderListItem,
  type AdminOrderListResponse,
  fetchAdminOrders,
  formatAdminDate,
  formatAdminMoney,
  getOrderStatusLabel,
  type OrderStatus,
} from '../admin-orders/adminOrdersApi';
import { useAuth } from '../auth/AuthContext';
import styles from './AdminHomePage.module.css';

const RECENT_ORDERS_LIMIT = 6;
const MENU_SNAPSHOT_LIMIT = 100;
const DASHBOARD_SECTIONS = ['orders', 'menu', 'analytics'] as const;
const ATTENTION_ORDER_STATUSES = new Set<OrderStatus>(['created', 'ready']);

type DashboardSection = (typeof DASHBOARD_SECTIONS)[number];

interface PendingRetryFocus {
  origin: HTMLButtonElement;
  section: DashboardSection;
}

interface SectionState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

type DashboardResult =
  | { data: AdminAnalyticsOverview; section: 'analytics' }
  | { data: AdminMenuItemListResponse; section: 'menu' }
  | { data: AdminOrderListResponse; section: 'orders' }
  | { error: unknown; section: DashboardSection };

interface ReportingRange {
  end: string;
  endDate: string;
  start: string;
  startDate: string;
}

function initialSection<T>(): SectionState<T> {
  return { data: null, error: null, loading: true };
}

function sectionLabel(section: DashboardSection): string {
  return {
    analytics: 'Sales summary',
    menu: 'Menu availability',
    orders: 'Recent orders',
  }[section];
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

function getSectionErrorMessage(section: DashboardSection, error: unknown): string {
  const subject = sectionLabel(section).toLowerCase();
  if (!(error instanceof AdminApiRequestError)) {
    return `${subject} could not be loaded. Check your connection and try again.`;
  }
  if (error.kind === 'network' || error.kind === 'timeout') {
    return `${subject} could not be reached. Check your connection and try again.`;
  }
  if (error.kind === 'invalid-response') {
    return `${subject} returned an unexpected response. Try again.`;
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return `${subject} is temporarily unavailable. Try again.`;
  }
  return `${subject} could not be loaded. Try again.`;
}

function statusVariant(status: OrderStatus): StatusBadgeVariant {
  return {
    accepted: 'info',
    cancelled: 'danger',
    completed: 'neutral',
    created: 'warning',
    preparing: 'info',
    ready: 'success',
  }[status] as StatusBadgeVariant;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function KpiCard({
  context,
  label,
  value,
}: {
  context: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <article className={styles.kpiCard}>
      <dl>
        <div>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      </dl>
      <p>{context}</p>
    </article>
  );
}

function CurrencyValues({
  data,
  field,
}: {
  data: AdminAnalyticsOverview;
  field: 'averageOrderValueAmount' | 'collectedRevenueAmount';
}) {
  if (data.currencies.length === 0) {
    return <span className={styles.emptyValue}>No paid sales</span>;
  }
  return (
    <ul className={styles.currencyValues}>
      {data.currencies.map((entry) => (
        <li key={entry.currency}>
          <span>{entry.currency}</span>
          <strong>{formatAnalyticsMoney(entry[field], entry.currency)}</strong>
        </li>
      ))}
    </ul>
  );
}

function DataError({
  disabled,
  loading,
  message,
  onRetry,
  section,
}: {
  disabled: boolean;
  loading: boolean;
  message: string;
  onRetry: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  section: DashboardSection;
}) {
  const label = sectionLabel(section);
  return (
    <Notice role="status" title={`${label} unavailable`} variant="danger">
      <div className={styles.errorBody}>
        <p>{message}</p>
        <Button
          disabled={disabled}
          loading={loading}
          loadingLabel={`Retrying ${label.toLowerCase()}`}
          size="md"
          type="button"
          variant="secondary"
          onClick={onRetry}
        >
          Retry {label.toLowerCase()}
        </Button>
      </div>
    </Notice>
  );
}

function RecentOrderRow({ order }: { order: AdminOrderListItem }) {
  return (
    <li className={styles.orderRow}>
      <article>
        <div className={styles.orderIdentity}>
          <Link to={`/admin/orders/${order.publicOrderNumber}`}>
            {order.publicOrderNumber}
          </Link>
          <StatusBadge variant={statusVariant(order.status)}>
            {getOrderStatusLabel(order.status)}
          </StatusBadge>
        </div>
        <dl className={styles.orderFacts}>
          <div>
            <dt>Total</dt>
            <dd>{formatAdminMoney(order.totalAmount, order.currency)}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              <time dateTime={order.createdAt}>{formatAdminDate(order.createdAt)}</time>
            </dd>
          </div>
        </dl>
      </article>
    </li>
  );
}

/** Render a bounded, API-authoritative operational overview for administrators. */
export default function AdminHomePage() {
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    refreshCurrentUser,
    user,
  } = useAuth();
  const [reportingRange] = useState<ReportingRange>(() => {
    const selection = getDefaultAdminDateRange();
    return { ...selection, ...buildAdminAwareDateRange(selection) };
  });
  const [orders, setOrders] =
    useState<SectionState<AdminOrderListResponse>>(initialSection);
  const [menu, setMenu] =
    useState<SectionState<AdminMenuItemListResponse>>(initialSection);
  const [analytics, setAnalytics] =
    useState<SectionState<AdminAnalyticsOverview>>(initialSection);
  const activeControllerRef = useRef<AbortController | null>(null);
  const analyticsHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const generationRef = useRef(0);
  const menuHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const ordersHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const requestActiveRef = useRef(false);
  const retryFocusRef = useRef<PendingRetryFocus | null>(null);

  const setSectionLoading = useCallback((section: DashboardSection) => {
    const markLoading = <T,>(state: SectionState<T>): SectionState<T> => ({
      ...state,
      loading: true,
    });
    if (section === 'orders') setOrders(markLoading);
    if (section === 'menu') setMenu(markLoading);
    if (section === 'analytics') setAnalytics(markLoading);
  }, []);

  const runDashboard = useCallback(
    async (sections: readonly DashboardSection[] = DASHBOARD_SECTIONS) => {
      if (requestActiveRef.current) return;
      const authSession = getAuthenticatedSession();
      if (authSession === null) {
        logout();
        return;
      }

      requestActiveRef.current = true;
      generationRef.current += 1;
      const generation = generationRef.current;
      activeControllerRef.current?.abort();
      const controller = new AbortController();
      activeControllerRef.current = controller;
      sections.forEach(setSectionLoading);

      const requestSection = async (
        section: DashboardSection,
      ): Promise<DashboardResult> => {
        try {
          if (section === 'orders') {
            return {
              data: await fetchAdminOrders(
                authSession.accessToken,
                { limit: RECENT_ORDERS_LIMIT, offset: 0 },
                controller.signal,
              ),
              section,
            };
          }
          if (section === 'menu') {
            return {
              data: await fetchAdminMenuItems(
                authSession.accessToken,
                MENU_SNAPSHOT_LIMIT,
                0,
                controller.signal,
              ),
              section,
            };
          }
          return {
            data: await fetchAdminAnalyticsOverview(
              authSession.accessToken,
              { end: reportingRange.end, start: reportingRange.start },
              controller.signal,
            ),
            section,
          };
        } catch (error: unknown) {
          return { error, section };
        }
      };

      const results = await Promise.all(sections.map(requestSection));
      if (generationRef.current !== generation) return;
      activeControllerRef.current = null;
      requestActiveRef.current = false;

      const failedResults = results.filter(
        (result): result is Extract<DashboardResult, { error: unknown }> =>
          'error' in result,
      );
      if (
        failedResults.some(
          ({ error }) => error instanceof AdminApiRequestError && error.status === 401,
        )
      ) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (
        failedResults.some(
          ({ error }) => error instanceof AdminApiRequestError && error.status === 403,
        )
      ) {
        await refreshCurrentUser();
        if (generationRef.current !== generation) return;
      }

      results.forEach((result) => {
        if ('error' in result) {
          if (
            result.error instanceof AdminApiRequestError &&
            result.error.kind === 'aborted'
          ) {
            return;
          }
          const message = getSectionErrorMessage(result.section, result.error);
          if (result.section === 'orders') {
            setOrders((current) => ({ ...current, error: message, loading: false }));
          }
          if (result.section === 'menu') {
            setMenu((current) => ({ ...current, error: message, loading: false }));
          }
          if (result.section === 'analytics') {
            setAnalytics((current) => ({
              ...current,
              error: message,
              loading: false,
            }));
          }
          return;
        }
        if (result.section === 'orders') {
          setOrders({ data: result.data, error: null, loading: false });
        }
        if (result.section === 'menu') {
          setMenu({ data: result.data, error: null, loading: false });
        }
        if (result.section === 'analytics') {
          setAnalytics({ data: result.data, error: null, loading: false });
        }
      });
    },
    [
      getAuthenticatedSession,
      invalidateSessionIfCurrent,
      logout,
      refreshCurrentUser,
      reportingRange,
      setSectionLoading,
    ],
  );

  const retrySection = useCallback(
    (section: DashboardSection, origin: HTMLButtonElement) => {
      retryFocusRef.current = { origin, section };
      void runDashboard([section]);
    },
    [runDashboard],
  );

  useEffect(() => {
    const pendingFocus = retryFocusRef.current;
    if (pendingFocus === null) return;
    const { origin, section } = pendingFocus;
    const state = section === 'orders' ? orders : section === 'menu' ? menu : analytics;
    if (state.loading) return;

    retryFocusRef.current = null;
    if (!shouldRestoreAsyncFocus(origin)) return;
    if (state.error !== null || state.data === null) {
      if (origin.isConnected && !origin.disabled) origin.focus();
      return;
    }
    const heading =
      section === 'orders'
        ? ordersHeadingRef.current
        : section === 'menu'
          ? menuHeadingRef.current
          : analyticsHeadingRef.current;
    heading?.focus();
  }, [analytics, menu, orders]);

  useEffect(() => {
    const requestStartId = window.setTimeout(() => void runDashboard(), 0);
    return () => {
      window.clearTimeout(requestStartId);
      generationRef.current += 1;
      requestActiveRef.current = false;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, [runDashboard]);

  const recentAttentionOrders = useMemo(
    () =>
      orders.data?.items.filter((order) =>
        ATTENTION_ORDER_STATUSES.has(order.status),
      ) ?? [],
    [orders.data],
  );
  const menuSnapshotIsComplete =
    menu.data !== null && menu.data.items.length === menu.data.total;
  const snapshotUnavailableMenuItems = useMemo(
    () => menu.data?.items.filter((item) => item.isActive && !item.isAvailable) ?? [],
    [menu.data],
  );
  const unavailableMenuItems = menuSnapshotIsComplete
    ? snapshotUnavailableMenuItems
    : null;
  const isAnyLoading = orders.loading || menu.loading || analytics.loading;
  const hasInitialData =
    orders.data !== null || menu.data !== null || analytics.data !== null;
  const hasError =
    orders.error !== null || menu.error !== null || analytics.error !== null;
  const menuAttentionIsBounded = menu.data !== null && !menuSnapshotIsComplete;
  const attentionCount =
    recentAttentionOrders.length + snapshotUnavailableMenuItems.length;
  const emptyAttentionCopy = (() => {
    if (orders.data !== null && menuSnapshotIsComplete) {
      return 'No created or ready orders appear in the newest-order preview, and no active menu items are marked unavailable.';
    }
    if (orders.data !== null && menu.data !== null) {
      return `No created or ready orders appear in the newest-order preview, and no active unavailable items appear in the first ${menu.data.items.length} menu records returned. Open Menu for a full availability review.`;
    }
    if (orders.data !== null) {
      return 'No created or ready orders appear in the newest-order preview. Open Menu for a full availability review.';
    }
    if (menuSnapshotIsComplete) {
      return 'No active menu items are marked unavailable. Recent-order attention is not available in this snapshot.';
    }
    if (menu.data !== null) {
      return `No active unavailable items appear in the first ${menu.data.items.length} menu records returned. Open Menu for full availability; recent-order attention is not available.`;
    }
    return 'Available dashboard data contains no complete attention signal.';
  })();

  return (
    <section className={styles.page} aria-labelledby="admin-home-heading">
      <header className={styles.pageHeader}>
        <div>
          <p className="eyebrow">Operational overview</p>
          <h1 id="admin-home-heading">Administrator workspace</h1>
        </div>
        <p>
          Current order, menu, and seven-day sales signals from existing administrator
          data.
        </p>
      </header>

      {isAnyLoading && !hasInitialData && !hasError ? (
        <Notice role="status" title="Loading operational snapshot" variant="info">
          Orders, menu availability, and the sales summary are being requested.
        </Notice>
      ) : null}

      {hasError ? (
        <div className={styles.errorGrid} aria-label="Unavailable dashboard data">
          {orders.error !== null ? (
            <DataError
              disabled={isAnyLoading}
              loading={orders.loading}
              message={orders.error}
              section="orders"
              onRetry={(event) => retrySection('orders', event.currentTarget)}
            />
          ) : null}
          {menu.error !== null ? (
            <DataError
              disabled={isAnyLoading}
              loading={menu.loading}
              message={menu.error}
              section="menu"
              onRetry={(event) => retrySection('menu', event.currentTarget)}
            />
          ) : null}
          {analytics.error !== null ? (
            <DataError
              disabled={isAnyLoading}
              loading={analytics.loading}
              message={analytics.error}
              section="analytics"
              onRetry={(event) => retrySection('analytics', event.currentTarget)}
            />
          ) : null}
        </div>
      ) : null}

      <section className={styles.attentionSection} aria-labelledby="attention-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionKicker}>Current snapshot</p>
            <h2 id="attention-heading">Needs attention</h2>
          </div>
          {attentionCount > 0 ? (
            <StatusBadge variant="warning">
              {menuAttentionIsBounded
                ? `${attentionCount}+ ${attentionCount === 1 ? 'signal' : 'signals'} in snapshot`
                : pluralize(attentionCount, 'signal', 'signals')}
            </StatusBadge>
          ) : null}
        </div>

        {orders.data === null && menu.data === null ? (
          <p className={styles.mutedCopy}>
            Attention signals will appear when order or menu data is available.
          </p>
        ) : null}

        {attentionCount === 0 && (orders.data !== null || menu.data !== null) ? (
          <Notice
            role="status"
            title="No attention signals in the available snapshot"
            variant={menuAttentionIsBounded ? 'info' : 'success'}
          >
            {emptyAttentionCopy}
          </Notice>
        ) : null}

        {attentionCount > 0 ? (
          <ul className={styles.attentionList}>
            {recentAttentionOrders.length > 0 ? (
              <li>
                <div>
                  <strong>
                    {pluralize(
                      recentAttentionOrders.length,
                      'recent order needs',
                      'recent orders need',
                    )}{' '}
                    review
                  </strong>
                  <span>
                    Created or ready within the {orders.data?.items.length ?? 0} newest
                    orders returned by the API.
                  </span>
                </div>
                <Link to="/admin/orders">Review orders</Link>
              </li>
            ) : null}
            {snapshotUnavailableMenuItems.length > 0 ? (
              <li>
                <div>
                  <strong>
                    {menuAttentionIsBounded ? 'At least ' : ''}
                    {pluralize(
                      snapshotUnavailableMenuItems.length,
                      'active menu item is',
                      'active menu items are',
                    )}{' '}
                    unavailable
                  </strong>
                  <span>
                    {menuAttentionIsBounded
                      ? `Found within the first ${menu.data?.items.length ?? 0} menu records returned; the full catalog may contain more.`
                      : 'The complete menu snapshot supports this exact count.'}
                  </span>
                </div>
                <Link to="/admin/menu">Review menu</Link>
              </li>
            ) : null}
          </ul>
        ) : null}
      </section>

      <section className={styles.summarySection} aria-labelledby="summary-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionKicker}>At a glance</p>
            <h2 ref={analyticsHeadingRef} id="summary-heading" tabIndex={-1}>
              Operational summary
            </h2>
          </div>
        </div>
        <div className={styles.kpiGrid}>
          {orders.data !== null ? (
            <KpiCard
              context={`Newest ${orders.data.items.length} shown below`}
              label="All orders"
              value={new Intl.NumberFormat('en-NO').format(orders.data.total)}
            />
          ) : null}
          {menu.data !== null ? (
            <KpiCard
              context={
                menuSnapshotIsComplete
                  ? `${pluralize(unavailableMenuItems?.length ?? 0, 'active item', 'active items')} unavailable`
                  : `Availability is bounded to the first ${menu.data.items.length}`
              }
              label="Menu items"
              value={new Intl.NumberFormat('en-NO').format(menu.data.total)}
            />
          ) : null}
          {analytics.data !== null ? (
            <KpiCard
              context={`${reportingRange.startDate} to ${reportingRange.endDate} · Europe/Oslo`}
              label="Collected revenue · 7 days"
              value={
                <CurrencyValues data={analytics.data} field="collectedRevenueAmount" />
              }
            />
          ) : null}
          {analytics.data !== null ? (
            <KpiCard
              context={`${reportingRange.startDate} to ${reportingRange.endDate} · by currency`}
              label="Average order value · 7 days"
              value={
                <CurrencyValues data={analytics.data} field="averageOrderValueAmount" />
              }
            />
          ) : null}
        </div>
      </section>

      <div className={styles.detailGrid}>
        <section className={styles.panel} aria-labelledby="recent-orders-heading">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.sectionKicker}>Newest first</p>
              <h2 ref={ordersHeadingRef} id="recent-orders-heading" tabIndex={-1}>
                Recent orders
              </h2>
            </div>
            <Link className={styles.sectionLink} to="/admin/orders">
              View all orders
            </Link>
          </div>
          {orders.data !== null && orders.data.items.length === 0 ? (
            <p className={styles.emptyPanel}>No orders have been created yet.</p>
          ) : null}
          {orders.data !== null && orders.data.items.length > 0 ? (
            <ul className={styles.orderList} aria-label="Newest administrator orders">
              {orders.data.items.map((order) => (
                <RecentOrderRow key={order.publicOrderNumber} order={order} />
              ))}
            </ul>
          ) : null}
          {orders.data === null ? (
            <p className={styles.mutedCopy}>Recent-order data is not available yet.</p>
          ) : null}
        </section>

        <section className={styles.panel} aria-labelledby="menu-availability-heading">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.sectionKicker}>Catalog state</p>
              <h2 ref={menuHeadingRef} id="menu-availability-heading" tabIndex={-1}>
                Menu availability
              </h2>
            </div>
            <Link className={styles.sectionLink} to="/admin/menu">
              Open menu
            </Link>
          </div>
          {menu.data !== null && menuSnapshotIsComplete ? (
            <div className={styles.availabilitySummary}>
              <StatusBadge
                variant={
                  (unavailableMenuItems?.length ?? 0) > 0 ? 'warning' : 'success'
                }
              >
                {(unavailableMenuItems?.length ?? 0) > 0
                  ? `${unavailableMenuItems?.length ?? 0} unavailable`
                  : 'All active items available'}
              </StatusBadge>
              <p>
                All {menu.data.total} menu records were inspected in one bounded
                request.
              </p>
            </div>
          ) : null}
          {menu.data !== null && !menuSnapshotIsComplete ? (
            <Notice role="status" title="Bounded menu snapshot" variant="info">
              {snapshotUnavailableMenuItems.length > 0
                ? `At least ${pluralize(snapshotUnavailableMenuItems.length, 'active menu item is', 'active menu items are')} unavailable in the first ${menu.data.items.length} records returned.`
                : `No active unavailable items appear in the first ${menu.data.items.length} records returned.`}{' '}
              The catalog contains {menu.data.total} items. Open Menu to review full
              availability; this dashboard does not issue extra page requests.
            </Notice>
          ) : null}
          {menu.data === null ? (
            <p className={styles.mutedCopy}>Menu availability is not available yet.</p>
          ) : null}
        </section>
      </div>

      <section className={styles.shortcutsSection} aria-labelledby="shortcuts-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionKicker}>Administrator tools</p>
            <h2 id="shortcuts-heading">Workspace shortcuts</h2>
          </div>
        </div>
        <ul className={styles.shortcutGrid}>
          <li>
            <Link to="/admin/orders">
              <strong>Orders</strong>
              <span>Review fulfilment and order details</span>
            </Link>
          </li>
          <li>
            <Link to="/admin/menu">
              <strong>Menu</strong>
              <span>Manage catalog availability</span>
            </Link>
          </li>
          <li>
            <Link to="/admin/analytics">
              <strong>Analytics</strong>
              <span>Open established sales reporting</span>
            </Link>
          </li>
          <li>
            <Link to="/admin/exports">
              <strong>Exports</strong>
              <span>Download existing CSV reports</span>
            </Link>
          </li>
          {user?.role === 'super_admin' ? (
            <li>
              <Link to="/admin/users">
                <strong>Users</strong>
                <span>Manage ordinary administrator roles</span>
              </Link>
            </li>
          ) : null}
        </ul>
      </section>
    </section>
  );
}
