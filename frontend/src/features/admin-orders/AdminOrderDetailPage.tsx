import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Link, useParams } from 'react-router-dom';

import { AdminApiRequestError } from '../../api/adminApi';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import StatusBadge, { type StatusBadgeVariant } from '../../components/ui/StatusBadge';
import { useAuth } from '../auth/AuthContext';
import {
  type AdminOrderDetail,
  fetchAdminOrderDetail,
  formatAdminDate,
  formatAdminMoney,
  getOrderStatusLabel,
  getOrderTypeLabel,
  getPaymentStatusLabel,
  type OrderStatus,
  type PaymentStatus,
  updateAdminOrderStatus,
} from './adminOrdersApi';
import styles from './AdminOrderDetailPage.module.css';

type DetailPhase = 'error' | 'loading' | 'not-found' | 'ready';
type DetailLoadReason = 'conflict' | 'initial' | 'manual' | 'post-mutation' | 'retry';
type MutationNoticeKind = 'error' | 'success' | 'warning';

interface MutationNotice {
  kind: MutationNoticeKind;
  message: string;
}

interface StatusAction {
  confirmation: string;
  destructive?: boolean;
  label: string;
  targetStatus: OrderStatus;
}

interface ActionAvailability {
  actions: readonly StatusAction[];
  guidance: string | null;
}

function shouldRestoreAsyncFocus(origin: HTMLElement | null): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement === null ||
    activeElement === document.body ||
    (origin !== null && activeElement === origin) ||
    !activeElement.isConnected
  );
}

const ACCEPT_ACTION: StatusAction = {
  confirmation: 'Accept this order?',
  label: 'Accept order',
  targetStatus: 'accepted',
};

const CANCEL_ACTION: StatusAction = {
  confirmation:
    'Cancel this order? This action cannot be undone in the current workflow.',
  destructive: true,
  label: 'Cancel order',
  targetStatus: 'cancelled',
};

const STATUS_ACTIONS: Record<OrderStatus, readonly StatusAction[]> = {
  accepted: [
    {
      confirmation: 'Start preparing this order?',
      label: 'Start preparing',
      targetStatus: 'preparing',
    },
  ],
  cancelled: [],
  completed: [],
  created: [ACCEPT_ACTION, CANCEL_ACTION],
  preparing: [
    {
      confirmation: 'Mark this order as ready?',
      label: 'Mark ready',
      targetStatus: 'ready',
    },
  ],
  ready: [
    {
      confirmation: 'Complete this order?',
      label: 'Complete order',
      targetStatus: 'completed',
    },
  ],
};

function orderStatusVariant(status: OrderStatus): StatusBadgeVariant {
  return {
    accepted: 'info',
    cancelled: 'danger',
    completed: 'success',
    created: 'neutral',
    preparing: 'warning',
    ready: 'info',
  }[status] as StatusBadgeVariant;
}

function paymentStatusVariant(status: PaymentStatus): StatusBadgeVariant {
  return {
    expired: 'neutral',
    failed: 'danger',
    pending: 'warning',
    succeeded: 'success',
  }[status] as StatusBadgeVariant;
}

function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <StatusBadge
      className={status === 'ready' ? styles.readyStatus : undefined}
      variant={orderStatusVariant(status)}
    >
      {getOrderStatusLabel(status)}
    </StatusBadge>
  );
}

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return (
    <StatusBadge variant={paymentStatusVariant(status)}>
      {getPaymentStatusLabel(status)}
    </StatusBadge>
  );
}

function getActionAvailability(order: AdminOrderDetail): ActionAvailability {
  if (order.status !== 'created') {
    return { actions: STATUS_ACTIONS[order.status], guidance: null };
  }

  const hasSucceededPayment = order.payments.some(
    (payment) => payment.status === 'succeeded',
  );
  const hasPendingPayment = order.payments.some(
    (payment) => payment.status === 'pending',
  );

  if (hasSucceededPayment) {
    return {
      actions: [ACCEPT_ACTION],
      guidance:
        'Cancellation is unavailable because a succeeded payment attempt is recorded and refunds are outside this workflow.',
    };
  }
  if (hasPendingPayment) {
    return {
      actions: [],
      guidance:
        'A pending payment attempt blocks acceptance and cancellation until the recorded payment status changes.',
    };
  }
  return {
    actions: [CANCEL_ACTION],
    guidance:
      'Acceptance is unavailable because no succeeded payment attempt is recorded.',
  };
}

