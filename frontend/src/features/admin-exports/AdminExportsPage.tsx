import { useEffect, useRef, useState } from 'react';

import { AdminApiRequestError } from '../../api/adminApi';
import AdminDateRangeControl, {
  type AdminDateRangeControlHandle,
  type AdminDateRangeErrors,
} from '../../components/admin/AdminDateRangeControl';
import {
  buildAdminAwareDateRange,
  getDefaultAdminDateRange,
  isValidDateOnly,
  type AdminDateRangeSelection,
} from '../../components/admin/adminDateRange';
import Button from '../../components/ui/Button';
import Notice, { type NoticeVariant } from '../../components/ui/Notice';
import StatusBadge from '../../components/ui/StatusBadge';
import { useAuth } from '../auth/AuthContext';
import {
  requestAdminCsvExport,
  type AdminExportKind,
  type ExportOrderStatus,
  type ExportOrderType,
} from './adminExportsApi';
import { downloadCsvBlob, getCsvDownloadFilename } from './csvDownload';
import styles from './AdminExportsPage.module.css';

interface ExportRequestContext {
  currency: string;
  endDate: string;
  orderStatus?: ExportOrderStatus;
  orderType?: ExportOrderType;
  startDate: string;
}

interface ExportNotice {
  context: ExportRequestContext | null;
  filename?: string;
  kind: 'error' | 'idle' | 'pending' | 'success';
  message: string;
}

const INITIAL_NOTICE: ExportNotice = {
  context: null,
  kind: 'idle',
  message: '',
};
const EXPORT_LABELS: Readonly<Record<AdminExportKind, string>> = {
  orders: 'Orders',
  payments: 'Payments',
  'product-sales': 'Product sales',
};
const ORDER_STATUS_LABELS: Readonly<Record<ExportOrderStatus, string>> = {
  accepted: 'Accepted',
  cancelled: 'Cancelled',
  completed: 'Completed',
  created: 'Created',
  preparing: 'Preparing',
  ready: 'Ready',
};
const ORDER_TYPE_LABELS: Readonly<Record<ExportOrderType, string>> = {
  dine_in: 'Dine in',
  takeaway: 'Takeaway',
};
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function validateDates(selection: AdminDateRangeSelection): AdminDateRangeErrors {
  const errors: AdminDateRangeErrors = {};
  if (!isValidDateOnly(selection.startDate)) {
    errors.startDate = 'Enter a valid start date.';
  }
  if (!isValidDateOnly(selection.endDate)) {
    errors.endDate = 'Enter a valid end date.';
  } else if (
    errors.startDate === undefined &&
    selection.endDate < selection.startDate
  ) {
    errors.endDate = 'End date must be the same as or after start date.';
  }
  return errors;
}

function exportErrorMessage(error: unknown): string {
  if (!(error instanceof AdminApiRequestError)) {
    return 'The CSV download could not be prepared. No download was started.';
  }
  if (error.kind === 'timeout') {
    return 'The CSV request timed out. No download was started. Try again.';
  }
  if (error.kind === 'network') {
    return 'The CSV request could not reach the server. No download was started.';
  }
  if (error.kind === 'invalid-response') {
    return 'The server returned an invalid CSV response. No download was started.';
  }
  if (error.status === 403) {
    return 'Your current account is not permitted to download this export.';
  }
  if (error.status === 404) {
    return 'This export is not available. No download was started.';
  }
  if (error.status === 422) {
    return 'The export parameters were not accepted. Review them and try again.';
  }
  if (error.status === 429) {
    return error.retryAfterSeconds === null
      ? 'Too many export requests. No download was started. Wait and try again.'
      : `Too many export requests. No download was started. Try again in ${error.retryAfterSeconds} seconds.`;
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return 'The export service is temporarily unavailable. No download was started.';
  }
  return 'The CSV request was not successful. No download was started.';
}

