import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { AuthenticatedApiRequestError } from '../../api/authenticatedApi';
import type { OrderStatusResponse } from '../../api/types';
import { type AuthenticatedSession, useAuth } from '../auth/AuthContext';
import OrderStatusSummary from '../order-status/OrderStatusSummary';
import { fetchAccountOrder } from './accountApi';
import styles from './AccountOrdersPage.module.css';

const PUBLIC_ORDER_NUMBER_PATTERN = /^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;

type DetailState =
  | { kind: 'idle' }
  | { kind: 'loading'; session: AuthenticatedSession }
  | { kind: 'success'; order: OrderStatusResponse; session: AuthenticatedSession }
  | { kind: 'not-found'; session: AuthenticatedSession }
  | { kind: 'unauthorized'; session: AuthenticatedSession }
  | {
      kind: 'error';
      retryable: boolean;
      session: AuthenticatedSession;
    };

function sessionsMatch(
  left: AuthenticatedSession | null,
  right: AuthenticatedSession,
): boolean {
  return (
    left !== null &&
    left.accessToken === right.accessToken &&
    left.generation === right.generation
  );
}

/** Display one personally owned, customer-safe order snapshot. */
export default function AccountOrderDetailPage() {
  const { publicOrderNumber } = useParams();
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    phase,
    retrySession,
  } = useAuth();
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [state, setState] = useState<DetailState>({ kind: 'idle' });
  const validPublicOrderNumber =
    typeof publicOrderNumber === 'string' &&
    PUBLIC_ORDER_NUMBER_PATTERN.test(publicOrderNumber)
      ? publicOrderNumber
      : null;
  const currentSession = phase === 'authenticated' ? getAuthenticatedSession() : null;
  const accessToken = currentSession?.accessToken;
  const sessionGeneration = currentSession?.generation;

  useEffect(() => {
    if (
      validPublicOrderNumber === null ||
      phase !== 'authenticated' ||
      accessToken === undefined ||
      sessionGeneration === undefined
    ) {
      return;
    }

    const requestSession = {
      accessToken,
      generation: sessionGeneration,
    };
    let controller: AbortController | null = null;
    let cancelled = false;
    const requestStartId = window.setTimeout(() => {
      controller = new AbortController();
      setState({ kind: 'loading', session: requestSession });

      void fetchAccountOrder(validPublicOrderNumber, {
        accessToken,
        signal: controller.signal,
      })
        .then((order) => {
          if (!cancelled) {
            setState({ kind: 'success', order, session: requestSession });
          }
        })
        .catch((error: unknown) => {
          if (cancelled) {
            return;
          }
          if (!(error instanceof AuthenticatedApiRequestError)) {
            setState({ kind: 'error', retryable: false, session: requestSession });
            return;
          }
          if (error.kind === 'aborted') {
            return;
          }
          if (error.status === 401) {
            const latestSession = getAuthenticatedSession();
            if (sessionsMatch(latestSession, requestSession)) {
              setState({ kind: 'unauthorized', session: requestSession });
              invalidateSessionIfCurrent(requestSession);
            }
            return;
          }
          if (error.status === 404) {
            setState({ kind: 'not-found', session: requestSession });
            return;
          }
          setState({
            kind: 'error',
            retryable:
              error.kind === 'network' ||
              error.kind === 'timeout' ||
              error.status === 503,
            session: requestSession,
          });
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(requestStartId);
      controller?.abort();
    };
  }, [
    accessToken,
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    phase,
    retryGeneration,
    sessionGeneration,
    validPublicOrderNumber,
  ]);

  if (validPublicOrderNumber === null) {
    return (
      <section className={styles.statePanel}>
        <h1>Order unavailable</h1>
        <p>This order cannot be displayed.</p>
        <Link className={styles.backLink} to="/account">
          Back to my orders
        </Link>
      </section>
    );
  }

  if (state.kind === 'unauthorized' && currentSession === null) {
    return (
      <section className={styles.statePanel} role="alert" aria-live="assertive">
        <h1>Your session expired</h1>
        <p>Sign in again to view this order.</p>
        <Link
          className={styles.backLink}
          to={`/login?next=${encodeURIComponent(`/account/orders/${validPublicOrderNumber}`)}`}
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (phase === 'checking-session') {
    return (
      <section className={styles.statePanel} role="status" aria-live="polite">
        <h1>Checking your session</h1>
        <p>Order details will load after your saved session is validated.</p>
      </section>
    );
  }

  if (phase === 'temporarily-unavailable') {
    return (
      <section className={styles.statePanel} role="alert" aria-live="assertive">
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
    );
  }

  if (phase === 'unauthenticated' || currentSession === null) {
    return (
      <section className={styles.statePanel}>
        <h1>Sign in required</h1>
        <p>Sign in to view your personal order history.</p>
        <Link
          className={styles.backLink}
          to={`/login?next=${encodeURIComponent(`/account/orders/${validPublicOrderNumber}`)}`}
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (
    state.kind === 'idle' ||
    !sessionsMatch(currentSession, state.session) ||
    state.kind === 'loading'
  ) {
    return (
      <section className={styles.statePanel} role="status" aria-live="polite">
        <h1>Order details</h1>
        <p>Loading order details…</p>
      </section>
    );
  }

  if (state.kind === 'not-found') {
    return (
      <section className={styles.statePanel}>
        <h1>Order unavailable</h1>
        <p>This order is unavailable.</p>
        <Link className={styles.backLink} to="/account">
          Back to my orders
        </Link>
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className={styles.statePanel} role="alert" aria-live="assertive">
        <h1>Unable to load order details</h1>
        <p>
          {state.retryable
            ? 'The order service is temporarily unavailable.'
            : 'The order response could not be used safely.'}
        </p>
        {state.retryable && (
          <button
            className={styles.retryButton}
            type="button"
            onClick={() => setRetryGeneration((value) => value + 1)}
          >
            Retry order details
          </button>
        )}
      </section>
    );
  }

  if (state.kind === 'unauthorized') {
    return null;
  }

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <p>My account</p>
        <h1>Order details</h1>
        <p>Public order number</p>
        <p>{state.order.public_order_number}</p>
        <Link className={styles.backLink} to="/account">
          Back to my orders
        </Link>
      </header>
      <OrderStatusSummary order={state.order} />
    </div>
  );
}
