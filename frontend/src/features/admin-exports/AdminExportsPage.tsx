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
import { useAuth } from '../auth/AuthContext';
import {
  requestAdminCsvExport,
  type AdminExportKind,
  type ExportOrderStatus,
  type ExportOrderType,
} from './adminExportsApi';
import { downloadCsvBlob, getCsvDownloadFilename } from './csvDownload';
import styles from './AdminExportsPage.module.css';

interface ExportNotice {
  kind: 'error' | 'idle' | 'pending' | 'success';
  message: string;
}

const INITIAL_NOTICE: ExportNotice = { kind: 'idle', message: '' };
const EXPORT_LABELS: Readonly<Record<AdminExportKind, string>> = {
  orders: 'Orders',
  payments: 'Payments',
  'product-sales': 'Product sales',
};

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
    return 'The CSV download could not be prepared. Try again.';
  }
  if (error.kind === 'timeout') {
    return 'The CSV request timed out. Try again.';
  }
  if (error.kind === 'network') {
    return 'The CSV request could not reach the server. Try again.';
  }
  if (error.kind === 'invalid-response') {
    return 'The server returned an invalid CSV response. No download was started.';
  }
  if (error.status === 422) {
    return 'The export filters were not accepted. Review them and try again.';
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return 'The export service is temporarily unavailable. Try again.';
  }
  return 'The CSV request was not successful. Try again.';
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
  const pendingRef = useRef(new Set<AdminExportKind>());
  const controllersRef = useRef(new Map<AdminExportKind, AbortController>());
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      controllersRef.current.forEach((controller) => controller.abort());
      controllersRef.current.clear();
    },
    [],
  );

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
      normalizedCurrency === '' || /^[A-Z]{3}$/.test(normalizedCurrency)
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
    const accessToken = authSession.accessToken;
    const range = buildAdminAwareDateRange(dates);
    const controller = new AbortController();
    pendingRef.current.add(kind);
    controllersRef.current.set(kind, controller);
    setNotice(kind, {
      kind: 'pending',
      message: `${EXPORT_LABELS[kind]} CSV download is being prepared.`,
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
      downloadCsvBlob(
        response.blob,
        getCsvDownloadFilename(kind, response.contentDisposition),
      );
      setNotice(kind, {
        kind: 'success',
        message: `${EXPORT_LABELS[kind]} CSV download started.`,
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
      setNotice(kind, { kind: 'error', message: exportErrorMessage(error) });
    } finally {
      pendingRef.current.delete(kind);
      controllersRef.current.delete(kind);
    }
  };

  const renderNotice = (kind: AdminExportKind) => {
    const notice = notices[kind];
    if (notice.kind === 'idle') return null;
    return (
      <p
        className={notice.kind === 'error' ? styles.error : styles.notice}
        role={notice.kind === 'error' ? 'alert' : 'status'}
      >
        {notice.message}
      </p>
    );
  };

  return (
    <section className={styles.page} aria-labelledby="exports-heading">
      <header className={styles.heading}>
        <p className="eyebrow">Administrator reports</p>
        <h1 id="exports-heading">Exports</h1>
        <p>Download backend-authoritative CSV reports for the selected period.</p>
      </header>

      <section className={styles.filters} aria-labelledby="export-filters-heading">
        <h2 id="export-filters-heading">Common filters</h2>
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
            Leave blank to include every currency. Currencies are never converted.
          </span>
          {currencyError !== undefined ? (
            <span className={styles.error} id="export-currency-error">
              {currencyError}
            </span>
          ) : null}
        </label>
      </section>

      <div className={styles.cards}>
        <section className={styles.card} aria-labelledby="orders-export-heading">
          <h2 id="orders-export-heading">Orders</h2>
          <p id="orders-export-description">
            Includes orders created during the selected period, based on order creation
            time.
          </p>
          <div className={styles.orderFilters}>
            <label>
              Status
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
          <button
            aria-describedby="orders-export-description"
            disabled={notices.orders.kind === 'pending'}
            type="button"
            onClick={() => void startExport('orders')}
          >
            {notices.orders.kind === 'pending'
              ? 'Preparing orders CSV…'
              : 'Download orders CSV'}
          </button>
          {renderNotice('orders')}
        </section>

        <section className={styles.card} aria-labelledby="product-export-heading">
          <h2 id="product-export-heading">Product sales</h2>
          <p id="product-export-description">
            Uses the earliest qualified successful payment time in the selected period.
          </p>
          <button
            aria-describedby="product-export-description"
            disabled={notices['product-sales'].kind === 'pending'}
            type="button"
            onClick={() => void startExport('product-sales')}
          >
            {notices['product-sales'].kind === 'pending'
              ? 'Preparing product sales CSV…'
              : 'Download product sales CSV'}
          </button>
          {renderNotice('product-sales')}
        </section>

        <section className={styles.card} aria-labelledby="payments-export-heading">
          <h2 id="payments-export-heading">Payments</h2>
          <p id="payments-export-description">
            Uses the earliest qualified successful payment time in the selected period.
          </p>
          <button
            aria-describedby="payments-export-description"
            disabled={notices.payments.kind === 'pending'}
            type="button"
            onClick={() => void startExport('payments')}
          >
            {notices.payments.kind === 'pending'
              ? 'Preparing payments CSV…'
              : 'Download payments CSV'}
          </button>
          {renderNotice('payments')}
        </section>
      </div>
    </section>
  );
}