function buildRequestContext(
  kind: AdminExportKind,
  dates: AdminDateRangeSelection,
  currency: string,
  orderStatus: '' | ExportOrderStatus,
  orderType: '' | ExportOrderType,
): ExportRequestContext {
  return {
    currency,
    endDate: dates.endDate,
    ...(kind === 'orders' && orderStatus !== '' ? { orderStatus } : {}),
    ...(kind === 'orders' && orderType !== '' ? { orderType } : {}),
    startDate: dates.startDate,
  };
}

function describeRequestContext(
  kind: AdminExportKind,
  context: ExportRequestContext,
): string {
  const hasValidPeriod =
    isValidDateOnly(context.startDate) &&
    isValidDateOnly(context.endDate) &&
    context.endDate >= context.startDate;
  const periodLabel = hasValidPeriod
    ? `Period ${context.startDate} to ${context.endDate} inclusive (Europe/Oslo)`
    : 'a valid date period is required before downloading';
  const parts = [
    periodLabel,
    context.currency === ''
      ? 'all currencies, kept separate'
      : CURRENCY_CODE_PATTERN.test(context.currency)
        ? `currency ${context.currency}`
        : 'a valid three-letter currency is required before downloading',
  ];
  if (kind === 'orders') {
    parts.push(
      context.orderStatus === undefined
        ? 'all statuses'
        : `status ${ORDER_STATUS_LABELS[context.orderStatus]}`,
      context.orderType === undefined
        ? 'all order types'
        : `order type ${ORDER_TYPE_LABELS[context.orderType]}`,
    );
  }
  return parts.join(' · ');
}

function noticeVariant(kind: ExportNotice['kind']): NoticeVariant {
  if (kind === 'error') return 'danger';
  if (kind === 'success') return 'success';
  return 'info';
}

