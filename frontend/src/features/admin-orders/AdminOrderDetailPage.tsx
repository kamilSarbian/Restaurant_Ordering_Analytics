import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Link, useParams } from 'react-router-dom';

import { AdminApiRequestError } from '../../api/adminApi';
import { useAdminAuth } from '../admin-auth/AdminAuthContext';
import {
  type AdminOrderDetail,
  fetchAdminOrderDetail,
  formatAdminDate,
  formatAdminMoney,
  getOrderStatusLabel,
  getOrderTypeLabel,
  getPaymentStatusLabel,
  type OrderStatus,
  updateAdminOrderStatus,
} from './adminOrdersApi';
import styles from './AdminOrderDetailPage.module.css';

type DetailPhase = 'error' | 'loading' | 'not-found' | 'ready';
type DetailLoadReason = 'conflict' | 'initial' | 'manual' | 'post-mutation';
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
  created: [
    {
      confirmation: 'Accept this order?',
      label: 'Accept order',
      targetStatus: 'accepted',
    },
    {
      confirmation:
        'Cancel this order? This action cannot be undone in the current workflow.',
      destructive: true,
      label: 'Cancel order',
      targetStatus: 'cancelled',
    },
  ],
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

function OrderDetail({ order }: { order: AdminOrderDetail }) {
  return (
    <>
      <section className={styles.panel} aria-labelledby="order-summary-heading">
        <h2 id="order-summary-heading">Order summary</h2>
        <dl className={styles.summaryGrid}>
          <div>
            <dt>Status</dt>
            <dd>
              <span className={styles.status} data-status={order.status}>
                {getOrderStatusLabel(order.status)}
              </span>
            </dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{getOrderTypeLabel(order.orderType)}</dd>
          </div>
          <div>
            <dt>Table</dt>
            <dd>{order.tableNumber ?? 'Not applicable'}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              <time dateTime={order.createdAt}>{formatAdminDate(order.createdAt)}</time>
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>
              <time dateTime={order.updatedAt}>{formatAdminDate(order.updatedAt)}</time>
            </dd>
          </div>
        </dl>
      </section>

      <section className={styles.panel} aria-labelledby="order-items-heading">
        <h2 id="order-items-heading">Order items</h2>
        {order.items.length === 0 ? (
          <p>No order items.</p>
        ) : (
          <ul className={styles.itemList}>
            {order.items.map((item) => (
              <li className={styles.itemCard} key={item.position}>
                <div>
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
                    <dd>{formatAdminMoney(item.unitPriceAmount, order.currency)}</dd>
                  </div>
                  <div>
                    <dt>Line total</dt>
                    <dd>{formatAdminMoney(item.lineTotalAmount, order.currency)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
        <dl className={styles.totals}>
          <div>
            <dt>Subtotal</dt>
            <dd>{formatAdminMoney(order.subtotalAmount, order.currency)}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{formatAdminMoney(order.totalAmount, order.currency)}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.panel} aria-labelledby="status-history-heading">
        <h2 id="status-history-heading">Status history</h2>
        {order.statusHistory.length === 0 ? (
          <p>No status history.</p>
        ) : (
          <ol className={styles.timeline}>
            {order.statusHistory.map((entry) => (
              <li key={entry.sequence}>
                <strong>{getOrderStatusLabel(entry.newStatus)}</strong>
                <time dateTime={entry.changedAt}>
                  {formatAdminDate(entry.changedAt)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="payments-heading">
        <h2 id="payments-heading">Payments</h2>
        {order.payments.length === 0 ? (
          <p>No payment records.</p>
        ) : (
          <ul className={styles.paymentList}>
            {order.payments.map((payment, index) => (
              <li key={`${payment.createdAt}-${index}`}>
                <h3>Payment attempt {index + 1}</h3>
                <dl className={styles.paymentDetails}>
                  <div>
                    <dt>Status</dt>
                    <dd>{getPaymentStatusLabel(payment.status)}</dd>
                  </div>
                  <div>
                    <dt>Amount</dt>
                    <dd>{formatAdminMoney(payment.amount, payment.currency)}</dd>
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
                      <dt>Checkout expires</dt>
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
          </ul>
        )}
      </section>
    </>
  );
}

export default function AdminOrderDetailPage() {
  const { publicOrderNumber } = useParams<{ publicOrderNumber: string }>();
  const { expireSession, getAccessToken } = useAdminAuth();
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [detailPhase, setDetailPhase] = useState<DetailPhase>('loading');
  const [isDetailLoading, setIsDetailLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<StatusAction | null>(null);
  const [mutationInFlight, setMutationInFlight] = useState(false);
  const [mutationNotice, setMutationNotice] = useState<MutationNotice | null>(null);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
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
      const accessToken = getAccessToken();
      if (accessToken === null) {
        expireSession();
        return;
      }
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
        if (
          reason === 'post-mutation' ||
          reason === 'conflict' ||
          (reason === 'manual' && gateWasRequired)
        ) {
          window.setTimeout(() => actionsHeadingRef.current?.focus(), 0);
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
          expireSession();
          return;
        }
        if (error instanceof AdminApiRequestError && error.status === 404) {
          storeDetail(null);
          setDetailPhase('not-found');
          setPendingAction(null);
          setRefreshGate(true);
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
      } finally {
        if (generation === detailGenerationRef.current && mountedRef.current) {
          setIsDetailLoading(false);
        }
      }
    },
    [expireSession, getAccessToken, publicOrderNumber, setRefreshGate, storeDetail],
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
    if (mutationInFlightRef.current || refreshGateRef.current) {
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
      refreshGateRef.current
    ) {
      return;
    }

    const accessToken = getAccessToken();
    if (accessToken === null) {
      expireSession();
      return;
    }
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
        expireSession();
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 404) {
        setPendingAction(null);
        storeDetail(null);
        setDetailPhase('not-found');
        setRefreshGate(true);
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
        return;
      }

      setPendingAction(null);
      setRefreshGate(true);
      setMutationNotice({
        kind: 'warning',
        message:
          'We could not confirm whether the status update was applied. Refresh the order before trying another action.',
      });
    } finally {
      finishMutationRequest();
    }
  }, [
    expireSession,
    getAccessToken,
    loadOrder,
    pendingAction,
    publicOrderNumber,
    setRefreshGate,
    storeDetail,
  ]);

  const actions = detail === null ? [] : STATUS_ACTIONS[detail.status];
  const mutationControlsDisabled = mutationInFlight || requiresRefresh;

  return (
    <article className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <Link className={styles.backLink} to="/admin/orders">
            Back to Orders
          </Link>
          <p className="eyebrow">Order detail</p>
          <h1>Order {publicOrderNumber ?? 'not found'}</h1>
        </div>
        <button
          className={styles.secondaryButton}
          type="button"
          disabled={isDetailLoading || mutationInFlight}
          onClick={() => void loadOrder('manual')}
        >
          Refresh
        </button>
      </header>

      {detail === null && detailPhase === 'loading' ? (
        <section className={styles.statePanel} role="status" aria-live="polite">
          <h2>Loading order</h2>
          <p>The latest order detail is being requested.</p>
        </section>
      ) : null}

      {detailPhase === 'not-found' ? (
        <section className={styles.statePanel} role="alert" aria-live="assertive">
          <h2>Order not found</h2>
          <p>No order is available for this public order number.</p>
        </section>
      ) : null}

      {detail === null && detailPhase === 'error' ? (
        <section className={styles.statePanel} role="alert" aria-live="assertive">
          <h2>Unable to load order</h2>
          <p>{loadError}</p>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => void loadOrder('manual')}
          >
            Retry
          </button>
        </section>
      ) : null}

      {detail !== null && loadError !== null ? (
        <section className={styles.statePanel} role="alert" aria-live="assertive">
          <h2>Unable to refresh order</h2>
          <p>{loadError}</p>
        </section>
      ) : null}

      {detail !== null ? (
        <>
          <section
            className={styles.actionPanel}
            aria-labelledby="order-actions-heading"
          >
            <h2 id="order-actions-heading" ref={actionsHeadingRef} tabIndex={-1}>
              Order actions
            </h2>

            {mutationNotice !== null ? (
              <div
                className={`${styles.mutationNotice} ${styles[mutationNotice.kind]}`}
                role={mutationNotice.kind === 'success' ? 'status' : 'alert'}
                aria-live={mutationNotice.kind === 'success' ? 'polite' : 'assertive'}
              >
                {mutationNotice.message}
              </div>
            ) : null}

            {mutationInFlight ? (
              <p className={styles.updatingStatus} role="status" aria-live="polite">
                Updating order status…
              </p>
            ) : null}

            {requiresRefresh ? (
              <p className={styles.refreshGate} role="status">
                Status actions are disabled until the latest order details are
                refreshed.
              </p>
            ) : null}

            {actions.length === 0 ? (
              <p>No further status actions are available.</p>
            ) : (
              <div className={styles.actionButtons}>
                {actions.map((action) => (
                  <button
                    className={
                      action.destructive
                        ? styles.destructiveButton
                        : styles.primaryButton
                    }
                    type="button"
                    key={action.targetStatus}
                    disabled={mutationControlsDisabled}
                    onClick={(event) => handleActionSelection(action, event)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}

            {pendingAction !== null ? (
              <div
                className={styles.confirmationPanel}
                role="group"
                aria-labelledby="status-confirmation-heading"
              >
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
                  <button
                    className={
                      pendingAction.destructive
                        ? styles.destructiveButton
                        : styles.primaryButton
                    }
                    type="button"
                    disabled={mutationInFlight}
                    onClick={() => void confirmMutation()}
                  >
                    Confirm
                  </button>
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    disabled={mutationInFlight}
                    onClick={closeConfirmation}
                  >
                    Keep current status
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          {isDetailLoading ? (
            <p className={styles.refreshingStatus} role="status" aria-live="polite">
              Refreshing order details…
            </p>
          ) : null}

          <div
            className={`${styles.detailContent} ${
              requiresRefresh ? styles.detailContentStale : ''
            }`}
          >
            <OrderDetail order={detail} />
          </div>
        </>
      ) : null}
    </article>
  );
}
