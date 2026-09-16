import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { AuthenticatedApiRequestError } from '../../api/authenticatedApi';
import type { OrderStatusResponse } from '../../api/types';
import BrandMark from '../../components/branding/BrandMark';
import Button from '../../components/ui/Button';
import Notice, {
  type NoticeRole,
  type NoticeVariant,
} from '../../components/ui/Notice';
import { type AuthenticatedSession, useAuth } from '../auth/AuthContext';
import OrderStatusSummary, {
  formatCustomerDate,
} from '../order-status/OrderStatusSummary';
import orderStatusStyles from '../order-status/OrderStatusPage.module.css';
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

interface DetailStateSurfaceProps {
  children: ReactNode;
  copy: string;
  heading: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  noticeRole?: NoticeRole;
  noticeTitle: string;
  noticeVariant?: NoticeVariant;
}

function DetailStateSurface({
  children,
  copy,
  heading,
  headingRef,
  noticeRole = 'status',
  noticeTitle,
  noticeVariant = 'info',
}: DetailStateSurfaceProps) {
  return (
    <div className={`${styles.page} ${styles.overviewPage}`}>
      <header className={styles.overviewHeader}>
        <div className={styles.brandLockup}>
          <BrandMark size={24} />
          <span>Nordic Hearth</span>
        </div>
        <div className={styles.headingGroup}>
          <p>My account</p>
          <h1 ref={headingRef} tabIndex={-1}>
            {heading}
          </h1>
          <p>{copy}</p>
        </div>
      </header>
      <Notice
        className={styles.stateNotice}
        role={noticeRole}
        title={noticeTitle}
        variant={noticeVariant}
      >
        <div className={orderStatusStyles.panelActions}>{children}</div>
      </Notice>
    </div>
  );
}

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

interface RetryFocusIntent {
  readonly origin: HTMLElement | null;
}

