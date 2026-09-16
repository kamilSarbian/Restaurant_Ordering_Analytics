import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import BrandMark from '../../components/branding/BrandMark';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import { type AuthenticatedSession, useAuth } from '../auth/AuthContext';
import { isPublicOrderNumber, loadOrderAccess } from '../checkout/orderAccessStorage';
import styles from './OrderStatusPage.module.css';
import OrderStatusSummary from './OrderStatusSummary';
import { useOrderStatusPolling } from './useOrderStatusPolling';

function OrderStatusBrandLockup() {
  return (
    <div className={styles.brandLockup}>
      <BrandMark className={styles.brandMark} size={24} />
      <span>Nordic Hearth</span>
    </div>
  );
}

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
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRetryFocusRef = useRef(false);

  useEffect(() => {
    if (!restoreRetryFocusRef.current || polling.isLoading || polling.isRefreshing) {
      return;
    }

    restoreRetryFocusRef.current = false;
    if (polling.error?.retryable !== true) {
      return;
    }

    const activeElement = document.activeElement;
    if (
      activeElement === null ||
      activeElement === document.body ||
      !activeElement.isConnected
    ) {
      retryButtonRef.current?.focus();
    }
  }, [polling.error, polling.isLoading, polling.isRefreshing]);

  const handleRetryStatus = (): void => {
    restoreRetryFocusRef.current = true;
    polling.retryNow();
  };

  if (validPublicOrderNumber === null) {
    return (
      <div className={styles.page}>
        <section className={styles.panel} aria-labelledby="status-unavailable-title">
          <OrderStatusBrandLockup />
          <p className={styles.eyebrow}>Order access</p>
          <h1 id="status-unavailable-title">Order status unavailable</h1>
          <p>
            This browser session does not have the guest access needed to view this
            order. Access credentials cannot be recovered from the URL.
          </p>
          <Link
            className={`${styles.actionLink} ${styles.primaryAction}`}
            data-action-priority="primary"
            to="/menu"
          >
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
          <OrderStatusBrandLockup />
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
          <OrderStatusBrandLockup />
          <p className={styles.eyebrow}>Order access</p>
          <h1>Session validation is unavailable</h1>
          <p>Your saved session is retained. Retry validation or log out explicitly.</p>
          <div className={styles.panelActions}>
            <Button className={styles.retryButton} onClick={() => void retrySession()}>
              Retry validation
            </Button>
            <Button className={styles.retryButton} onClick={logout} variant="ghost">
              Log out
            </Button>
          </div>
        </section>
      </div>
    );
  }

  if (authenticatedRequestWasRejected) {
    return (
      <div className={styles.page}>
        <section className={styles.panel} role="alert" aria-live="assertive">
          <OrderStatusBrandLockup />
          <p className={styles.eyebrow}>Order access</p>
          <h1>Your session expired</h1>
          <p>Sign in again before explicitly retrying this order status request.</p>
          <Link
            className={`${styles.actionLink} ${styles.primaryAction}`}
            data-action-priority="primary"
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
          <OrderStatusBrandLockup />
          <p className={styles.eyebrow}>Order access</p>
          <h1 id="status-unavailable-title">Order status unavailable</h1>
          <p>
            This browser session does not have the guest access needed to view this
            order. Access credentials cannot be recovered from the URL.
          </p>
          <Link
            className={`${styles.actionLink} ${styles.primaryAction}`}
            data-action-priority="primary"
            to="/menu"
          >
            Browse the menu
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <OrderStatusBrandLockup />
        <p className={styles.eyebrow}>Latest fulfilment update</p>
        <h1>Order status</h1>
        <p className={styles.pageIntro}>
          Follow the latest order state reported by the restaurant.
        </p>
      </header>

      {polling.isLoading && polling.data === null && (
        <Notice className={styles.stateNotice} title="Finding your order">
          Loading order status…
        </Notice>
      )}

      {polling.error !== null && (
        <Notice
          className={styles.stateNotice}
          role="alert"
          title="We could not refresh the order"
          variant="danger"
        >
          <p>{polling.error.message}</p>
          {polling.error.retryable && (
            <Button
              ref={retryButtonRef}
              className={styles.retryButton}
              disabled={polling.isPaused || polling.isRefreshing}
              onClick={handleRetryStatus}
              variant="secondary"
            >
              Retry status
            </Button>
          )}
        </Notice>
      )}

      {polling.data !== null && (
        <div className={styles.statusExperience}>
          <OrderStatusSummary
            isRefreshing={polling.isRefreshing}
            isStopped={polling.isStopped}
            order={polling.data}
            presentation="public-status"
          />
        </div>
      )}

      {polling.isPaused && !polling.isStopped && (
        <Notice className={styles.stateNotice} title="Updates paused">
          Status updates are paused while this tab is hidden or the browser is offline.
        </Notice>
      )}

      <nav className={styles.navigation} aria-label="Order status navigation">
        <Link
          className={`${styles.actionLink} ${styles.primaryAction}`}
          data-action-priority="primary"
          to="/menu"
        >
          Browse the menu
        </Link>
      </nav>
    </div>
  );
}
