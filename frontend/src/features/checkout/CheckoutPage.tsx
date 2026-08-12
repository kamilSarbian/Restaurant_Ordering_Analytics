import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';

import { ApiRequestError } from '../../api/client';
import { CheckoutRequestError, createCheckoutSession } from '../../api/customerApi';
import { useCart } from '../cart/CartContext';
import { saveCartState } from '../cart/cartStorage';
import {
  createCheckoutAttempt,
  type CheckoutAttempt,
  loadCheckoutAttempt,
  saveCheckoutAttempt,
} from './checkoutAttemptStorage';
import {
  isOrderAccessToken,
  isPublicOrderNumber,
  loadOrderAccess,
} from './orderAccessStorage';
import styles from './CheckoutPage.module.css';

interface CheckoutNavigationState {
  orderAccessToken: string;
  publicOrderNumber: string;
}

interface CheckoutPageProps {
  redirectToCheckout?: (checkoutUrl: string) => void;
}

type CheckoutFeedback =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'retry'; message: string }
  | { kind: 'rate-limit'; retryAt: number | null }
  | { kind: 'definitive' }
  | { checkoutUrl: string; kind: 'redirect-failed' }
  | { kind: 'capability' };

function readNavigationToken(value: unknown, publicOrderNumber: string): string | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('orderAccessToken' in value) ||
    !('publicOrderNumber' in value) ||
    value.publicOrderNumber !== publicOrderNumber ||
    !isOrderAccessToken(value.orderAccessToken)
  ) {
    return null;
  }
  return (value as CheckoutNavigationState).orderAccessToken;
}

function resolveInitialAttempt(
  publicOrderNumber: string | null,
  hasOrderAccess: boolean,
): CheckoutAttempt | null {
  if (publicOrderNumber === null || !hasOrderAccess) {
    return null;
  }
  const storedAttempt = loadCheckoutAttempt(publicOrderNumber);
  if (storedAttempt !== null) {
    return storedAttempt;
  }
  const attempt = createCheckoutAttempt(publicOrderNumber);
  if (attempt !== null) {
    saveCheckoutAttempt(attempt);
  }
  return attempt;
}

function uncertainCheckoutFeedback(): CheckoutFeedback {
  return {
    kind: 'retry',
    message:
      'We could not safely confirm the checkout result. Try again to reuse the same payment attempt.',
  };
}

function mapCheckoutError(error: unknown): CheckoutFeedback {
  if (!(error instanceof ApiRequestError)) {
    return uncertainCheckoutFeedback();
  }
  if (error.kind === 'http') {
    if (error.status === 429) {
      const retryAfterSeconds =
        error instanceof CheckoutRequestError ? error.retryAfterSeconds : null;
      return {
        kind: 'rate-limit',
        retryAt:
          retryAfterSeconds === null ? null : Date.now() + retryAfterSeconds * 1_000,
      };
    }
    if (error.status === 502) {
      return { kind: 'definitive' };
    }
    if (error.status === 503) {
      return uncertainCheckoutFeedback();
    }
    if (error.status === 404) {
      return {
        kind: 'retry',
        message:
          'This order could not be accessed. Check that you are using the browser session that created it.',
      };
    }
    if (error.status === 409) {
      return {
        kind: 'retry',
        message:
          'This order cannot start checkout in its current state. No new payment attempt was created.',
      };
    }
    if (error.status === 422) {
      return {
        kind: 'retry',
        message:
          'The checkout request could not be accepted. Retry this same payment attempt.',
      };
    }
  }
  if (error.kind === 'invalid-response') {
    return {
      kind: 'retry',
      message:
        'The checkout service returned an unsafe or invalid response. No redirect was attempted.',
    };
  }
  return {
    kind: 'retry',
    message:
      'The connection ended before checkout could be safely confirmed. Try again to reuse the same payment attempt.',
  };
}

function defaultRedirect(checkoutUrl: string): void {
  window.location.assign(checkoutUrl);
}