function getDetailErrorMessage(error: unknown): string {
  if (!(error instanceof AdminApiRequestError)) {
    return 'The order could not be loaded. Check your connection and try again.';
  }
  if (error.kind === 'timeout' || error.kind === 'network') {
    return 'The orders service could not be reached. Check your connection and try again.';
  }
  if (error.kind === 'invalid-response') {
    return 'The orders service returned an unexpected response. Try again later.';
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return 'The orders service is temporarily unavailable. Try again later.';
  }
  return 'The order could not be loaded. Try again.';
}

function OrderSummary({
  headingRef,
  highlight,
  order,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>;
  highlight: boolean;
  order: AdminOrderDetail;
}) {
  const latestPayment = order.payments[order.payments.length - 1] ?? null;

  return (
    <section
      className={`${styles.panel} ${styles.summaryPanel} ${
        highlight ? styles.summaryUpdated : ''
      }`}
      aria-labelledby="order-summary-heading"
    >
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.sectionEyebrow}>Current operational truth</p>
          <h2 ref={headingRef} id="order-summary-heading" tabIndex={-1}>
            Order summary
          </h2>
        </div>
        <OrderStatusBadge status={order.status} />
      </div>
      <dl className={styles.summaryGrid}>
        <div>
          <dt>Order type</dt>
          <dd>{getOrderTypeLabel(order.orderType)}</dd>
        </div>
        <div>
          <dt>Table</dt>
          <dd>{order.tableNumber ?? 'Not applicable'}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd className={styles.money}>
            {formatAdminMoney(order.totalAmount, order.currency)}
          </dd>
        </div>
        <div>
          <dt>Payment attempts</dt>
          <dd>{order.payments.length}</dd>
        </div>
        <div>
          <dt>Latest payment attempt</dt>
          <dd>
            {latestPayment === null ? (
              'No payment attempts'
            ) : (
              <PaymentStatusBadge status={latestPayment.status} />
            )}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time dateTime={order.createdAt}>{formatAdminDate(order.createdAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>
            <time dateTime={order.updatedAt}>{formatAdminDate(order.updatedAt)}</time>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function OrderItems({ order }: { order: AdminOrderDetail }) {
  return (
    <section
      className={`${styles.panel} ${styles.itemsPanel}`}
      aria-labelledby="order-items-heading"
    >
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.sectionEyebrow}>Immutable order snapshots</p>
          <h2 id="order-items-heading">Order items</h2>
        </div>
        <span className={styles.itemCount}>
          {order.items.length} {order.items.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      {order.items.length === 0 ? (
        <p>No order items.</p>
      ) : (
        <ul className={styles.itemList}>
          {order.items.map((item) => (
            <li className={styles.itemCard} key={item.id}>
              <div className={styles.itemIdentity}>
                <p className={styles.itemCategory}>{item.categoryName}</p>
                <h3>{item.name}</h3>
              </div>
              <dl className={styles.itemDetails}>
                <div>
                  <dt>Quantity</dt>
                  <dd>{item.quantity}</dd>
                </div>
                <div>
                  <dt>Unit price</dt>
                  <dd className={styles.money}>
                    {formatAdminMoney(item.unitPriceAmount, order.currency)}
                  </dd>
                </div>
                <div>
                  <dt>Line total</dt>
                  <dd className={styles.money}>
                    {formatAdminMoney(item.lineTotalAmount, order.currency)}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <dl className={styles.totals}>
        <div>
          <dt>Subtotal</dt>
          <dd className={styles.money}>
            {formatAdminMoney(order.subtotalAmount, order.currency)}
          </dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd className={styles.money}>
            {formatAdminMoney(order.totalAmount, order.currency)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function PaymentAttempts({ order }: { order: AdminOrderDetail }) {
  return (
    <section
      className={`${styles.panel} ${styles.paymentsPanel}`}
      aria-labelledby="payments-heading"
    >
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.sectionEyebrow}>Separate financial lifecycle</p>
          <h2 id="payments-heading">Payment attempts</h2>
        </div>
      </div>
      <p className={styles.sectionIntro}>
        Payment-attempt status is separate from the order fulfilment status.
      </p>
      {order.payments.length === 0 ? (
        <p>No payment records.</p>
      ) : (
        <ol className={styles.paymentList}>
          {order.payments.map((payment, index) => (
            <li key={payment.id}>
              <div className={styles.paymentHeader}>
                <h3>Payment attempt {index + 1}</h3>
                <PaymentStatusBadge status={payment.status} />
              </div>
              <dl className={styles.paymentDetails}>
                <div>
                  <dt>Amount</dt>
                  <dd className={styles.money}>
                    {formatAdminMoney(payment.amount, payment.currency)}
                  </dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={payment.createdAt}>
                      {formatAdminDate(payment.createdAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>
                    <time dateTime={payment.updatedAt}>
                      {formatAdminDate(payment.updatedAt)}
                    </time>
                  </dd>
                </div>
                {payment.checkoutExpiresAt !== null ? (
                  <div>
                    <dt>Recorded checkout expiry</dt>
                    <dd>
                      <time dateTime={payment.checkoutExpiresAt}>
                        {formatAdminDate(payment.checkoutExpiresAt)}
                      </time>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </li>
          ))}
        </ol>
      )}
      <p className={styles.contractNote}>
        Provider reconciliation state is not exposed by this order-detail contract.
      </p>
    </section>
  );
}

function StatusHistory({ order }: { order: AdminOrderDetail }) {
  return (
    <section
      className={`${styles.panel} ${styles.historyPanel}`}
      aria-labelledby="status-history-heading"
    >
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.sectionEyebrow}>Authoritative audit sequence</p>
          <h2 id="status-history-heading">Status history</h2>
        </div>
      </div>
      {order.statusHistory.length === 0 ? (
        <p>No status history.</p>
      ) : (
        <ol className={styles.timeline}>
          {order.statusHistory.map((entry) => (
            <li key={entry.sequence}>
              <div className={styles.historyTransition}>
                <span>
                  {entry.previousStatus === null
                    ? 'Initial status'
                    : `${getOrderStatusLabel(entry.previousStatus)} to`}
                </span>
                <OrderStatusBadge status={entry.newStatus} />
              </div>
              <time dateTime={entry.changedAt}>{formatAdminDate(entry.changedAt)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function AdminOrderDetailPage() {
  const { publicOrderNumber } = useParams<{ publicOrderNumber: string }>();
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    refreshCurrentUser,
  } = useAuth();
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [detailPhase, setDetailPhase] = useState<DetailPhase>('loading');
  const [isDetailLoading, setIsDetailLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<StatusAction | null>(null);
  const [mutationInFlight, setMutationInFlight] = useState(false);
  const [mutationNotice, setMutationNotice] = useState<MutationNotice | null>(null);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const asyncFocusOriginRef = useRef<HTMLButtonElement | null>(null);
  const detailRef = useRef<AdminOrderDetail | null>(null);
  const refreshGateRef = useRef(false);
  const activeDetailControllerRef = useRef<AbortController | null>(null);
  const detailGenerationRef = useRef(0);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const mutationInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const actionsHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const initiatingActionRef = useRef<HTMLButtonElement | null>(null);
  const refreshButtonRef = useRef<HTMLButtonElement | null>(null);
  const stateHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const summaryHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const restoreAsyncFocus = useCallback(
    (getTarget: () => HTMLElement | null, allowWithoutOrigin = false) => {
      const origin = asyncFocusOriginRef.current;
      if (origin === null && !allowWithoutOrigin) return;
      asyncFocusOriginRef.current = null;
      const focusWhenReady = (remainingAttempts: number): void => {
        if (!shouldRestoreAsyncFocus(origin)) return;
        const target = getTarget();
        if (target !== null && target.isConnected) {
          target.focus();
          return;
        }
        if (remainingAttempts > 0) {
          window.setTimeout(() => focusWhenReady(remainingAttempts - 1), 0);
        }
      };
      window.setTimeout(() => focusWhenReady(1), 0);
    },
    [],
  );

  const storeDetail = useCallback((nextDetail: AdminOrderDetail | null) => {
    detailRef.current = nextDetail;
    setDetail(nextDetail);
  }, []);

  const setRefreshGate = useCallback((required: boolean) => {
    refreshGateRef.current = required;
    setRequiresRefresh(required);
  }, []);

  const loadOrder = useCallback(
    async (reason: DetailLoadReason = 'manual') => {
      const authSession = getAuthenticatedSession();
      if (authSession === null) {
        logout();
        return;
      }
      const accessToken = authSession.accessToken;
      if (publicOrderNumber === undefined) {
        setIsDetailLoading(false);
        setDetailPhase('not-found');
        return;
      }

      const gateWasRequired = refreshGateRef.current;
      detailGenerationRef.current += 1;
      const generation = detailGenerationRef.current;
      activeDetailControllerRef.current?.abort();
      const controller = new AbortController();
      activeDetailControllerRef.current = controller;
      setIsDetailLoading(true);
      setLoadError(null);
      setPendingAction(null);
      if (reason !== 'post-mutation' && reason !== 'conflict') {
        setMutationNotice(null);
      }
      if (detailRef.current === null) {
        setDetailPhase('loading');
      }

      try {
        const data = await fetchAdminOrderDetail(
          accessToken,
          publicOrderNumber,
          controller.signal,
        );
        if (generation !== detailGenerationRef.current) {
          return;
        }

        activeDetailControllerRef.current = null;
        storeDetail(data);
        setDetailPhase('ready');
        setRefreshGate(false);
        setPendingAction(null);
        if (reason === 'post-mutation') {
          setMutationNotice({
            kind: 'success',
            message: 'Order status updated.',
          });
        } else if (reason === 'conflict') {
          setMutationNotice({
            kind: 'warning',
            message:
              'The order changed or this action is not currently allowed. The latest order details have been loaded.',
          });
        } else {
          setMutationNotice(null);
        }
        if (reason === 'retry') {
          restoreAsyncFocus(() => summaryHeadingRef.current);
        } else if (
          reason === 'post-mutation' ||
          reason === 'conflict' ||
          (reason === 'manual' && gateWasRequired)
        ) {
          restoreAsyncFocus(() => actionsHeadingRef.current);
        } else if (reason === 'manual') {
          restoreAsyncFocus(() => refreshButtonRef.current);
        }
      } catch (error: unknown) {
        if (generation !== detailGenerationRef.current) {
          return;
        }
        activeDetailControllerRef.current = null;
        if (error instanceof AdminApiRequestError && error.kind === 'aborted') {
          return;
        }
        if (error instanceof AdminApiRequestError && error.status === 401) {
          invalidateSessionIfCurrent(authSession);
          return;
        }
        if (error instanceof AdminApiRequestError && error.status === 403) {
          await refreshCurrentUser();
        }
        if (error instanceof AdminApiRequestError && error.status === 404) {
          storeDetail(null);
          setDetailPhase('not-found');
          setPendingAction(null);
          setRefreshGate(true);
          restoreAsyncFocus(() => stateHeadingRef.current, reason === 'initial');
          return;
        }

        const message = getDetailErrorMessage(error);
        if (detailRef.current === null) {
          setDetailPhase('error');
          setLoadError(message);
        } else {
          setDetailPhase('ready');
        }

        if (reason === 'post-mutation') {
          setRefreshGate(true);
          setMutationNotice({
            kind: 'warning',
            message:
              'The status update was accepted by the server, but the latest order details could not be refreshed. Refresh the order before trying another action.',
          });
        } else if (reason === 'conflict') {
          setRefreshGate(true);
          setMutationNotice({
            kind: 'warning',
            message:
              'The order changed or this action is not currently allowed, and the latest details could not be refreshed. Refresh the order before trying another action.',
          });
        } else if (gateWasRequired) {
          setRefreshGate(true);
          setMutationNotice({
            kind: 'warning',
            message:
              'The latest order details could not be refreshed. Refresh the order before trying another status action.',
          });
        } else {
          setLoadError(message);
        }
        if (
          reason === 'post-mutation' ||
          reason === 'conflict' ||
          (reason === 'manual' && gateWasRequired)
        ) {
          restoreAsyncFocus(() => actionsHeadingRef.current);
        } else if (reason === 'retry') {
          restoreAsyncFocus(() => stateHeadingRef.current);
        } else if (reason === 'manual') {
          restoreAsyncFocus(() => refreshButtonRef.current);
        }
      } finally {
        if (generation === detailGenerationRef.current && mountedRef.current) {
          setIsDetailLoading(false);
        }
      }
    },
    [
      getAuthenticatedSession,
      invalidateSessionIfCurrent,
      logout,
      publicOrderNumber,
      refreshCurrentUser,
      restoreAsyncFocus,
      setRefreshGate,
      storeDetail,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;
    const requestStartId = window.setTimeout(() => void loadOrder('initial'), 0);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(requestStartId);
      detailGenerationRef.current += 1;
      activeDetailControllerRef.current?.abort();
      activeDetailControllerRef.current = null;
      mutationControllerRef.current?.abort();
      mutationControllerRef.current = null;
      mutationInFlightRef.current = false;
      asyncFocusOriginRef.current = null;
    };
  }, [loadOrder]);

  useEffect(() => {
    if (pendingAction !== null) {
      confirmationHeadingRef.current?.focus();
    }
  }, [pendingAction]);

  const handleActionSelection = (
    action: StatusAction,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (
      mutationInFlightRef.current ||
      refreshGateRef.current ||
      activeDetailControllerRef.current !== null
    ) {
      return;
    }
    initiatingActionRef.current = event.currentTarget;
    setPendingAction(action);
    setMutationNotice(null);
  };

  const closeConfirmation = () => {
    setPendingAction(null);
    window.setTimeout(() => initiatingActionRef.current?.focus(), 0);
  };

  const confirmMutation = useCallback(async () => {
    if (
      pendingAction === null ||
      mutationInFlightRef.current ||
      refreshGateRef.current ||
      activeDetailControllerRef.current !== null
    ) {
      return;
    }

    const authSession = getAuthenticatedSession();
    if (authSession === null) {
      logout();
      return;
    }
    const accessToken = authSession.accessToken;
    if (publicOrderNumber === undefined) {
      storeDetail(null);
      setDetailPhase('not-found');
      return;
    }

    const action = pendingAction;
    mutationInFlightRef.current = true;
    setMutationInFlight(true);
    setMutationNotice(null);
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    const finishMutationRequest = () => {
      mutationControllerRef.current = null;
      mutationInFlightRef.current = false;
      if (mountedRef.current) {
        setMutationInFlight(false);
      }
    };

    try {
      await updateAdminOrderStatus(
        accessToken,
        publicOrderNumber,
        action.targetStatus,
        controller.signal,
      );
      if (!mountedRef.current) {
        return;
      }

      finishMutationRequest();
      setPendingAction(null);
      setRefreshGate(true);
      setMutationNotice({
        kind: 'warning',
        message: 'The status update was accepted. Refreshing order details…',
      });
      await loadOrder('post-mutation');
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return;
      }
      finishMutationRequest();
      if (error instanceof AdminApiRequestError && error.status === 401) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 403) {
        await refreshCurrentUser();
      }
      if (error instanceof AdminApiRequestError && error.status === 404) {
        setPendingAction(null);
        storeDetail(null);
        setDetailPhase('not-found');
        setRefreshGate(true);
        restoreAsyncFocus(() => stateHeadingRef.current);
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 409) {
        setPendingAction(null);
        setRefreshGate(true);
        setMutationNotice({
          kind: 'warning',
          message:
            'The order changed or this action is not currently allowed. Refreshing the latest order details…',
        });
        await loadOrder('conflict');
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 422) {
        setPendingAction(null);
        setMutationNotice({
          kind: 'error',
          message:
            'The status update request was not valid. Refresh the order and review its current state.',
        });
        restoreAsyncFocus(() => actionsHeadingRef.current);
        return;
      }

      setPendingAction(null);
      setRefreshGate(true);
      setMutationNotice({
        kind: 'warning',
        message:
          'We could not confirm whether the status update was applied. Refresh the order before trying another action.',
      });
      restoreAsyncFocus(() => actionsHeadingRef.current);
    } finally {
      finishMutationRequest();
    }
  }, [
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    loadOrder,
    logout,
    pendingAction,
    publicOrderNumber,
    refreshCurrentUser,
    restoreAsyncFocus,
    setRefreshGate,
    storeDetail,
  ]);

  const actionAvailability =
    detail === null ? { actions: [], guidance: null } : getActionAvailability(detail);
  const actions = actionAvailability.actions;
  const mutationControlsDisabled =
    mutationInFlight || requiresRefresh || isDetailLoading;
  const standardActions = actions.filter((action) => !action.destructive);
  const destructiveActions = actions.filter((action) => action.destructive);
  const mutationNoticeVariant =
    mutationNotice?.kind === 'success'
      ? 'success'
      : mutationNotice?.kind === 'error'
        ? 'danger'
        : 'warning';

  return (
    <article className={styles.page} aria-busy={isDetailLoading || mutationInFlight}>
      <header className={styles.pageHeader}>
        <div>
          <Link className={styles.backLink} to="/admin/orders">
            Back to Orders
          </Link>
          <p className="eyebrow">Order operations</p>
          <h1>Order {publicOrderNumber ?? 'not found'}</h1>
          {detail === null ? null : (
            <p className={styles.headerContext}>
              Created{' '}
              <time dateTime={detail.createdAt}>
                {formatAdminDate(detail.createdAt)}
              </time>
              {' / '}
              {getOrderTypeLabel(detail.orderType)}
            </p>
          )}
        </div>
        <Button
          ref={refreshButtonRef}
          disabled={mutationInFlight}
          loading={isDetailLoading}
          loadingLabel="Refreshing order"
          size="md"
          type="button"
          variant="secondary"
          onClick={(event) => {
            asyncFocusOriginRef.current = event.currentTarget;
            void loadOrder('manual');
          }}
        >
          Refresh
        </Button>
      </header>

      {detail === null && detailPhase === 'loading' ? (
        <Notice className={styles.statePanel} role="status" variant="info">
          <h2>Loading order</h2>
          <p>The latest order detail is being requested.</p>
        </Notice>
      ) : null}

      {detailPhase === 'not-found' ? (
        <Notice className={styles.statePanel} role="alert" variant="danger">
          <h2 ref={stateHeadingRef} tabIndex={-1}>
            Order not found
          </h2>
          <p>No order is available for this public order number.</p>
        </Notice>
      ) : null}

      {detail === null && detailPhase === 'error' ? (
        <Notice className={styles.statePanel} role="alert" variant="danger">
          <h2 ref={stateHeadingRef} tabIndex={-1}>
            Unable to load order
          </h2>
          <p>{loadError}</p>
          <Button
            size="md"
            type="button"
            variant="secondary"
            onClick={(event) => {
              asyncFocusOriginRef.current = event.currentTarget;
              void loadOrder('retry');
            }}
          >
            Retry order
          </Button>
        </Notice>
      ) : null}

      {detail !== null && loadError !== null ? (
        <Notice className={styles.statePanel} role="alert" variant="danger">
          <h2>Unable to refresh order</h2>
          <p>{loadError}</p>
        </Notice>
      ) : null}

      {detail !== null && isDetailLoading ? (
        <Notice
          className={styles.refreshingStatus}
          role="status"
          title="Refreshing order details"
          variant="info"
        >
          Existing information remains visible while the same authoritative order is
          requested.
        </Notice>
      ) : null}

      {detail !== null ? (
        <>
          <OrderSummary
            headingRef={summaryHeadingRef}
            highlight={mutationNotice?.kind === 'success'}
            order={detail}
          />
          <div
            className={`${styles.detailContent} ${
              requiresRefresh ? styles.detailContentStale : ''
            }`}
          >
            <OrderItems order={detail} />
            <PaymentAttempts order={detail} />
            <section
              className={styles.actionPanel}
              aria-busy={mutationInFlight}
              aria-labelledby="order-actions-heading"
            >
              <div className={styles.sectionHeader}>
                <div>
                  <p className={styles.sectionEyebrow}>
                    Backend-authoritative workflow
                  </p>
                  <h2 id="order-actions-heading" ref={actionsHeadingRef} tabIndex={-1}>
                    Order actions
                  </h2>
                </div>
              </div>

              {mutationNotice !== null ? (
                <Notice
                  role={mutationNotice.kind === 'success' ? 'status' : 'alert'}
                  variant={mutationNoticeVariant}
                >
                  {mutationNotice.message}
                </Notice>
              ) : null}

              {mutationInFlight ? (
                <p className={styles.updatingStatus} role="status" aria-live="polite">
                  Updating order status…
                </p>
              ) : null}

              {requiresRefresh ? (
                <div id="status-actions-gate">
                  <Notice role="status" title="Refresh required" variant="warning">
                    Status actions are disabled until the latest order details are
                    refreshed.
                  </Notice>
                </div>
              ) : null}

              {actionAvailability.guidance === null ? null : (
                <p className={styles.actionGuidance}>
                  <strong>Action availability</strong>
                  <span>{actionAvailability.guidance}</span>
                </p>
              )}

              {actions.length === 0 ? (
                <p>
                  {actionAvailability.guidance === null
                    ? 'No further status actions are available.'
                    : 'No status action is currently available.'}
                </p>
              ) : null}

              {standardActions.length === 0 ? null : (
                <div className={styles.actionButtons}>
                  {standardActions.map((action) => (
                    <Button
                      aria-describedby={
                        requiresRefresh ? 'status-actions-gate' : undefined
                      }
                      disabled={mutationControlsDisabled}
                      key={action.targetStatus}
                      size="md"
                      type="button"
                      variant="primary"
                      onClick={(event) => handleActionSelection(action, event)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
              )}

              {destructiveActions.length === 0 ? null : (
                <div className={styles.dangerZone}>
                  <div>
                    <strong>Destructive action</strong>
                    <p>Cancellation cannot be reversed in the current workflow.</p>
                  </div>
                  <div className={styles.actionButtons}>
                    {destructiveActions.map((action) => (
                      <Button
                        aria-describedby={
                          requiresRefresh ? 'status-actions-gate' : undefined
                        }
                        disabled={mutationControlsDisabled}
                        key={action.targetStatus}
                        size="md"
                        type="button"
                        variant="danger"
                        onClick={(event) => handleActionSelection(action, event)}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {pendingAction !== null ? (
                <div
                  className={styles.confirmationPanel}
                  data-destructive={pendingAction.destructive || undefined}
                  role="group"
                  aria-labelledby="status-confirmation-heading"
                >
                  <p className={styles.confirmationEyebrow}>
                    {pendingAction.destructive
                      ? 'Confirm destructive action'
                      : 'Confirm status transition'}
                  </p>
                  <h3
                    id="status-confirmation-heading"
                    ref={confirmationHeadingRef}
                    tabIndex={-1}
                  >
                    {pendingAction.confirmation}
                  </h3>
                  <p>
                    Order <strong>{detail.publicOrderNumber}</strong> will move to{' '}
                    <strong>{getOrderStatusLabel(pendingAction.targetStatus)}</strong>.
                  </p>
                  <div className={styles.confirmationActions}>
                    <Button
                      disabled={mutationInFlight}
                      loading={mutationInFlight}
                      loadingLabel={`Updating order to ${getOrderStatusLabel(
                        pendingAction.targetStatus,
                      )}`}
                      size="md"
                      type="button"
                      variant={pendingAction.destructive ? 'danger' : 'primary'}
                      onClick={(event) => {
                        asyncFocusOriginRef.current = event.currentTarget;
                        void confirmMutation();
                      }}
                    >
                      Confirm {pendingAction.label}
                    </Button>
                    <Button
                      disabled={mutationInFlight}
                      size="md"
                      type="button"
                      variant="secondary"
                      onClick={closeConfirmation}
                    >
                      Keep current status
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>

            <StatusHistory order={detail} />
          </div>
        </>
      ) : null}
    </article>
  );
}
