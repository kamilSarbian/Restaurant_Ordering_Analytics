import { forwardRef, useImperativeHandle, useRef } from 'react';

import {
  ADMIN_ANALYTICS_TIME_ZONE,
  type AdminDateRangeSelection,
} from './adminDateRange';
import styles from './AdminDateRangeControl.module.css';

export interface AdminDateRangeErrors {
  endDate?: string;
  startDate?: string;
}

export interface AdminDateRangeControlHandle {
  focusFirstInvalid: () => void;
}

interface AdminDateRangeControlProps {
  disabled?: boolean;
  errors: AdminDateRangeErrors;
  onChange: (value: AdminDateRangeSelection) => void;
  value: AdminDateRangeSelection;
}

/** Render a controlled, date-only administrator reporting range. */
const AdminDateRangeControl = forwardRef<
  AdminDateRangeControlHandle,
  AdminDateRangeControlProps
>(function AdminDateRangeControl({ disabled = false, errors, onChange, value }, ref) {
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusFirstInvalid: () => {
      if (errors.startDate !== undefined) startRef.current?.focus();
      else if (errors.endDate !== undefined) endRef.current?.focus();
    },
  }));

  return (
    <fieldset className={styles.fieldset}>
      <legend>Reporting period</legend>
      <p className={styles.timeZone} id="analytics-time-zone">
        Calendar dates use {ADMIN_ANALYTICS_TIME_ZONE}. The end date is inclusive.
      </p>
      <div className={styles.fields}>
        <label>
          Start date
          <input
            ref={startRef}
            aria-describedby={
              errors.startDate === undefined
                ? 'analytics-time-zone'
                : 'analytics-time-zone analytics-start-error'
            }
            aria-invalid={errors.startDate !== undefined}
            disabled={disabled}
            required
            type="date"
            value={value.startDate}
            onChange={(event) =>
              onChange({ ...value, startDate: event.currentTarget.value })
            }
          />
          {errors.startDate !== undefined ? (
            <span className={styles.error} id="analytics-start-error">
              {errors.startDate}
            </span>
          ) : null}
        </label>
        <label>
          End date
          <input
            ref={endRef}
            aria-describedby={
              errors.endDate === undefined
                ? 'analytics-time-zone'
                : 'analytics-time-zone analytics-end-error'
            }
            aria-invalid={errors.endDate !== undefined}
            disabled={disabled}
            required
            type="date"
            value={value.endDate}
            onChange={(event) =>
              onChange({ ...value, endDate: event.currentTarget.value })
            }
          />
          {errors.endDate !== undefined ? (
            <span className={styles.error} id="analytics-end-error">
              {errors.endDate}
            </span>
          ) : null}
        </label>
      </div>
    </fieldset>
  );
});

export default AdminDateRangeControl;
