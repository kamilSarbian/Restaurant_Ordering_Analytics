import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { type AuthenticatedSession, useAuth } from '../auth/AuthContext';
import { isPublicOrderNumber, loadOrderAccess } from '../checkout/orderAccessStorage';
import styles from './OrderStatusPage.module.css';
import OrderStatusSummary from './OrderStatusSummary';
import { useOrderStatusPolling } from './useOrderStatusPolling';

/** Display and safely refresh one guest-visible fulfilment snapshot. */
export default function OrderStatusPage() {
  const { publicOrderNumber } = useParams();
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    phase,
    retrySession,
  } = useAuth();
  const [rejectedSession, setRejectedSession] = useState<AuthenticatedSession | null>(
    null,
  );
  const validPublicOrderNumber = isPublicOrderNumber(publicOrderNumber)
    ? publicOrderNumber
    : null;
  const guestAccessToken =
    validPublicOrderNumber === null ? null : loadOrderAccess(validPublicOrderNumber);
  const authenticatedSession =
    phase === 'authenticated' ? getAuthenticatedSession() : null;
  const accessToken = authenticatedSession?.accessToken;
  const sessionGeneration = authenticatedSession?.generation;
  const authenticatedRequestWasRejected =
    rejectedSession !== null &&
    (accessToken === undefined ||
      (rejectedSession.accessToken === accessToken &&
        rejectedSession.generation === sessionGeneration));
  const handleUnauthorized = useCallback(() => {
    if (accessToken === undefined || sessionGeneration === undefined) {
      return;
    }
    const failedSession = { accessToken, generation: sessionGeneration };
    setRejectedSession(failedSession);
    invalidateSessionIfCurrent(failedSession);
  }, [accessToken, invalidateSessionIfCurrent, sessionGeneration]);
  const pollingEnabled =
    validPublicOrderNumber !== null &&
    !authenticatedRequestWasRejected &&
    ((phase === 'authenticated' && accessToken !== undefined) ||
      (phase === 'unauthenticated' && guestAccessToken !== null));
  const polling = useOrderStatusPolling(validPublicOrderNumber ?? '', {
    ...(phase === 'authenticated' && accessToken !== undefined ? { accessToken } : {}),
    enabled: pollingEnabled,
    ...(guestAccessToken === null ? {} : { guestAccessToken }),
    onUnauthorized: handleUnauthorized,
  });

  if (validPublicOrderNumber === null) {
    return (
      <div className={styles.page}>
        <section className={styles.panel} aria-labelledby="status-unavailable-title">
          <p className={styles.eyebrow}>Order access</p>
          <h1 id="status-unavailable-title">Order status unavailable</h1>
          <p>
            This browser session does not have the guest access needed to view this
            order. Access credentials cannot be recovered from the URL.
          </p>
          <Link className={styles.actionLink} to="/menu">
            Browse the menu
          </Link>
        </section>
      </div>
    );
  }

  if (phase === 'checking-session') {
    return (
      <div className={styles.page}>
        <section className={styles.panel} role="status" aria-live="polite">
          <p className={styles.eyebrow}>Order access</p>
          <h1>Checking your session</h1>
          <p>Order status will load after your saved session is validated.</p>
        </section>
      </div>
    );
  }

  if (phase === 'temporarily-unavailable') {
    return (
      <div className={styles.page}>
        <section className={styles.panel} role="alert" aria-live="assertive">
          <p className={styles.eyebrow}>Order access</p>
          <h1>Session validation is unavailable</h1>
          <p>Your saved session is retained. Retry validation or log out explicitly.</p>
          <button
            className={styles.retryButton}
            type="button"
            onClick={() => void retrySession()}
          >
            Retry validation
          </button>
          <button className={styles.retryButton} type="button" onClick={logout}>
            Log out
          </button>
        </section>
      </div>
    );
  }

  if (authenticatedRequestWasRejected) {
    return (
      <div className={styles.page}>
        <section className={styles.panel} role="alert" aria-live="assertive">
          <p className={styles.eyebrow}>Order access</p>
          <h1>Your session expired</h1>
          <p>Sign in again before explicitly retrying this order status request.</p>
          <Link
            className={styles.actionLink}
            to={`/login?next=${encodeURIComponent(`/orders/${validPublicOrderNumber}/status`)}`}
          >
            Sign in
          </Link>
        </section>
      </div>
    );
  }

  if (
    (phase === 'unauthenticated' && guestAccessToken === null) ||
    (phase === 'authenticated' && accessToken === undefined)
  ) {
    return (
      <div className={styles.page}>
        <section className={styles.panel} aria-labelledby="status-unavailable-title">
          <p className={styles.eyebrow}>Order access</p>
          <h1 id="status-unavailable-title">Order status unavailable</h1>
          <p>
            This browser session does not have the guest access needed to view this
            order. Access credentials cannot be recovered from the URL.
          </p>
          <Link className={styles.actionLink} to="/menu">
            Browse the menu
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>Live fulfilment status</p>
        <h1>Order status</h1>
        <p className={styles.orderNumberLabel}>Public order number</p>
        <p className={styles.orderNumber}>{validPublicOrderNumber}</p>
      </header>

      {polling.isLoading && polling.data === null && (
        <div className={styles.notice} role="status" aria-live="polite">
          Loading order status…
        </div>
      )}

      {polling.error !== null && (
        <div className={styles.errorNotice} role="alert" aria-live="assertive">
          <p>{polling.error.message}</p>
          {polling.error.retryable && (
            <button
              className={styles.retryButton}
              disabled={polling.isPaused || polling.isRefreshing}
              onClick={polling.retryNow}
              type="button"
            >
              Retry status
            </button>
          )}
        </div>
      )}

      {polling.data !== null && (
        <OrderStatusSummary
          isRefreshing={polling.isRefreshing}
          isStopped={polling.isStopped}
          order={polling.data}
        />
      )}

      {polling.isPaused && (
        <p className={styles.pausedNotice} role="status" aria-live="polite">
          Status updates are paused while this tab is hidden or the browser is offline.
        </p>
      )}

      <nav className={styles.navigation} aria-label="Order status navigation">
        <Link className={styles.actionLink} to="/menu">
          Browse the menu
        </Link>
      </nav>
    </div>
  );
}