export default function AdminExportsPage() {
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    refreshCurrentUser,
  } = useAuth();
  const [dates, setDates] = useState(getDefaultAdminDateRange);
  const [dateErrors, setDateErrors] = useState<AdminDateRangeErrors>({});
  const [currency, setCurrency] = useState('');
  const [currencyError, setCurrencyError] = useState<string>();
  const [orderStatus, setOrderStatus] = useState<'' | ExportOrderStatus>('');
  const [orderType, setOrderType] = useState<'' | ExportOrderType>('');
  const [notices, setNotices] = useState<Record<AdminExportKind, ExportNotice>>({
    orders: INITIAL_NOTICE,
    payments: INITIAL_NOTICE,
    'product-sales': INITIAL_NOTICE,
  });
  const dateControlRef = useRef<AdminDateRangeControlHandle>(null);
  const currencyRef = useRef<HTMLInputElement>(null);
  const exportActionRefs = useRef<Record<AdminExportKind, HTMLButtonElement | null>>({
    orders: null,
    payments: null,
    'product-sales': null,
  });
  const focusVersionRef = useRef(0);
  const pendingFocusRestoresRef = useRef(new Map<AdminExportKind, number>());
  const pendingRef = useRef(new Set<AdminExportKind>());
  const controllersRef = useRef(new Map<AdminExportKind, AbortController>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const controllers = controllersRef.current;
    return () => {
      mountedRef.current = false;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    pendingFocusRestoresRef.current.forEach((focusVersion, kind) => {
      if (notices[kind].kind !== 'error') return;
      pendingFocusRestoresRef.current.delete(kind);
      if (!mountedRef.current || focusVersionRef.current !== focusVersion) return;
      const action = exportActionRefs.current[kind];
      if (action === null || document.activeElement === action) return;
      if (document.activeElement === null || document.activeElement === document.body) {
        action.focus();
      }
    });
  }, [notices]);

  const setNotice = (kind: AdminExportKind, notice: ExportNotice) => {
    if (!mountedRef.current) return;
    setNotices((current) => ({ ...current, [kind]: notice }));
  };

  const focusFirstError = (hasDateError: boolean) => {
    window.setTimeout(() => {
      if (hasDateError) dateControlRef.current?.focusFirstInvalid();
      else currencyRef.current?.focus();
    }, 0);
  };

  const startExport = async (kind: AdminExportKind) => {
    if (pendingRef.current.has(kind)) return;
    const nextDateErrors = validateDates(dates);
    const normalizedCurrency = currency.trim().toUpperCase();
    const nextCurrencyError =
      normalizedCurrency === '' || CURRENCY_CODE_PATTERN.test(normalizedCurrency)
        ? undefined
        : 'Currency must contain exactly three uppercase ASCII letters.';
    setDateErrors(nextDateErrors);
    setCurrency(normalizedCurrency);
    setCurrencyError(nextCurrencyError);
    const hasDateError = Object.keys(nextDateErrors).length > 0;
    if (hasDateError || nextCurrencyError !== undefined) {
      focusFirstError(hasDateError);
      return;
    }

    const authSession = getAuthenticatedSession();
    if (authSession === null) {
      logout();
      return;
    }
    const actionHadFocus = document.activeElement === exportActionRefs.current[kind];
    const focusVersion = focusVersionRef.current;
    const accessToken = authSession.accessToken;
    const range = buildAdminAwareDateRange(dates);
    const requestContext = buildRequestContext(
      kind,
      dates,
      normalizedCurrency,
      orderStatus,
      orderType,
    );
    const controller = new AbortController();
    pendingRef.current.add(kind);
    controllersRef.current.set(kind, controller);
    setNotice(kind, {
      context: requestContext,
      kind: 'pending',
      message: 'The authenticated request is in progress. No file is ready yet.',
    });

    try {
      const response = await requestAdminCsvExport(
        kind,
        {
          ...range,
          ...(normalizedCurrency === '' ? {} : { currency: normalizedCurrency }),
          ...(kind === 'orders' && orderStatus !== '' ? { status: orderStatus } : {}),
          ...(kind === 'orders' && orderType !== '' ? { orderType } : {}),
        },
        accessToken,
        controller.signal,
      );
      const filename = getCsvDownloadFilename(kind, response.contentDisposition);
      downloadCsvBlob(response.blob, filename);
      setNotice(kind, {
        context: requestContext,
        filename,
        kind: 'success',
        message: 'The expected CSV response started one browser download.',
      });
    } catch (error: unknown) {
      if (error instanceof AdminApiRequestError && error.kind === 'aborted') return;
      if (
        error instanceof AdminApiRequestError &&
        error.kind === 'http' &&
        error.status === 401
      ) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 403) {
        await refreshCurrentUser();
      }
      if (actionHadFocus) {
        pendingFocusRestoresRef.current.set(kind, focusVersion);
      }
      setNotice(kind, {
        context: requestContext,
        kind: 'error',
        message: exportErrorMessage(error),
      });
    } finally {
      pendingRef.current.delete(kind);
      controllersRef.current.delete(kind);
    }
  };

  const renderNotice = (kind: AdminExportKind) => {
    const notice = notices[kind];
    if (notice.kind === 'idle') return null;
    const label = EXPORT_LABELS[kind];
    const title =
      notice.kind === 'pending'
        ? `Preparing ${label} CSV`
        : notice.kind === 'success'
          ? `${label} CSV download started`
          : `${label} CSV was not downloaded`;
    return (
      <Notice
        className={styles.exportNotice}
        title={title}
        variant={noticeVariant(notice.kind)}
      >
        <p>{notice.message}</p>
        {notice.context === null ? null : (
          <p className={styles.noticeDetail}>
            <strong>Request context:</strong>{' '}
            {describeRequestContext(kind, notice.context)}
          </p>
        )}
        {notice.filename === undefined ? null : (
          <p className={styles.noticeDetail}>
            <strong>Download filename:</strong> <code>{notice.filename}</code>
          </p>
        )}
      </Notice>
    );
  };

  const nextContext = (kind: AdminExportKind) =>
    describeRequestContext(
      kind,
      buildRequestContext(
        kind,
        dates,
        currency.trim().toUpperCase(),
        orderStatus,
        orderType,
      ),
    );

  return (
    <section
      className={styles.page}
      aria-labelledby="exports-heading"
      onFocusCapture={() => {
        focusVersionRef.current += 1;
      }}
    >
      <header className={styles.pageHeader}>
        <div className={styles.headingCopy}>
          <p className="eyebrow">Administrator reports</p>
          <h1 id="exports-heading">Exports</h1>
          <p>
            Each action prepares one authenticated, backend-authoritative CSV. Files
            download directly and are not stored in this workspace.
          </p>
        </div>
        <div className={styles.inventorySummary} aria-label={'Export inventory'}>
          <StatusBadge variant={'info'}>3 available exports</StatusBadge>
          <span>CSV only</span>
        </div>
      </header>

      <section
        className={styles.parameterPanel}
        aria-labelledby="export-filters-heading"
      >
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionEyebrow}>Request setup</p>
            <h2 id="export-filters-heading">Parameters for the next download</h2>
          </div>
          <StatusBadge variant="neutral">Exports only</StatusBadge>
        </div>
        <p className={styles.parameterExplanation}>
          These values are local to Exports and are not inherited from Analytics. Each
          action takes its own immutable snapshot when activated.
        </p>
        <div className={styles.commonFilters}>
          <AdminDateRangeControl
            ref={dateControlRef}
            errors={dateErrors}
            value={dates}
            onChange={(value) => {
              setDates(value);
              setDateErrors({});
            }}
          />
          <label className={styles.currencyField}>
            Currency (optional)
            <input
              ref={currencyRef}
              aria-describedby={
                currencyError === undefined
                  ? 'export-currency-hint'
                  : 'export-currency-hint export-currency-error'
              }
              aria-invalid={currencyError !== undefined}
              autoCapitalize="characters"
              maxLength={3}
              value={currency}
              onChange={(event) => {
                setCurrency(event.currentTarget.value.toUpperCase());
                setCurrencyError(undefined);
              }}
            />
            <span className={styles.hint} id="export-currency-hint">
              Leave blank for every currency. Amounts remain separated; no FX conversion
              is performed.
            </span>
            {currencyError !== undefined ? (
              <span className={styles.fieldError} id="export-currency-error">
                {currencyError}
              </span>
            ) : null}
          </label>
        </div>
      </section>

      <div className={styles.inventoryHeading}>
        <div>
          <p className={styles.sectionEyebrow}>Available reports</p>
          <h2 id="export-inventory-heading">Available CSV exports</h2>
        </div>
        <p>
          Only the parameters listed on each export are sent. There are no scheduled
          jobs, saved history, or additional file formats.
        </p>
      </div>

      <div className={styles.cards}>
        <section
          className={styles.card}
          aria-busy={notices.orders.kind === 'pending' || undefined}
          aria-labelledby="orders-export-heading"
        >
          <header className={styles.cardHeader}>
            <div>
              <p className={styles.cardEyebrow}>Operational records</p>
              <h3 id="orders-export-heading">Orders</h3>
            </div>
            <StatusBadge variant="neutral">CSV</StatusBadge>
          </header>
          <p id="orders-export-description">
            Orders created during the selected period, including their operational
            status, order type, table snapshot, currency, and totals.
          </p>
          <dl className={styles.exportFacts}>
            <div>
              <dt>Time basis</dt>
              <dd>Order creation time</dd>
            </div>
            <div>
              <dt>Available parameters</dt>
              <dd>Period, currency, status, order type</dd>
            </div>
            <div>
              <dt>File</dt>
              <dd>CSV (.csv)</dd>
            </div>
          </dl>
          <div className={styles.orderFilters}>
            <label>
              Order status
              <select
                value={orderStatus}
                onChange={(event) =>
                  setOrderStatus(event.currentTarget.value as '' | ExportOrderStatus)
                }
              >
                <option value="">All statuses</option>
                <option value="created">Created</option>
                <option value="accepted">Accepted</option>
                <option value="preparing">Preparing</option>
                <option value="ready">Ready</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label>
              Order type
              <select
                value={orderType}
                onChange={(event) =>
                  setOrderType(event.currentTarget.value as '' | ExportOrderType)
                }
              >
                <option value="">All order types</option>
                <option value="dine_in">Dine in</option>
                <option value="takeaway">Takeaway</option>
              </select>
            </label>
          </div>
          <p className={styles.nextContext} id="orders-next-context">
            <strong>Next download context:</strong> {nextContext('orders')}
          </p>
          <Button
            ref={(node) => {
              exportActionRefs.current.orders = node;
            }}
            aria-describedby="orders-export-description orders-next-context"
            className={styles.exportAction}
            loading={notices.orders.kind === 'pending'}
            loadingLabel="Preparing orders CSV"
            size="md"
            variant="primary"
            onClick={() => void startExport('orders')}
          >
            Download orders CSV
          </Button>
          {renderNotice('orders')}
        </section>

        <section
          className={styles.card}
          aria-busy={notices['product-sales'].kind === 'pending' || undefined}
          aria-labelledby="product-export-heading"
        >
          <header className={styles.cardHeader}>
            <div>
              <p className={styles.cardEyebrow}>Historical sales</p>
              <h3 id="product-export-heading">Product sales</h3>
            </div>
            <StatusBadge variant="neutral">CSV</StatusBadge>
          </header>
          <p id="product-export-description">
            Every qualified historical product-sales group in the selected period,
            without the Analytics top-item limit.
          </p>
          <dl className={styles.exportFacts}>
            <div>
              <dt>Time basis</dt>
              <dd>Earliest qualified payment success</dd>
            </div>
            <div>
              <dt>Available parameters</dt>
              <dd>Period, currency</dd>
            </div>
            <div>
              <dt>File</dt>
              <dd>CSV (.csv)</dd>
            </div>
          </dl>
          <p className={styles.nextContext} id="product-sales-next-context">
            <strong>Next download context:</strong> {nextContext('product-sales')}
          </p>
          <Button
            ref={(node) => {
              exportActionRefs.current['product-sales'] = node;
            }}
            aria-describedby="product-export-description product-sales-next-context"
            className={styles.exportAction}
            loading={notices['product-sales'].kind === 'pending'}
            loadingLabel="Preparing product sales CSV"
            size="md"
            variant="primary"
            onClick={() => void startExport('product-sales')}
          >
            Download product sales CSV
          </Button>
          {renderNotice('product-sales')}
        </section>

        <section
          className={styles.card}
          aria-busy={notices.payments.kind === 'pending' || undefined}
          aria-labelledby="payments-export-heading"
        >
          <header className={styles.cardHeader}>
            <div>
              <p className={styles.cardEyebrow}>Qualified receipts</p>
              <h3 id="payments-export-heading">Payments</h3>
            </div>
            <StatusBadge variant="neutral">CSV</StatusBadge>
          </header>
          <p id="payments-export-description">
            One row for each qualified succeeded payment in the selected period. Failed
            and unverified attempts are not inferred.
          </p>
          <dl className={styles.exportFacts}>
            <div>
              <dt>Time basis</dt>
              <dd>Earliest qualified payment success</dd>
            </div>
            <div>
              <dt>Available parameters</dt>
              <dd>Period, currency</dd>
            </div>
            <div>
              <dt>File</dt>
              <dd>CSV (.csv)</dd>
            </div>
          </dl>
          <p className={styles.nextContext} id="payments-next-context">
            <strong>Next download context:</strong> {nextContext('payments')}
          </p>
          <Button
            ref={(node) => {
              exportActionRefs.current.payments = node;
            }}
            aria-describedby="payments-export-description payments-next-context"
            className={styles.exportAction}
            loading={notices.payments.kind === 'pending'}
            loadingLabel="Preparing payments CSV"
            size="md"
            variant="primary"
            onClick={() => void startExport('payments')}
          >
            Download payments CSV
          </Button>
          {renderNotice('payments')}
        </section>
      </div>
    </section>
  );
}
