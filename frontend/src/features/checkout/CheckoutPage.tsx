import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ApiRequestError } from '../../api/client';
import {
  CheckoutRequestError,
  createCheckoutSession,
  fetchOrderStatus,
} from '../../api/customerApi';
import type { OrderStatusResponse } from '../../api/types';
import BrandMark from '../../components/branding/BrandMark';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import { useAuth } from '../auth/AuthContext';
import { useCart } from '../cart/CartContext';
import { saveCartState } from '../cart/cartStorage';
import { formatCustomerMoney } from '../order-status/OrderStatusSummary';
import {
  createCheckoutAttempt,
  type CheckoutAttempt,
  loadCheckoutAttempt,
  saveCheckoutAttempt,
} from './checkoutAttemptStorage';
import { isPublicOrderNumber, loadOrderAccess } from './orderAccessStorage';
import styles from './CheckoutPage.module.css';

interface CheckoutPageProps {
  loadOrderSummary?: typeof fetchOrderStatus;
  redirectToCheckout?: (checkoutUrl: string) => void;
}

interface CheckoutPageForOrderProps extends CheckoutPageProps {
  publicOrderNumber: string | undefined;
}

type CheckoutFeedback =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'retry'; message: string }
  | { kind: 'rate-limit'; retryAt: number | null }
  | { kind: 'definitive' }
  | { checkoutUrl: string; kind: 'redirect-failed' }
  | { kind: 'capability' };

type OrderSummaryState =
  | { kind: 'idle' }
  | { kind: 'loading'; publicOrderNumber: string }
  | { kind: 'loaded'; order: OrderStatusResponse }
  | { kind: 'error'; message: string; publicOrderNumber: string };

interface AsyncFocusIntent {
  readonly origin: HTMLElement | null;
}

interface SummaryFocusIntent extends AsyncFocusIntent {
  readonly restoreOnSuccess: boolean;
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

function CheckoutBrand() {
  return (
    <div className={styles.brandLockup}>
      <BrandMark className={styles.brandMark} size={32} />
      <span>Nordic Hearth</span>
    </div>
  );
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

function getOrderSummaryErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) {
    return 'We could not load your order details. Try loading the summary again.';
  }
  if (error.kind === 'http' && error.status === 404) {
    return 'This order summary could not be accessed from this browser session.';
  }
  if (error.kind === 'invalid-response') {
    return 'The order summary could not be safely verified. Try loading it again.';
  }
  if (error.kind === 'timeout') {
    return 'Loading the order summary took too long. Try again when you are ready.';
  }
  return 'We could not load your order details. Try loading the summary again.';
}

function defaultRedirect(checkoutUrl: string): void {
  window.location.assign(checkoutUrl);
}

