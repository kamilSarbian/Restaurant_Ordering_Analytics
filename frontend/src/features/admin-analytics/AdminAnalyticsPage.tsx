import {
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { AdminApiRequestError } from '../../api/adminApi';
import AdminDateRangeControl, {
  type AdminDateRangeControlHandle,
  type AdminDateRangeErrors,
} from '../../components/admin/AdminDateRangeControl';
import {
  type AdminDateRangeSelection,
  buildAdminAwareDateRange,
  getDefaultAdminDateRange,
  isValidDateOnly,
} from '../../components/admin/adminDateRange';
import { useAuth } from '../auth/AuthContext';
import {
  type AdminAnalyticsOverview,
  type AdminAnalyticsQuery,
  type AdminCategorySales,
  type AdminOrderTypeSales,
  type AdminProductSales,
  fetchAdminAnalyticsOverview,
  fetchAdminCategorySales,
  fetchAdminOrderTypeSales,
  fetchAdminProductSales,
  formatAnalyticsCount,
  formatAnalyticsMoney,
} from './adminAnalyticsApi';
import styles from './AdminAnalyticsPage.module.css';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const LIMIT_PATTERN = /^\d+$/;

interface DraftFilters extends AdminDateRangeSelection {
  currency: string;
  limit: string;
}

interface FilterErrors extends AdminDateRangeErrors {
  currency?: string;
  limit?: string;
}

interface AppliedFilters {
  limit: number;
  query: AdminAnalyticsQuery;
}

interface SectionState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface SalesRow {
  currency: string;
  label: string;
  quantity: number;
  salesAmount: number;
}

function initialSection<T>(): SectionState<T> {
  return { data: null, error: null, loading: true };
}

function getSectionError(error: unknown): string {
  if (!(error instanceof AdminApiRequestError)) {
    return 'This analytics section could not be loaded. Check your connection and refresh.';
  }
  if (error.kind === 'network' || error.kind === 'timeout') {
    return 'This analytics section could not reach the service. Check your connection and refresh.';
  }
  if (error.kind === 'invalid-response') {
    return 'This analytics section received an unexpected response. Refresh later.';
  }
  if (error.status === 422) {
    return 'The applied analytics filters were rejected. Review them and apply again.';
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return 'This analytics section is temporarily unavailable. Refresh later.';
  }
  return 'This analytics section could not be loaded. Refresh and try again.';
}

function finishSection<T>(
  setter: Dispatch<SetStateAction<SectionState<T>>>,
  result: PromiseSettledResult<T>,
): void {
  setter((previous) =>
    result.status === 'fulfilled'
      ? { data: result.value, error: null, loading: false }
      : { data: previous.data, error: getSectionError(result.reason), loading: false },
  );
}

function isUnauthorized(result: PromiseSettledResult<unknown>): boolean {
  return (
    result.status === 'rejected' &&
    result.reason instanceof AdminApiRequestError &&
    result.reason.status === 401
  );
}

function isForbidden(result: PromiseSettledResult<unknown>): boolean {
  return (
    result.status === 'rejected' &&
    result.reason instanceof AdminApiRequestError &&
    result.reason.status === 403
  );
}

function validateFilters(filters: DraftFilters): {
  applied: AppliedFilters | null;
  errors: FilterErrors;
} {
  const errors: FilterErrors = {};
  if (!isValidDateOnly(filters.startDate)) {
    errors.startDate = 'Enter a valid start date.';
  }
  if (!isValidDateOnly(filters.endDate)) {
    errors.endDate = 'Enter a valid end date.';
  }
  if (
    errors.startDate === undefined &&
    errors.endDate === undefined &&
    filters.startDate > filters.endDate
  ) {
    errors.endDate = 'End date must be the same as or after start date.';
  }
  if (filters.currency !== '' && !CURRENCY_PATTERN.test(filters.currency)) {
    errors.currency =
      'Currency must be blank or exactly three uppercase ASCII letters.';
  }
  if (!LIMIT_PATTERN.test(filters.limit)) {
    errors.limit = 'Breakdown limit must be a whole number from 1 to 100.';
  }
  const limit = Number(filters.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    errors.limit = 'Breakdown limit must be a whole number from 1 to 100.';
  }
  if (Object.keys(errors).length > 0) return { applied: null, errors };

  try {
    const range = buildAdminAwareDateRange(filters);
    return {
      applied: {
        limit,
        query: {
          ...(filters.currency === '' ? {} : { currency: filters.currency }),
          end: range.end,
          start: range.start,
        },
      },
      errors,
    };
  } catch {
    return {
      applied: null,
      errors: { endDate: 'The selected Europe/Oslo range could not be converted.' },
    };
  }
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div className={styles.statePanel} role="status">
      <h3>Loading {label}</h3>
      <p>The latest analytics are being requested.</p>
    </div>
  );
}