/** Start or safely replay the hosted checkout flow for one guest order. */
export default function CheckoutPage({
  redirectToCheckout = defaultRedirect,
}: CheckoutPageProps) {
  const { publicOrderNumber } = useParams();
  const location = useLocation();
  const { clearCart } = useCart();
  const validPublicOrderNumber = isPublicOrderNumber(publicOrderNumber)
    ? publicOrderNumber
    : null;
  const navigationToken =
    validPublicOrderNumber === null
      ? null
      : readNavigationToken(location.state, validPublicOrderNumber);
  const storedToken =
    validPublicOrderNumber === null ? null : loadOrderAccess(validPublicOrderNumber);
  const orderAccessToken = navigationToken ?? storedToken;
  const hasOrderAccess = orderAccessToken !== null;
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(() =>
    resolveInitialAttempt(validPublicOrderNumber, hasOrderAccess),
  );
  const [feedback, setFeedback] = useState<CheckoutFeedback>(
    attempt === null && hasOrderAccess ? { kind: 'capability' } : { kind: 'idle' },
  );
  const [clock, setClock] = useState(() => Date.now());
  const pendingRef = useRef(false);
  const activeControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const noticeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (feedback.kind !== 'rate-limit' || feedback.retryAt === null) {
      return undefined;
    }
    const retryAt = feedback.retryAt;
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setClock(currentTime);
      if (currentTime >= retryAt) {
        window.clearInterval(timer);
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [feedback]);

  useEffect(() => {
    if (!['idle', 'pending'].includes(feedback.kind)) {
      noticeRef.current?.focus();
    }
  }, [feedback]);

  if (validPublicOrderNumber === null || !hasOrderAccess) {
    return (
      <div className={styles.page}>
        <section className={styles.panel} aria-labelledby="checkout-unavailable-title">
          <p className={styles.eyebrow}>Order access</p>
          <h1 id="checkout-unavailable-title">Order access unavailable</h1>
          <p>
            This browser session does not have the guest access needed to continue with
            this order. For security, access credentials cannot be recovered from the
            URL.
          </p>
          <nav className={styles.links} aria-label="Recovery options">
            <Link to="/cart">Return to cart</Link>
            <Link to="/">Browse the menu</Link>
          </nav>
        </section>
      </div>
    );
  }

  const retrySeconds =
    feedback.kind === 'rate-limit' && feedback.retryAt !== null
      ? Math.max(0, Math.ceil((feedback.retryAt - clock) / 1_000))
      : 0;
  const rateLimitActive = retrySeconds > 0;
  const checkoutDisabled =
    feedback.kind === 'pending' ||
    feedback.kind === 'definitive' ||
    feedback.kind === 'redirect-failed' ||
    feedback.kind === 'capability' ||
    rateLimitActive;

  const startCheckout = async (): Promise<void> => {
    if (pendingRef.current || attempt === null || checkoutDisabled) {
      return;
    }
    pendingRef.current = true;
    setFeedback({ kind: 'pending' });
    const controller = new AbortController();
    activeControllerRef.current = controller;
    try {
      const response = await createCheckoutSession(
        validPublicOrderNumber,
        orderAccessToken,
        attempt.idempotencyKey,
        controller.signal,
      );
      if (!mountedRef.current) {
        return;
      }
      clearCart();
      saveCartState({ items: [] });
      try {
        redirectToCheckout(response.checkout_url);
      } catch {
        if (mountedRef.current) {
          setFeedback({ checkoutUrl: response.checkout_url, kind: 'redirect-failed' });
        }
      }
    } catch (error: unknown) {
      if (mountedRef.current) {
        setFeedback(mapCheckoutError(error));
      }
    } finally {
      pendingRef.current = false;
      activeControllerRef.current = null;
    }
  };

  const startNewAttempt = (): void => {
    const replacement = createCheckoutAttempt(validPublicOrderNumber);
    if (replacement === null) {
      setFeedback({ kind: 'capability' });
      return;
    }
    saveCheckoutAttempt(replacement);
    setAttempt(replacement);
    setFeedback({ kind: 'idle' });
  };

  const retryRedirect = (): void => {
    if (feedback.kind !== 'redirect-failed') {
      return;
    }
    try {
      redirectToCheckout(feedback.checkoutUrl);
    } catch {
      setFeedback({ checkoutUrl: feedback.checkoutUrl, kind: 'redirect-failed' });
    }
  };

  return (
    <div className={styles.page}>
      <section className={styles.panel} aria-labelledby="order-created-title">
        <p className={styles.eyebrow}>Order received</p>
        <h1 id="order-created-title">Order created</h1>
        <p className={styles.orderNumberLabel}>Public order number</p>
        <p className={styles.orderNumber}>{validPublicOrderNumber}</p>
        <p>
          Your order has been created. Continue when you are ready to open secure hosted
          checkout in this tab.
        </p>

        <div className={styles.actions}>
          <button
            className={styles.primaryAction}
            disabled={checkoutDisabled}
            onClick={() => void startCheckout()}
            type="button"
          >
            Continue to secure payment
          </button>
        </div>

        {feedback.kind === 'pending' && (
          <div className={styles.notice} role="status" aria-live="polite">
            Creating secure checkout…
          </div>
        )}
        {feedback.kind === 'retry' && (
          <div
            className={styles.errorNotice}
            ref={noticeRef}
            role="alert"
            tabIndex={-1}
          >
            {feedback.message}
          </div>
        )}
        {feedback.kind === 'rate-limit' && (
          <div
            className={styles.errorNotice}
            ref={noticeRef}
            role="alert"
            tabIndex={-1}
          >
            {feedback.retryAt === null
              ? 'Too many checkout requests were made. Retry explicitly when you are ready; the same payment attempt will be reused.'
              : rateLimitActive
                ? `Please wait ${retrySeconds} second${retrySeconds === 1 ? '' : 's'} before retrying this same payment attempt.`
                : 'You can now retry this same payment attempt.'}
          </div>
        )}
        {feedback.kind === 'definitive' && (
          <div
            className={styles.errorNotice}
            ref={noticeRef}
            role="alert"
            tabIndex={-1}
          >
            <p>The payment provider could not create checkout for this attempt.</p>
            <button
              className={styles.secondaryAction}
              onClick={startNewAttempt}
              type="button"
            >
              Start a new payment attempt
            </button>
          </div>
        )}
        {feedback.kind === 'redirect-failed' && (
          <div
            className={styles.errorNotice}
            ref={noticeRef}
            role="alert"
            tabIndex={-1}
          >
            <p>Secure checkout was created, but this browser could not open it.</p>
            <button
              className={styles.secondaryAction}
              onClick={retryRedirect}
              type="button"
            >
              Try payment redirect again
            </button>
          </div>
        )}
        {feedback.kind === 'capability' && (
          <div
            className={styles.errorNotice}
            ref={noticeRef}
            role="alert"
            tabIndex={-1}
          >
            This browser cannot securely create a payment attempt. Update the browser or
            try another supported browser.
          </div>
        )}

        <nav className={styles.links} aria-label="Order navigation">
          <Link to="/cart">Return to cart</Link>
          <Link to="/">Browse the menu</Link>
        </nav>
      </section>
    </div>
  );
}