function getFocusOrigin(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function shouldRestoreAsyncFocus(origin: HTMLElement | null): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement === null ||
    activeElement === document.body ||
    activeElement === origin ||
    !activeElement.isConnected ||
    (activeElement instanceof HTMLButtonElement && activeElement.disabled)
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
  const focusAfterRetryRef = useRef<RetryFocusIntent | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
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

  useEffect(() => {
    const focusIntent = focusAfterRetryRef.current;
    if (focusIntent === null) {
      return;
    }
    if (state.kind === 'loading') {
      if (shouldRestoreAsyncFocus(focusIntent.origin)) {
        headingRef.current?.focus();
      }
      return;
    }
    if (
      state.kind !== 'error' &&
      state.kind !== 'not-found' &&
      state.kind !== 'success'
    ) {
      return;
    }
    focusAfterRetryRef.current = null;
    if (shouldRestoreAsyncFocus(focusIntent.origin)) {
      headingRef.current?.focus();
    }
  }, [state.kind]);

  if (validPublicOrderNumber === null) {
    return (
      <DetailStateSurface
        copy="This order link cannot be displayed."
        heading="Order unavailable"
        headingRef={headingRef}
        noticeTitle="Continue from your account"
      >
        <Link
          className={`${orderStatusStyles.actionLink} ${orderStatusStyles.primaryAction}`}
          to="/account"
        >
          Back to orders
        </Link>
      </DetailStateSurface>
    );
  }

  if (state.kind === 'unauthorized' && currentSession === null) {
    return (
      <DetailStateSurface
        copy="Sign in again to view this personal order."
        heading="Your session expired"
        headingRef={headingRef}
        noticeRole="alert"
        noticeTitle="Sign in again"
        noticeVariant="warning"
      >
        <Link
          className={`${orderStatusStyles.actionLink} ${orderStatusStyles.primaryAction}`}
          to={`/login?next=${encodeURIComponent(
            `/account/orders/${validPublicOrderNumber}`,
          )}`}
        >
          Sign in
        </Link>
      </DetailStateSurface>
    );
  }

  if (phase === 'checking-session') {
    return (
      <DetailStateSurface
        copy="Your order will appear as soon as your account is ready."
        heading="Checking your session"
        headingRef={headingRef}
        noticeTitle="Loading order details"
      >
        <p>Please wait a moment.</p>
      </DetailStateSurface>
    );
  }

  if (phase === 'temporarily-unavailable') {
    return (
      <DetailStateSurface
        copy="Your sign-in is still saved. Try again in a moment or log out."
        heading="We cannot confirm your account right now"
        headingRef={headingRef}
        noticeRole="alert"
        noticeTitle="Your order is still protected"
        noticeVariant="warning"
      >
        <Button onClick={() => void retrySession()}>Retry account check</Button>
        <Button variant="ghost" onClick={logout}>
          Log out
        </Button>
      </DetailStateSurface>
    );
  }

  if (phase === 'unauthenticated' || currentSession === null) {
    return (
      <DetailStateSurface
        copy="Sign in to view your personal order history."
        heading="Sign in required"
        headingRef={headingRef}
        noticeTitle="Continue securely"
      >
        <Link
          className={`${orderStatusStyles.actionLink} ${orderStatusStyles.primaryAction}`}
          to={`/login?next=${encodeURIComponent(
            `/account/orders/${validPublicOrderNumber}`,
          )}`}
        >
          Sign in
        </Link>
      </DetailStateSurface>
    );
  }

  if (
    state.kind === 'idle' ||
    !sessionsMatch(currentSession, state.session) ||
    state.kind === 'loading'
  ) {
    return (
      <DetailStateSurface
        copy="We are retrieving the latest saved details for this order."
        heading="Order details"
        headingRef={headingRef}
        noticeTitle="Loading order details"
      >
        <p>Order details are on the way.</p>
      </DetailStateSurface>
    );
  }

  if (state.kind === 'not-found') {
    return (
      <DetailStateSurface
        copy="This order is unavailable."
        heading="Order unavailable"
        headingRef={headingRef}
        noticeTitle="Continue from your account"
      >
        <Link
          className={`${orderStatusStyles.actionLink} ${orderStatusStyles.primaryAction}`}
          to="/account"
        >
          Back to orders
        </Link>
      </DetailStateSurface>
    );
  }

  if (state.kind === 'error') {
    return (
      <DetailStateSurface
        copy={
          state.retryable
            ? "We couldn't retrieve this order just now."
            : 'This order cannot be displayed safely.'
        }
        heading="Unable to load order details"
        headingRef={headingRef}
        noticeRole="alert"
        noticeTitle={state.retryable ? 'Try again' : 'Return to your orders'}
        noticeVariant="danger"
      >
        {state.retryable && (
          <Button
            onClick={() => {
              focusAfterRetryRef.current = { origin: getFocusOrigin() };
              setRetryGeneration((value) => value + 1);
            }}
          >
            Retry order details
          </Button>
        )}
        <Link className={orderStatusStyles.actionLink} to="/account">
          Back to orders
        </Link>
      </DetailStateSurface>
    );
  }

  if (state.kind === 'unauthorized') {
    return null;
  }

  return (
    <div className={`${styles.page} ${styles.overviewPage}`}>
      <header className={styles.overviewHeader}>
        <div className={styles.brandLockup}>
          <BrandMark size={24} />
          <span>Nordic Hearth</span>
        </div>
        <div className={styles.headingGroup}>
          <p>My account</p>
          <h1 ref={headingRef} tabIndex={-1}>
            Order details
          </h1>
          <p className={styles.fieldLabel}>Order number</p>
          <p className={styles.orderNumber}>{state.order.public_order_number}</p>
          <p>
            Placed{' '}
            <time dateTime={state.order.created_at}>
              {formatCustomerDate(state.order.created_at)}
            </time>
          </p>
        </div>
      </header>
      <OrderStatusSummary order={state.order} presentation="account-detail" />
      <nav
        className={`${orderStatusStyles.navigation} ${orderStatusStyles.accountNavigation}`}
        aria-label="Order detail actions"
      >
        <Link
          className={`${orderStatusStyles.actionLink} ${orderStatusStyles.primaryAction}`}
          to="/account"
        >
          Back to orders
        </Link>
        <Link className={orderStatusStyles.actionLink} to="/menu">
          View menu
        </Link>
      </nav>
    </div>
  );
}