function SectionError({ message }: { message: string }) {
  return (
    <div className={styles.errorPanel} role="alert">
      <h3>Section unavailable</h3>
      <p>{message}</p>
    </div>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className={styles.statePanel}>
      <h3>No results</h3>
      <p>{message}</p>
    </div>
  );
}

function Overview({ data }: { data: AdminAnalyticsOverview }) {
  if (data.currencies.length === 0) {
    return <EmptyPanel message="No paid orders in this period." />;
  }
  return (
    <div className={styles.kpiGrid}>
      {data.currencies.map((row) => (
        <article className={styles.kpiCard} key={row.currency}>
          <h3>{row.currency}</h3>
          <dl>
            <div>
              <dt>Collected revenue</dt>
              <dd>{formatAnalyticsMoney(row.collectedRevenueAmount, row.currency)}</dd>
            </div>
            <div>
              <dt>Succeeded paid orders</dt>
              <dd>{formatAnalyticsCount(row.succeededOrdersCount)}</dd>
            </div>
            <div>
              <dt>Average order value</dt>
              <dd>{formatAnalyticsMoney(row.averageOrderValueAmount, row.currency)}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}

function getBarSize(row: SalesRow, rows: SalesRow[]): string {
  const maximum = Math.max(
    0,
    ...rows
      .filter((candidate) => candidate.currency === row.currency)
      .map((item) => item.salesAmount),
  );
  return maximum === 0 ? '0%' : `${Math.max(4, (row.salesAmount / maximum) * 100)}%`;
}

function SalesBreakdown({ caption, rows }: { caption: string; rows: SalesRow[] }) {
  return (
    <>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Currency</th>
              <th scope="col">Quantity sold</th>
              <th scope="col">Sales value</th>
              <th scope="col">Relative scale</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.currency}-${row.label}-${index}`}>
                <th scope="row">{row.label}</th>
                <td>{row.currency}</td>
                <td>{formatAnalyticsCount(row.quantity)}</td>
                <td>{formatAnalyticsMoney(row.salesAmount, row.currency)}</td>
                <td>
                  <span
                    aria-hidden="true"
                    className={styles.bar}
                    style={{ '--bar-size': getBarSize(row, rows) } as CSSProperties}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={styles.cards} aria-label={caption}>
        {rows.map((row, index) => (
          <li className={styles.card} key={`${row.currency}-${row.label}-${index}`}>
            <article>
              <h3>{row.label}</h3>
              <dl>
                <div>
                  <dt>Currency</dt>
                  <dd>{row.currency}</dd>
                </div>
                <div>
                  <dt>Quantity sold</dt>
                  <dd>{formatAnalyticsCount(row.quantity)}</dd>
                </div>
                <div>
                  <dt>Sales value</dt>
                  <dd>{formatAnalyticsMoney(row.salesAmount, row.currency)}</dd>
                </div>
              </dl>
              <span
                aria-hidden="true"
                className={styles.bar}
                style={{ '--bar-size': getBarSize(row, rows) } as CSSProperties}
              />
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

function OrderTypes({ data }: { data: AdminOrderTypeSales }) {
  if (data.items.length === 0) {
    return <EmptyPanel message="No order-type sales in this period." />;
  }
  const rows: SalesRow[] = data.items.map((item) => ({
    currency: item.currency,
    label: item.orderType === 'dine_in' ? 'Dine-in' : 'Takeaway',
    quantity: item.succeededOrdersCount,
    salesAmount: item.collectedRevenueAmount,
  }));
  return <SalesBreakdown caption="Paid order types in backend order" rows={rows} />;
}

export default function AdminAnalyticsPage() {
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    refreshCurrentUser,
  } = useAuth();
  const [filters, setFilters] = useState<DraftFilters>(() => ({
    ...getDefaultAdminDateRange(),
    currency: '',
    limit: '50',
  }));
  const [filterErrors, setFilterErrors] = useState<FilterErrors>({});
  const [overview, setOverview] =
    useState<SectionState<AdminAnalyticsOverview>>(initialSection);
  const [products, setProducts] =
    useState<SectionState<AdminProductSales>>(initialSection);
  const [categories, setCategories] =
    useState<SectionState<AdminCategorySales>>(initialSection);
  const [orderTypes, setOrderTypes] =
    useState<SectionState<AdminOrderTypeSales>>(initialSection);
  const dateControlRef = useRef<AdminDateRangeControlHandle>(null);
  const currencyRef = useRef<HTMLInputElement>(null);
  const limitRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const appliedRef = useRef<AppliedFilters | null>(null);

  const runAnalytics = useCallback(
    async (applied: AppliedFilters): Promise<void> => {
      const authSession = getAuthenticatedSession();
      if (authSession === null) return logout();
      const token = authSession.accessToken;
      generationRef.current += 1;
      const generation = generationRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const markLoading = <T,>(setter: Dispatch<SetStateAction<SectionState<T>>>) =>
        setter((previous) => ({ ...previous, error: null, loading: true }));
      markLoading(setOverview);
      markLoading(setProducts);
      markLoading(setCategories);
      markLoading(setOrderTypes);

      const [overviewResult, productResult, categoryResult, orderTypeResult] =
        await Promise.allSettled([
          fetchAdminAnalyticsOverview(token, applied.query, controller.signal),
          fetchAdminProductSales(
            token,
            { ...applied.query, limit: applied.limit },
            controller.signal,
          ),
          fetchAdminCategorySales(
            token,
            { ...applied.query, limit: applied.limit },
            controller.signal,
          ),
          fetchAdminOrderTypeSales(token, applied.query, controller.signal),
        ]);
      if (generationRef.current !== generation) return;
      controllerRef.current = null;
      if (
        [overviewResult, productResult, categoryResult, orderTypeResult].some(
          isUnauthorized,
        )
      ) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (
        [overviewResult, productResult, categoryResult, orderTypeResult].some(
          isForbidden,
        )
      ) {
        await refreshCurrentUser();
        if (generationRef.current !== generation) return;
      }
      finishSection(setOverview, overviewResult);
      finishSection(setProducts, productResult);
      finishSection(setCategories, categoryResult);
      finishSection(setOrderTypes, orderTypeResult);
    },
    [getAuthenticatedSession, invalidateSessionIfCurrent, logout, refreshCurrentUser],
  );

  useEffect(() => {
    const validated = validateFilters(filters);
    if (validated.applied !== null) {
      appliedRef.current = validated.applied;
      void runAnalytics(validated.applied);
    }
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
    // The initial filter snapshot is intentionally loaded once after authentication.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runAnalytics]);

  const focusFirstError = (errors: FilterErrors) => {
    window.setTimeout(() => {
      if (errors.startDate !== undefined || errors.endDate !== undefined) {
        dateControlRef.current?.focusFirstInvalid();
      } else if (errors.currency !== undefined) currencyRef.current?.focus();
      else if (errors.limit !== undefined) limitRef.current?.focus();
    }, 0);
  };

  const handleApply = () => {
    const validated = validateFilters(filters);
    setFilterErrors(validated.errors);
    if (validated.applied === null) return focusFirstError(validated.errors);
    appliedRef.current = validated.applied;
    void runAnalytics(validated.applied);
  };

  const handleRefresh = () => {
    if (appliedRef.current !== null) void runAnalytics(appliedRef.current);
  };

  const isRefreshing =
    overview.loading || products.loading || categories.loading || orderTypes.loading;
  const hasAnyData =
    overview.data !== null ||
    products.data !== null ||
    categories.data !== null ||
    orderTypes.data !== null;

  return (
    <section className={styles.page} aria-labelledby="admin-analytics-heading">
      <header className={styles.pageHeader}>
        <p className="eyebrow">Paid-order reporting</p>
        <h1 id="admin-analytics-heading">Analytics</h1>
        <p>
          Review qualified paid-order results without combining different currencies.
        </p>
      </header>

      <section className={styles.filters} aria-labelledby="analytics-filters-heading">
        <h2 id="analytics-filters-heading">Filters</h2>
        <AdminDateRangeControl
          ref={dateControlRef}
          errors={filterErrors}
          value={filters}
          onChange={(range) => setFilters((current) => ({ ...current, ...range }))}
        />
        <div className={styles.filterFields}>
          <label>
            Currency (optional)
            <input
              ref={currencyRef}
              aria-describedby={
                filterErrors.currency ? 'analytics-currency-error' : undefined
              }
              aria-invalid={filterErrors.currency !== undefined}
              autoCapitalize="characters"
              maxLength={3}
              value={filters.currency}
              onChange={(event) => {
                const currency = event.currentTarget.value.toUpperCase();
                setFilters((current) => ({
                  ...current,
                  currency,
                }));
              }}
            />
            {filterErrors.currency !== undefined ? (
              <span className={styles.fieldError} id="analytics-currency-error">
                {filterErrors.currency}
              </span>
            ) : null}
          </label>
          <label>
            Breakdown limit
            <input
              ref={limitRef}
              aria-describedby={
                filterErrors.limit ? 'analytics-limit-error' : undefined
              }
              aria-invalid={filterErrors.limit !== undefined}
              inputMode="numeric"
              value={filters.limit}
              onChange={(event) => {
                const limit = event.currentTarget.value;
                setFilters((current) => ({ ...current, limit }));
              }}
            />
            {filterErrors.limit !== undefined ? (
              <span className={styles.fieldError} id="analytics-limit-error">
                {filterErrors.limit}
              </span>
            ) : null}
          </label>
        </div>
        <div className={styles.actions}>
          <button className={styles.primaryButton} type="button" onClick={handleApply}>
            Apply filters
          </button>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={handleRefresh}
          >
            Refresh
          </button>
        </div>
        {isRefreshing ? (
          <p className={styles.refreshStatus} role="status">
            {hasAnyData ? 'Refreshing analytics…' : 'Loading analytics…'}
          </p>
        ) : null}
      </section>

      <section className={styles.analyticsSection} aria-labelledby="overview-heading">
        <h2 id="overview-heading">Overview</h2>
        {overview.error !== null ? <SectionError message={overview.error} /> : null}
        {overview.data !== null ? <Overview data={overview.data} /> : null}
        {overview.data === null && overview.error === null ? (
          <LoadingPanel label="overview" />
        ) : null}
      </section>

      <section className={styles.analyticsSection} aria-labelledby="products-heading">
        <h2 id="products-heading">Product sales</h2>
        {products.error !== null ? <SectionError message={products.error} /> : null}
        {products.data !== null && products.data.items.length === 0 ? (
          <EmptyPanel message="No product sales in this period." />
        ) : null}
        {products.data !== null && products.data.items.length > 0 ? (
          <SalesBreakdown
            caption="Historical product sales in backend rank order"
            rows={products.data.items.map((item) => ({
              currency: item.currency,
              label: item.itemName,
              quantity: item.quantitySold,
              salesAmount: item.salesAmount,
            }))}
          />
        ) : null}
        {products.data === null && products.error === null ? (
          <LoadingPanel label="product sales" />
        ) : null}
      </section>

      <section className={styles.analyticsSection} aria-labelledby="categories-heading">
        <h2 id="categories-heading">Category sales</h2>
        {categories.error !== null ? <SectionError message={categories.error} /> : null}
        {categories.data !== null && categories.data.items.length === 0 ? (
          <EmptyPanel message="No category sales in this period." />
        ) : null}
        {categories.data !== null && categories.data.items.length > 0 ? (
          <SalesBreakdown
            caption="Historical category sales in backend rank order"
            rows={categories.data.items.map((item) => ({
              currency: item.currency,
              label: item.categoryName,
              quantity: item.quantitySold,
              salesAmount: item.salesAmount,
            }))}
          />
        ) : null}
        {categories.data === null && categories.error === null ? (
          <LoadingPanel label="category sales" />
        ) : null}
      </section>

      <section
        className={styles.analyticsSection}
        aria-labelledby="order-types-heading"
      >
        <h2 id="order-types-heading">Order types</h2>
        {orderTypes.error !== null ? <SectionError message={orderTypes.error} /> : null}
        {orderTypes.data !== null ? <OrderTypes data={orderTypes.data} /> : null}
        {orderTypes.data === null && orderTypes.error === null ? (
          <LoadingPanel label="order-type sales" />
        ) : null}
      </section>
    </section>
  );
}
