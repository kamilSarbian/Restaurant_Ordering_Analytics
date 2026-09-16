import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
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
  addCalendarDays,
  buildAdminAwareDateRange,
  getDefaultAdminDateRange,
  isValidDateOnly,
} from '../../components/admin/adminDateRange';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import StatusBadge from '../../components/ui/StatusBadge';
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
const FILTER_PRESETS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

interface DraftFilters extends AdminDateRangeSelection {
  currency: string;
  limit: string;
}

interface FilterErrors extends AdminDateRangeErrors {
  currency?: string;
  limit?: string;
}

interface AppliedFilters extends AdminDateRangeSelection {
  currency: string;
  limit: number;
  query: AdminAnalyticsQuery;
}

interface SectionState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  revision: number;
}

type RequestMode = 'apply' | 'initial' | 'refresh';

interface AnalyticsState {
  applied: AppliedFilters | null;
  applyError: boolean;
  categories: SectionState<AdminCategorySales>;
  focusTarget: 'applied' | 'failure' | 'refresh' | null;
  orderTypes: SectionState<AdminOrderTypeSales>;
  overview: SectionState<AdminAnalyticsOverview>;
  pending: AppliedFilters | null;
  products: SectionState<AdminProductSales>;
  requestMode: RequestMode | null;
}

interface SalesRow {
  currency: string;
  label: string;
  quantity: number;
  salesAmount: number;
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

function initialSection<T>(): SectionState<T> {
  return { data: null, error: null, loading: true, revision: 0 };
}

function initialAnalyticsState(): AnalyticsState {
  return {
    applied: null,
    applyError: false,
    categories: initialSection(),
    focusTarget: null,
    orderTypes: initialSection(),
    overview: initialSection(),
    pending: null,
    products: initialSection(),
    requestMode: null,
  };
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
    return 'The requested analytics filters were rejected. Review them and apply again.';
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return 'This analytics section is temporarily unavailable. Refresh later.';
  }
  return 'This analytics section could not be loaded. Refresh and try again.';
}

function completeSection<T>(
  previous: SectionState<T>,
  result: PromiseSettledResult<T>,
): SectionState<T> {
  return result.status === 'fulfilled'
    ? {
        data: result.value,
        error: null,
        loading: false,
        revision: previous.revision + 1,
      }
    : {
        data: previous.data,
        error: getSectionError(result.reason),
        loading: false,
        revision: previous.revision + 1,
      };
}