function CheckoutPageForOrder({
  loadOrderSummary = fetchOrderStatus,
  publicOrderNumber,
  redirectToCheckout = defaultRedirect,
}: CheckoutPageForOrderProps) {
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    phase: authPhase,
    retrySession,
  } = useAuth();
  const { clearCart } = useCart();
  const validPublicOrderNumber = isPublicOrderNumber(publicOrderNumber)
    ? publicOrderNumber
    : null;
  const orderAccessToken =
    validPublicOrderNumber === null ? null : loadOrderAccess(validPublicOrderNumber);
  const authenticatedSession =
    authPhase === 'authenticated' ? getAuthenticatedSession() : null;
  const authenticatedAccessToken = authenticatedSession?.accessToken;
  const authenticatedSessionGeneration = authenticatedSession?.generation;
  const hasOrderAccess =
    authenticatedSession !== null ||
    (authPhase === 'unauthenticated' && orderAccessToken !== null);
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(() =>
    resolveInitialAttempt(validPublicOrderNumber, hasOrderAccess),
  );
  const [feedback, setFeedback] = useState<CheckoutFeedback>(
    attempt === null && hasOrderAccess ? { kind: 'capability' } : { kind: 'idle' },
  );
  const [clock, setClock] = useState(() => Date.now());
  const [authenticatedFailure, setAuthenticatedFailure] = useState(false);
  const [orderSummary, setOrderSummary] = useState<OrderSummaryState>({ kind: 'idle' });
  const [summaryRequestVersion, setSummaryRequestVersion] = useState(0);
  const pendingRef = useRef(false);
  const activeControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const checkoutButtonRef = useRef<HTMLButtonElement | null>(null);
  const checkoutReadyFocusIntentRef = useRef<AsyncFocusIntent | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const summaryPanelRef = useRef<HTMLElement | null>(null);
  const summaryNoticeRef = useRef<HTMLDivElement | null>(null);
  const feedbackFocusIntentRef = useRef<AsyncFocusIntent | null>(
    attempt === null && hasOrderAccess ? { origin: null } : null,
  );
  const nextSummaryFocusOriginRef = useRef<HTMLElement | null | undefined>(undefined);
  const summaryFocusIntentRef = useRef<SummaryFocusIntent | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (
      validPublicOrderNumber === null ||
      authenticatedFailure ||
      !hasOrderAccess ||
      (authPhase !== 'authenticated' && authPhase !== 'unauthenticated')
    ) {
      return undefined;
    }
    const requestSession =
      authPhase === 'authenticated' &&
      authenticatedAccessToken !== undefined &&
      authenticatedSessionGeneration !== undefined
        ? {
            accessToken: authenticatedAccessToken,
            generation: authenticatedSessionGeneration,
          }
        : null;
    if (authPhase === 'authenticated' && requestSession === null) {
      return undefined;
    }

    const controller = new AbortController();
    const preparedFocusOrigin = nextSummaryFocusOriginRef.current;
    nextSummaryFocusOriginRef.current = undefined;
    summaryFocusIntentRef.current = {
      origin:
        preparedFocusOrigin === undefined ? getFocusOrigin() : preparedFocusOrigin,
      restoreOnSuccess: preparedFocusOrigin !== undefined,
    };
    void loadOrderSummary(validPublicOrderNumber, {
      ...(requestSession === null ? {} : { accessToken: requestSession.accessToken }),
      ...(orderAccessToken === null ? {} : { guestAccessToken: orderAccessToken }),
      signal: controller.signal,
    })
      .then((order) => {
        if (!controller.signal.aborted && mountedRef.current) {
          setOrderSummary({ kind: 'loaded', order });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !mountedRef.current) {
          return;
        }
        if (
          requestSession !== null &&
          error instanceof ApiRequestError &&
          error.kind === 'http' &&
          error.status === 401
        ) {
          invalidateSessionIfCurrent(requestSession);
          setAuthenticatedFailure(true);
          setOrderSummary({
            kind: 'error',
            message:
              'Your session expired. Order details were not retried as a guest; sign in before continuing to payment.',
            publicOrderNumber: validPublicOrderNumber,
          });
          return;
        }
        setOrderSummary({
          kind: 'error',
          message: getOrderSummaryErrorMessage(error),
          publicOrderNumber: validPublicOrderNumber,
        });
      });

    return () => controller.abort();
  }, [
    authPhase,
    authenticatedAccessToken,
    authenticatedFailure,
    authenticatedSessionGeneration,
    hasOrderAccess,
    invalidateSessionIfCurrent,
    loadOrderSummary,
    orderAccessToken,
    summaryRequestVersion,
    validPublicOrderNumber,
  ]);

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
    if (feedback.kind === 'idle') {
      const focusIntent = checkoutReadyFocusIntentRef.current;
      checkoutReadyFocusIntentRef.current = null;
      if (focusIntent !== null && shouldRestoreAsyncFocus(focusIntent.origin)) {
        checkoutButtonRef.current?.focus();
      }
      return;
    }
    if (feedback.kind === 'pending') {
      return;
    }
    const focusIntent = feedbackFocusIntentRef.current;
    feedbackFocusIntentRef.current = null;
    if (focusIntent !== null && shouldRestoreAsyncFocus(focusIntent.origin)) {
      noticeRef.current?.focus();
    }
  }, [feedback]);

  useEffect(() => {
    if (orderSummary.kind === 'loaded') {
      const focusIntent = summaryFocusIntentRef.current;
      summaryFocusIntentRef.current = null;
      if (
        focusIntent?.restoreOnSuccess === true &&
        shouldRestoreAsyncFocus(focusIntent.origin)
      ) {
        summaryPanelRef.current?.focus();
      }
      return;
    }
    if (orderSummary.kind !== 'error') {
      return;
    }
    if (feedback.kind !== 'idle') {
      summaryFocusIntentRef.current = null;
      return;
    }
    const focusIntent = summaryFocusIntentRef.current;
    summaryFocusIntentRef.current = null;
    if (focusIntent !== null && shouldRestoreAsyncFocus(focusIntent.origin)) {
      summaryNoticeRef.current?.focus();
    }
  }, [feedback.kind, orderSummary]);

  if (validPublicOrderNumber === null) {
    return (
      <div className={styles.page}>
        <section className={styles.panel} aria-labelledby="checkout-unavailable-title">
          <CheckoutBrand />
          <p className={styles.eyebrow}>Order access</p>
          <h1 id="checkout-unavailable-title">Order access unavailable</h1>
          <p>
            This browser session does not have the guest access needed to continue with
            this order. For security, access credentials cannot be recovered from the
            URL.
          </p>
          <nav className={styles.links} aria-label="Recovery options">
            <Link to="/cart">Return to cart</Link>
            <Link to="/menu">Browse the menu</Link>
          </nav>
        </section>
      </div>
    );
  }

  if (authPhase === 'checking-session') {
    return (
      <div className={styles.page}>
        <section className={styles.panel} role="status" aria-live="polite">
          <CheckoutBrand />
          <p className={styles.eyebrow}>Order access</p>
          <h1>Checking your session</h1>
          <p>Checkout remains paused until your saved identity is validated.</p>
        </section>
      </div>
    );
  }

  if (authPhase === 'temporarily-unavailable') {
    return (
      <div className={styles.page}>
        <section className={styles.panel} role="alert" aria-live="assertive">
          <CheckoutBrand />
          <p className={styles.eyebrow}>Order access</p>
          <h1>Session validation unavailable</h1>
          <p>
            Checkout was not started as a guest because a saved identity is unresolved.
          </p>
          <div className={styles.actions}>
            <Button
              className={styles.secondaryAction}
              type="button"
              variant="secondary"
              onClick={() => void retrySession()}
            >
              Retry session validation
            </Button>
            <Button
              className={styles.secondaryAction}
              type="button"
              variant="secondary"
              onClick={logout}
            >
              Clear session
            </Button>
          </div>
        </section>
      </div>
    );
  }

  if (!hasOrderAccess && !authenticatedFailure) {
    return (
      <div className={styles.page}>
        <section className={styles.panel} aria-labelledby="checkout-unavailable-title">
          <CheckoutBrand />
          <p className={styles.eyebrow}>Order access</p>
          <h1 id="checkout-unavailable-title">Order access unavailable</h1>
          <p>
            This browser session does not have the guest access needed to continue with
            this order. For security, access credentials cannot be recovered from the
            URL.
          </p>
          <nav className={styles.links} aria-label="Recovery options">
            <Link to="/cart">Return to cart</Link>
            <Link to="/menu">Browse the menu</Link>
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
    authenticatedFailure ||
    rateLimitActive;

  const startCheckout = async (): Promise<void> => {
    if (pendingRef.current || checkoutDisabled) {
      return;
    }
    feedbackFocusIntentRef.current = { origin: getFocusOrigin() };
    const requestAttempt =
      attempt ?? resolveInitialAttempt(validPublicOrderNumber, hasOrderAccess);
    if (requestAttempt === null) {
      setFeedback({ kind: 'capability' });
      return;
    }
    if (attempt === null) {
      setAttempt(requestAttempt);
    }
    pendingRef.current = true;
    setFeedback({ kind: 'pending' });
    const controller = new AbortController();
    activeControllerRef.current = controller;
    const requestSession =
      authPhase === 'authenticated' ? getAuthenticatedSession() : null;
    if (authPhase === 'authenticated' && requestSession === null) {
      pendingRef.current = false;
      activeControllerRef.current = null;
      setAuthenticatedFailure(true);
      setFeedback({
        kind: 'retry',
        message: 'Your session changed before checkout started. Sign in and retry.',
      });
      return;
    }
    try {
      const response = await createCheckoutSession(validPublicOrderNumber, {
        accessToken: requestSession?.accessToken,
        guestAccessToken: orderAccessToken ?? undefined,
        idempotencyKey: requestAttempt.idempotencyKey,
        signal: controller.signal,
      });
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
        if (
          requestSession !== null &&
          error instanceof ApiRequestError &&
          error.kind === 'http' &&
          error.status === 401
        ) {
          invalidateSessionIfCurrent(requestSession);
          setAuthenticatedFailure(true);
          setFeedback({
            kind: 'retry',
            message:
              'Your session expired. Checkout was not retried as a guest; sign in and retry this same payment attempt.',
          });
        } else {
          setFeedback(mapCheckoutError(error));
        }
      }
    } finally {
      pendingRef.current = false;
      activeControllerRef.current = null;
    }
  };

  const startNewAttempt = (): void => {
    const focusOrigin = getFocusOrigin();
    const replacement = createCheckoutAttempt(validPublicOrderNumber);
    if (replacement === null) {
      feedbackFocusIntentRef.current = { origin: focusOrigin };
      setFeedback({ kind: 'capability' });
      return;
    }
    saveCheckoutAttempt(replacement);
    setAttempt(replacement);
    checkoutReadyFocusIntentRef.current = { origin: focusOrigin };
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

  const retryOrderSummary = (): void => {
    nextSummaryFocusOriginRef.current = getFocusOrigin();
    setOrderSummary({
      kind: 'loading',
      publicOrderNumber: validPublicOrderNumber,
    });
    setSummaryRequestVersion((current) => current + 1);
  };

  const summaryMatchesCurrentOrder =
    orderSummary.kind === 'loaded'
      ? orderSummary.order.public_order_number === validPublicOrderNumber
      : orderSummary.kind === 'error' || orderSummary.kind === 'loading'
        ? orderSummary.publicOrderNumber === validPublicOrderNumber
        : false;
  const summaryLoading =
    !summaryMatchesCurrentOrder ||
    orderSummary.kind === 'idle' ||
    orderSummary.kind === 'loading';

  return (
    <div className={styles.page}>
      <header className={styles.hero} aria-labelledby="order-created-title">
        <CheckoutBrand />
        <p className={styles.eyebrow}>Order received</p>
        <h1 id="order-created-title">Order created</h1>
        <p className={styles.paymentRequired}>Payment is still required.</p>
        <p className={styles.intro}>
          Review the details saved with your order, then continue to secure hosted
          payment in this tab.
        </p>
        <p className={styles.orderNumberLabel}>Public order number</p>
        <p className={styles.orderNumber}>{validPublicOrderNumber}</p>
      </header>

      <div className={styles.checkoutGrid}>
        <section
          className={styles.summaryPanel}
          ref={summaryPanelRef}
          tabIndex={-1}
          aria-busy={summaryLoading}
          aria-labelledby="order-summary-heading"
        >
          <p className={styles.eyebrow}>Saved order</p>
          <h2 id="order-summary-heading">Order summary</h2>

          {summaryLoading && (
            <Notice
              className={styles.inlineNotice}
              role="status"
              title="Loading order details"
            >
              Confirming the items and total saved with your order…
            </Notice>
          )}

          {orderSummary.kind === 'error' && summaryMatchesCurrentOrder && (
            <div className={styles.focusTarget} ref={summaryNoticeRef} tabIndex={-1}>
              <Notice
                className={styles.inlineNotice}
                role="alert"
                title="Order summary unavailable"
                variant="warning"
              >
                <p>{orderSummary.message}</p>
                {!authenticatedFailure && (
                  <Button
                    className={styles.inlineAction}
                    onClick={retryOrderSummary}
                    type="button"
                    variant="secondary"
                  >
                    Retry order summary
                  </Button>
                )}
              </Notice>
            </div>
          )}

          {orderSummary.kind === 'loaded' && summaryMatchesCurrentOrder && (
            <div className={styles.summaryContent}>
              <dl className={styles.orderMetadata}>
                <div>
                  <dt>Order type</dt>
                  <dd>
                    {orderSummary.order.order_type === 'dine_in'
                      ? 'Dine-in'
                      : 'Takeaway'}
                  </dd>
                </div>
                {orderSummary.order.table_number !== null && (
                  <div>
                    <dt>Table number</dt>
                    <dd>{orderSummary.order.table_number}</dd>
                  </div>
                )}
              </dl>

              <ul className={styles.itemList} aria-label="Order items">
                {orderSummary.order.items.map((item) => (
                  <li key={item.menu_item_id}>
                    <span className={styles.itemDetails}>
                      <strong>{item.name}</strong>
                      <small>Qty {item.quantity}</small>
                    </span>
                    <span className={styles.amount}>
                      {formatCustomerMoney(
                        item.line_total_amount,
                        orderSummary.order.currency,
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              <dl className={styles.totals}>
                <div>
                  <dt>Subtotal</dt>
                  <dd>
                    {formatCustomerMoney(
                      orderSummary.order.subtotal_amount,
                      orderSummary.order.currency,
                    )}
                  </dd>
                </div>
                <div className={styles.totalRow}>
                  <dt>Total</dt>
                  <dd>
                    {formatCustomerMoney(
                      orderSummary.order.total_amount,
                      orderSummary.order.currency,
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </section>

        <section className={styles.paymentPanel} aria-labelledby="payment-heading">
          <p className={styles.eyebrow}>Secure checkout</p>
          <h2 id="payment-heading">Continue to payment</h2>
          <p>
            We will open the hosted payment page in this tab. Your order is not paid
            until payment is confirmed.
          </p>

          <div className={styles.actions}>
            <Button
              className={styles.primaryAction}
              disabled={checkoutDisabled}
              loading={feedback.kind === 'pending'}
              loadingLabel="Continue to secure payment"
              onClick={() => void startCheckout()}
              ref={checkoutButtonRef}
              size="lg"
              type="button"
            >
              Continue to secure payment
            </Button>
          </div>

          {feedback.kind === 'pending' && (
            <Notice
              className={styles.inlineNotice}
              role="status"
              title="Preparing payment"
            >
              Creating secure checkout…
            </Notice>
          )}
          {feedback.kind === 'retry' && (
            <div className={styles.focusTarget} ref={noticeRef} tabIndex={-1}>
              <Notice
                className={styles.inlineNotice}
                role="alert"
                title="Checkout could not continue"
                variant="danger"
              >
                {feedback.message}
              </Notice>
            </div>
          )}
          {feedback.kind === 'rate-limit' && (
            <div className={styles.focusTarget} ref={noticeRef} tabIndex={-1}>
              <Notice
                className={styles.inlineNotice}
                role="status"
                title={
                  feedback.retryAt !== null && !rateLimitActive
                    ? 'Payment retry ready'
                    : 'Please wait before retrying'
                }
                variant="warning"
              >
                {feedback.retryAt === null ? (
                  'Too many checkout requests were made. Retry explicitly when you are ready; the same payment attempt will be reused.'
                ) : rateLimitActive ? (
                  <>
                    <span aria-hidden="true">
                      Please wait {retrySeconds} second
                      {retrySeconds === 1 ? '' : 's'} before retrying this same payment
                      attempt.
                    </span>
                    <span className={styles.visuallyHidden}>
                      Payment retry is temporarily unavailable. The same payment attempt
                      will be reused.
                    </span>
                  </>
                ) : (
                  'You can now retry this same payment attempt.'
                )}
              </Notice>
            </div>
          )}
          {feedback.kind === 'definitive' && (
            <div className={styles.focusTarget} ref={noticeRef} tabIndex={-1}>
              <Notice
                className={styles.inlineNotice}
                role="alert"
                title="Payment provider unavailable"
                variant="danger"
              >
                <p>The payment provider could not create checkout for this attempt.</p>
                <Button
                  className={styles.inlineAction}
                  onClick={startNewAttempt}
                  type="button"
                  variant="secondary"
                >
                  Start a new payment attempt
                </Button>
              </Notice>
            </div>
          )}
          {feedback.kind === 'redirect-failed' && (
            <div className={styles.focusTarget} ref={noticeRef} tabIndex={-1}>
              <Notice
                className={styles.inlineNotice}
                role="alert"
                title="Payment page did not open"
                variant="warning"
              >
                <p>Secure checkout was created, but this browser could not open it.</p>
                <Button
                  className={styles.inlineAction}
                  onClick={retryRedirect}
                  type="button"
                  variant="secondary"
                >
                  Try payment redirect again
                </Button>
              </Notice>
            </div>
          )}
          {feedback.kind === 'capability' && (
            <div className={styles.focusTarget} ref={noticeRef} tabIndex={-1}>
              <Notice
                className={styles.inlineNotice}
                role="alert"
                title="Secure checkout unavailable"
                variant="danger"
              >
                This browser cannot securely create a payment attempt. Update the
                browser or try another supported browser.
              </Notice>
            </div>
          )}

          <nav className={styles.links} aria-label="Order navigation">
            <Link className={styles.backLink} to="/cart">
              Return to cart
            </Link>
            <Link className={styles.menuLink} to="/menu">
              Browse the menu
            </Link>
          </nav>
        </section>
      </div>
    </div>
  );
}

/** Start or safely replay the hosted checkout flow for one customer order. */
export default function CheckoutPage(props: CheckoutPageProps) {
  const { publicOrderNumber } = useParams();

  return (
    <CheckoutPageForOrder
      {...props}
      key={publicOrderNumber ?? 'missing-order'}
      publicOrderNumber={publicOrderNumber}
    />
  );
}