function preserveSectionAfterFailedApply<T>(
  previous: SectionState<T>,
  result: PromiseSettledResult<T>,
): SectionState<T> {
  return {
    ...previous,
    error:
      result.status === 'rejected' ? getSectionError(result.reason) : previous.error,
    loading: false,
    revision: previous.revision + 1,
  };
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
        currency: filters.currency,
        endDate: filters.endDate,
        limit,
        query: {
          ...(filters.currency === '' ? {} : { currency: filters.currency }),
          end: range.end,
          start: range.start,
        },
        startDate: filters.startDate,
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

function areAppliedFiltersEqual(left: AppliedFilters, right: AppliedFilters): boolean {
  return (
    left.limit === right.limit &&
    left.query.start === right.query.start &&
    left.query.end === right.query.end &&
    left.query.currency === right.query.currency
  );
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div className={styles.statePanel}>
      <h3>Loading {label}</h3>
      <p>The authoritative analytics response is pending.</p>
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

function SectionError({ message }: { message: string }) {
  return (
    <Notice role={'status'} title={'Section unavailable'} variant={'danger'}>
      {message}
    </Notice>
  );
}

function Overview({ data }: { data: AdminAnalyticsOverview }) {
  if (data.currencies.length === 0) {
    return <EmptyPanel message={'No paid orders in this period.'} />;
  }

  const metrics = [
    {
      label: 'Collected revenue',
      value: (row: AdminAnalyticsOverview['currencies'][number]) =>
        formatAnalyticsMoney(row.collectedRevenueAmount, row.currency),
    },
    {
      label: 'Succeeded paid orders',
      value: (row: AdminAnalyticsOverview['currencies'][number]) =>
        formatAnalyticsCount(row.succeededOrdersCount),
    },
    {
      label: 'Average order value',
      value: (row: AdminAnalyticsOverview['currencies'][number]) =>
        formatAnalyticsMoney(row.averageOrderValueAmount, row.currency),
    },
  ];

  return (
    <div className={styles.kpiGrid}>
      {metrics.map((metric) => (
        <article className={styles.kpiCard} key={metric.label}>
          <h3>{metric.label}</h3>
          <ul className={styles.metricRows}>
            {data.currencies.map((row) => (
              <li key={row.currency}>
                <span>{row.currency}</span>
                <strong>{metric.value(row)}</strong>
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

function getBarSize(row: SalesRow, rows: SalesRow[]): string {
  const maximum = Math.max(0, ...rows.map((item) => item.salesAmount));
  return maximum === 0 ? '0%' : String((row.salesAmount / maximum) * 100) + '%';
}

function groupRowsByCurrency(rows: SalesRow[]): [string, SalesRow[]][] {
  const groups = new Map<string, SalesRow[]>();
  for (const row of rows) {
    const group = groups.get(row.currency);
    if (group === undefined) groups.set(row.currency, [row]);
    else group.push(row);
  }
  return Array.from(groups.entries());
}

function SalesBreakdown({ caption, rows }: { caption: string; rows: SalesRow[] }) {
  return (
    <div className={styles.breakdownGroups}>
      {groupRowsByCurrency(rows).map(([currency, currencyRows]) => (
        <section className={styles.currencyBreakdown} key={currency}>
          <div className={styles.breakdownHeading}>
            <h3>{currency}</h3>
            <p>Relative bars compare sales only within {currency} in this section.</p>
          </div>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <caption>{caption + ' — ' + currency}</caption>
              <thead>
                <tr>
                  <th scope={'col'}>Name</th>
                  <th scope={'col'}>Quantity sold</th>
                  <th scope={'col'}>Sales value</th>
                  <th scope={'col'}>Relative sales within currency</th>
                </tr>
              </thead>
              <tbody>
                {currencyRows.map((row, index) => (
                  <tr key={row.label + '-' + String(index)}>
                    <th scope={'row'}>{row.label}</th>
                    <td>{formatAnalyticsCount(row.quantity)}</td>
                    <td>{formatAnalyticsMoney(row.salesAmount, row.currency)}</td>
                    <td>
                      <span
                        aria-hidden={'true'}
                        className={styles.bar}
                        style={
                          {
                            '--bar-size': getBarSize(row, currencyRows),
                          } as CSSProperties
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={styles.cards} aria-label={caption + ' — ' + currency}>
            {currencyRows.map((row, index) => (
              <li className={styles.card} key={row.label + '-' + String(index)}>
                <article>
                  <h4>{row.label}</h4>
                  <dl>
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
                    aria-hidden={'true'}
                    className={styles.bar}
                    style={
                      { '--bar-size': getBarSize(row, currencyRows) } as CSSProperties
                    }
                  />
                </article>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function OrderTypes({ data }: { data: AdminOrderTypeSales }) {
  if (data.items.length === 0) {
    return <EmptyPanel message={'No order-type sales in this period.'} />;
  }
  const rows: SalesRow[] = data.items.map((item) => ({
    currency: item.currency,
    label: item.orderType === 'dine_in' ? 'Dine-in' : 'Takeaway',
    quantity: item.succeededOrdersCount,
    salesAmount: item.collectedRevenueAmount,
  }));
  return <SalesBreakdown caption={'Paid order types in backend order'} rows={rows} />;
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
  const [analytics, setAnalytics] = useState<AnalyticsState>(initialAnalyticsState);
  const initialFiltersRef = useRef(filters);
  const dateControlRef = useRef<AdminDateRangeControlHandle>(null);
  const currencyRef = useRef<HTMLInputElement>(null);
  const limitRef = useRef<HTMLInputElement>(null);
  const appliedContextRef = useRef<HTMLElement>(null);
  const applyFailureRef = useRef<HTMLDivElement>(null);
  const asyncFocusOriginRef = useRef<HTMLButtonElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const appliedRef = useRef<AppliedFilters | null>(null);

  const runAnalytics = useCallback(
    async (requested: AppliedFilters, mode: RequestMode): Promise<void> => {
      if (requestInFlightRef.current) return;
      const authSession = getAuthenticatedSession();
      if (authSession === null) {
        logout();
        return;
      }

      requestInFlightRef.current = true;
      const committedAtStart = appliedRef.current;
      const requiresAtomicApply =
        mode === 'apply' &&
        committedAtStart !== null &&
        !areAppliedFiltersEqual(committedAtStart, requested);
      const token = authSession.accessToken;
      generationRef.current += 1;
      const generation = generationRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setAnalytics((previous) => ({
        ...previous,
        applyError: false,
        categories: { ...previous.categories, loading: true },
        focusTarget: null,
        orderTypes: { ...previous.orderTypes, loading: true },
        overview: { ...previous.overview, loading: true },
        pending: requested,
        products: { ...previous.products, loading: true },
        requestMode: mode,
      }));

      const [overviewResult, productResult, categoryResult, orderTypeResult] =
        await Promise.allSettled([
          fetchAdminAnalyticsOverview(token, requested.query, controller.signal),
          fetchAdminProductSales(
            token,
            { ...requested.query, limit: requested.limit },
            controller.signal,
          ),
          fetchAdminCategorySales(
            token,
            { ...requested.query, limit: requested.limit },
            controller.signal,
          ),
          fetchAdminOrderTypeSales(token, requested.query, controller.signal),
        ]);
      if (generationRef.current !== generation) return;
      controllerRef.current = null;
      requestInFlightRef.current = false;

      const results: PromiseSettledResult<unknown>[] = [
        overviewResult,
        productResult,
        categoryResult,
        orderTypeResult,
      ];
      if (results.some(isUnauthorized)) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (results.some(isForbidden)) {
        await refreshCurrentUser();
        if (generationRef.current !== generation) return;
      }

      const allFulfilled =
        overviewResult.status === 'fulfilled' &&
        productResult.status === 'fulfilled' &&
        categoryResult.status === 'fulfilled' &&
        orderTypeResult.status === 'fulfilled';
      const anyFulfilled = results.some((result) => result.status === 'fulfilled');

      if (requiresAtomicApply && !allFulfilled) {
        setAnalytics((previous) => ({
          ...previous,
          applyError: true,
          categories: preserveSectionAfterFailedApply(
            previous.categories,
            categoryResult,
          ),
          focusTarget: 'failure',
          orderTypes: preserveSectionAfterFailedApply(
            previous.orderTypes,
            orderTypeResult,
          ),
          overview: preserveSectionAfterFailedApply(previous.overview, overviewResult),
          pending: null,
          products: preserveSectionAfterFailedApply(previous.products, productResult),
          requestMode: null,
        }));
        return;
      }

      if (anyFulfilled) appliedRef.current = requested;
      setAnalytics((previous) => ({
        ...previous,
        applied: anyFulfilled ? requested : previous.applied,
        applyError: mode === 'apply' && !anyFulfilled,
        categories: completeSection(previous.categories, categoryResult),
        focusTarget:
          mode === 'apply'
            ? anyFulfilled
              ? 'applied'
              : 'failure'
            : mode === 'refresh'
              ? 'refresh'
              : null,
        orderTypes: completeSection(previous.orderTypes, orderTypeResult),
        overview: completeSection(previous.overview, overviewResult),
        pending: null,
        products: completeSection(previous.products, productResult),
        requestMode: null,
      }));
    },
    [getAuthenticatedSession, invalidateSessionIfCurrent, logout, refreshCurrentUser],
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const validated = validateFilters(initialFiltersRef.current);
      if (validated.applied !== null) {
        void runAnalytics(validated.applied, 'initial');
      }
    });
    return () => {
      active = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      requestInFlightRef.current = false;
    };
  }, [runAnalytics]);

  useEffect(() => {
    if (analytics.focusTarget === null) return;
    const origin = asyncFocusOriginRef.current;
    asyncFocusOriginRef.current = null;
    if (origin === null || !shouldRestoreAsyncFocus(origin)) return;
    if (analytics.focusTarget === 'applied') {
      appliedContextRef.current?.focus();
    } else if (analytics.focusTarget === 'failure') {
      applyFailureRef.current?.focus();
    } else {
      refreshButtonRef.current?.focus();
    }
  }, [analytics.focusTarget]);

  const focusFirstError = (errors: FilterErrors) => {
    window.setTimeout(() => {
      if (errors.startDate !== undefined || errors.endDate !== undefined) {
        dateControlRef.current?.focusFirstInvalid();
      } else if (errors.currency !== undefined) currencyRef.current?.focus();
      else if (errors.limit !== undefined) limitRef.current?.focus();
    }, 0);
  };

  const handleApply = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (requestInFlightRef.current) return;
    const validated = validateFilters(filters);
    setFilterErrors(validated.errors);
    if (validated.applied === null) {
      focusFirstError(validated.errors);
      return;
    }
    asyncFocusOriginRef.current = event.currentTarget;
    void runAnalytics(validated.applied, 'apply');
  };

  const handleRefresh = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (requestInFlightRef.current || appliedRef.current === null) return;
    asyncFocusOriginRef.current = event.currentTarget;
    void runAnalytics(appliedRef.current, 'refresh');
  };

  const defaultRange = getDefaultAdminDateRange();
  const presets = FILTER_PRESETS.map((preset) => ({
    ...preset,
    endDate: defaultRange.endDate,
    startDate: addCalendarDays(defaultRange.endDate, -(preset.days - 1)),
  }));
  const validatedDraft = validateFilters(filters).applied;
  const draftDiffers =
    analytics.applied !== null &&
    (validatedDraft === null ||
      !areAppliedFiltersEqual(analytics.applied, validatedDraft));
  const isRefreshing = analytics.requestMode !== null;
  const hasAnyData =
    analytics.overview.data !== null ||
    analytics.products.data !== null ||
    analytics.categories.data !== null ||
    analytics.orderTypes.data !== null;

  return (
    <section className={styles.page} aria-labelledby={'admin-analytics-heading'}>
      <header className={styles.pageHeader}>
        <p className={'eyebrow'}>Paid-order reporting</p>
        <h1 id={'admin-analytics-heading'}>Analytics</h1>
        <p>Review qualified paid-order results with every currency kept separate.</p>
      </header>

      <section
        ref={appliedContextRef}
        aria-labelledby={'analytics-context-heading'}
        className={styles.appliedContext}
        tabIndex={-1}
      >
        <div className={styles.contextHeading}>
          <div>
            <p className={styles.contextEyebrow}>Data context</p>
            <h2 id={'analytics-context-heading'}>Applied analytics context</h2>
          </div>
          <StatusBadge
            variant={
              analytics.requestMode === 'apply'
                ? 'info'
                : analytics.applied === null
                  ? 'neutral'
                  : 'success'
            }
          >
            {analytics.requestMode === 'apply'
              ? 'Previous applied data'
              : analytics.applied === null
                ? 'Waiting for data'
                : 'Applied'}
          </StatusBadge>
        </div>
        {analytics.applied === null ? (
          <p className={styles.contextEmpty}>
            No analytics response has succeeded yet. Draft controls do not describe
            results until a request succeeds.
          </p>
        ) : (
          <dl className={styles.contextGrid}>
            <div>
              <dt>Period</dt>
              <dd>
                <time dateTime={analytics.applied.startDate}>
                  {analytics.applied.startDate}
                </time>
                {' — '}
                <time dateTime={analytics.applied.endDate}>
                  {analytics.applied.endDate}
                </time>
                {' (inclusive)'}
              </dd>
            </div>
            <div>
              <dt>Timezone</dt>
              <dd>Europe/Oslo</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>
                {analytics.applied.currency === ''
                  ? 'All returned currencies, reported separately'
                  : analytics.applied.currency}
              </dd>
            </div>
            <div>
              <dt>Breakdown limit</dt>
              <dd>{formatAnalyticsCount(analytics.applied.limit)} per currency</dd>
            </div>
          </dl>
        )}
      </section>

      <section className={styles.filters} aria-labelledby={'analytics-filters-heading'}>
        <div className={styles.filterHeading}>
          <h2 id={'analytics-filters-heading'}>Draft filters</h2>
          {draftDiffers ? (
            <StatusBadge variant={'warning'}>Changes not applied</StatusBadge>
          ) : null}
        </div>
        <fieldset className={styles.presets}>
          <legend>Quick ranges</legend>
          <div>
            {presets.map((preset) => {
              const isApplied =
                analytics.applied?.startDate === preset.startDate &&
                analytics.applied.endDate === preset.endDate;
              return (
                <Button
                  key={preset.days}
                  aria-pressed={isApplied}
                  className={styles.presetButton}
                  size={'md'}
                  variant={'secondary'}
                  onClick={() => {
                    setFilters((current) => ({
                      ...current,
                      endDate: preset.endDate,
                      startDate: preset.startDate,
                    }));
                    setFilterErrors((current) => ({
                      ...current,
                      endDate: undefined,
                      startDate: undefined,
                    }));
                  }}
                >
                  {preset.label}
                </Button>
              );
            })}
          </div>
        </fieldset>
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
              autoCapitalize={'characters'}
              maxLength={3}
              value={filters.currency}
              onChange={(event) => {
                const currency = event.currentTarget.value.toUpperCase();
                setFilters((current) => ({ ...current, currency }));
              }}
            />
            {filterErrors.currency !== undefined ? (
              <span className={styles.fieldError} id={'analytics-currency-error'}>
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
              inputMode={'numeric'}
              value={filters.limit}
              onChange={(event) => {
                const limit = event.currentTarget.value;
                setFilters((current) => ({ ...current, limit }));
              }}
            />
            {filterErrors.limit !== undefined ? (
              <span className={styles.fieldError} id={'analytics-limit-error'}>
                {filterErrors.limit}
              </span>
            ) : null}
          </label>
        </div>
        {draftDiffers ? (
          <Notice title={'Changes not applied'} variant={'warning'}>
            The controls contain draft changes. Current results still use the applied
            context shown above.
          </Notice>
        ) : null}
        <div className={styles.actions}>
          <Button
            disabled={isRefreshing}
            loading={analytics.requestMode === 'apply'}
            loadingLabel={'Applying analytics filters'}
            onClick={handleApply}
          >
            Apply filters
          </Button>
          <Button
            ref={refreshButtonRef}
            disabled={isRefreshing || analytics.applied === null}
            loading={analytics.requestMode === 'refresh'}
            loadingLabel={'Refreshing analytics'}
            variant={'secondary'}
            onClick={handleRefresh}
          >
            Refresh
          </Button>
        </div>
        {analytics.applyError ? (
          <div ref={applyFailureRef} className={styles.applyFailure} tabIndex={-1}>
            <Notice title={'Filters not applied'} variant={'danger'}>
              {analytics.applied === null
                ? 'One or more analytics sections failed. No applied context is available.'
                : 'One or more analytics sections could not load the requested filters. Previous results and applied context are unchanged.'}
            </Notice>
          </div>
        ) : null}
        {isRefreshing ? (
          <p className={styles.refreshStatus} role={'status'}>
            {analytics.requestMode === 'apply'
              ? 'Applying filters… Previous applied results remain visible until all sections succeed.'
              : analytics.requestMode === 'refresh'
                ? 'Refreshing analytics… Current applied results remain visible while sections update.'
                : hasAnyData
                  ? 'Refreshing analytics…'
                  : 'Loading analytics…'}
          </p>
        ) : null}
      </section>

      <section
        aria-busy={analytics.overview.loading}
        className={styles.analyticsSection}
        aria-labelledby={'overview-heading'}
      >
        <div className={styles.sectionHeading}>
          <h2 id={'overview-heading'}>Overview</h2>
          <p>Three authoritative paid-order measures, separated by currency.</p>
        </div>
        <div
          className={styles.sectionBody}
          key={'overview-' + String(analytics.overview.revision)}
        >
          {analytics.overview.error !== null ? (
            <SectionError message={analytics.overview.error} />
          ) : null}
          {analytics.overview.data !== null ? (
            <Overview data={analytics.overview.data} />
          ) : null}
          {analytics.overview.data === null && analytics.overview.error === null ? (
            <LoadingPanel label={'overview'} />
          ) : null}
        </div>
      </section>

      <section
        aria-busy={analytics.products.loading}
        className={styles.analyticsSection}
        aria-labelledby={'products-heading'}
      >
        <div className={styles.sectionHeading}>
          <h2 id={'products-heading'}>Product sales</h2>
          <p>Historical item snapshots in backend rank order.</p>
        </div>
        <div
          className={styles.sectionBody}
          key={'products-' + String(analytics.products.revision)}
        >
          {analytics.products.error !== null ? (
            <SectionError message={analytics.products.error} />
          ) : null}
          {analytics.products.data !== null &&
          analytics.products.data.items.length === 0 ? (
            <EmptyPanel message={'No product sales in this period.'} />
          ) : null}
          {analytics.products.data !== null &&
          analytics.products.data.items.length > 0 ? (
            <SalesBreakdown
              caption={'Historical product sales in backend rank order'}
              rows={analytics.products.data.items.map((item) => ({
                currency: item.currency,
                label: item.itemName,
                quantity: item.quantitySold,
                salesAmount: item.salesAmount,
              }))}
            />
          ) : null}
          {analytics.products.data === null && analytics.products.error === null ? (
            <LoadingPanel label={'product sales'} />
          ) : null}
        </div>
      </section>

      <section
        aria-busy={analytics.categories.loading}
        className={styles.analyticsSection}
        aria-labelledby={'categories-heading'}
      >
        <div className={styles.sectionHeading}>
          <h2 id={'categories-heading'}>Category sales</h2>
          <p>Historical category snapshots in backend rank order.</p>
        </div>
        <div
          className={styles.sectionBody}
          key={'categories-' + String(analytics.categories.revision)}
        >
          {analytics.categories.error !== null ? (
            <SectionError message={analytics.categories.error} />
          ) : null}
          {analytics.categories.data !== null &&
          analytics.categories.data.items.length === 0 ? (
            <EmptyPanel message={'No category sales in this period.'} />
          ) : null}
          {analytics.categories.data !== null &&
          analytics.categories.data.items.length > 0 ? (
            <SalesBreakdown
              caption={'Historical category sales in backend rank order'}
              rows={analytics.categories.data.items.map((item) => ({
                currency: item.currency,
                label: item.categoryName,
                quantity: item.quantitySold,
                salesAmount: item.salesAmount,
              }))}
            />
          ) : null}
          {analytics.categories.data === null && analytics.categories.error === null ? (
            <LoadingPanel label={'category sales'} />
          ) : null}
        </div>
      </section>

      <section
        aria-busy={analytics.orderTypes.loading}
        className={styles.analyticsSection}
        aria-labelledby={'order-types-heading'}
      >
        <div className={styles.sectionHeading}>
          <h2 id={'order-types-heading'}>Order types</h2>
          <p>Succeeded dine-in and takeaway orders, separated by currency.</p>
        </div>
        <div
          className={styles.sectionBody}
          key={'order-types-' + String(analytics.orderTypes.revision)}
        >
          {analytics.orderTypes.error !== null ? (
            <SectionError message={analytics.orderTypes.error} />
          ) : null}
          {analytics.orderTypes.data !== null ? (
            <OrderTypes data={analytics.orderTypes.data} />
          ) : null}
          {analytics.orderTypes.data === null && analytics.orderTypes.error === null ? (
            <LoadingPanel label={'order-type sales'} />
          ) : null}
        </div>
      </section>
    </section>
  );
}
