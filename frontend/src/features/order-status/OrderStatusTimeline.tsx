import type { OrderStatus } from '../../api/types';
import StatusBadge, { type StatusBadgeVariant } from '../../components/ui/StatusBadge';
import styles from './OrderStatusPage.module.css';

const NORMAL_PROGRESSION: OrderStatus[] = [
  'created',
  'accepted',
  'preparing',
  'ready',
  'completed',
];

const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  accepted: 'Accepted',
  cancelled: 'Cancelled',
  completed: 'Completed',
  created: 'Order received',
  preparing: 'Preparing',
  ready: 'Ready',
};

const AUTHORITATIVE_STATUS_PRESENTATION: Record<
  OrderStatus,
  { description: string; variant: StatusBadgeVariant }
> = {
  accepted: {
    description: 'The restaurant has accepted your order.',
    variant: 'info',
  },
  cancelled: {
    description: 'This order is marked as cancelled.',
    variant: 'danger',
  },
  completed: {
    description: 'This order is marked as completed.',
    variant: 'success',
  },
  created: {
    description: 'Your order has been received.',
    variant: 'neutral',
  },
  preparing: {
    description: 'The kitchen is preparing your order.',
    variant: 'info',
  },
  ready: {
    description: 'Your order is ready.',
    variant: 'info',
  },
};

interface OrderStatusTimelineProps {
  mode?: 'projected' | 'authoritative-current';
  status: OrderStatus;
}

/** Render textual and visual fulfilment progress without color-only meaning. */
export default function OrderStatusTimeline({
  mode = 'projected',
  status,
}: OrderStatusTimelineProps) {
  if (mode === 'authoritative-current') {
    const presentation = AUTHORITATIVE_STATUS_PRESENTATION[status];
    return (
      <section
        className={`${styles.currentPanel} ${styles.publicCurrentPanel}`}
        data-order-status={status}
        aria-labelledby="current-status-title"
      >
        <p className={styles.currentStatusLabel}>Current fulfilment status</p>
        <ol className={styles.currentOnlyTimeline} aria-label="Current order status">
          <li
            className={styles.currentOnlyStep}
            data-order-status={status}
            aria-current="step"
          >
            <StatusBadge
              className={styles.currentStatusBadge}
              variant={presentation.variant}
            >
              Current status
            </StatusBadge>
            <div className={styles.currentStatusCopy}>
              <h2 id="current-status-title">{ORDER_STATUS_LABELS[status]}</h2>
              <p>{presentation.description}</p>
              <small>Latest status reported by the restaurant</small>
            </div>
          </li>
        </ol>
        <span
          className={styles.visuallyHidden}
          role="status"
          aria-atomic="true"
          aria-live="polite"
        >
          Current status: {ORDER_STATUS_LABELS[status]}
        </span>
      </section>
    );
  }

  if (status === 'cancelled') {
    return (
      <section className={styles.timelinePanel} aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Order timeline</h2>
        <ol className={styles.timeline}>
          <li className={styles.timelineStep} data-state="completed">
            <span className={styles.marker} aria-hidden="true">
              ✓
            </span>
            <span>
              <strong>Order received</strong>
              <small>Completed step</small>
            </span>
          </li>
          <li
            className={styles.timelineStep}
            data-state="cancelled"
            aria-current="step"
          >
            <span className={styles.marker} aria-hidden="true">
              ×
            </span>
            <span>
              <strong>Cancelled</strong>
              <small>Current status</small>
            </span>
          </li>
        </ol>
      </section>
    );
  }

  const currentIndex = NORMAL_PROGRESSION.indexOf(status);
  return (
    <section className={styles.timelinePanel} aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">Order timeline</h2>
      <ol className={styles.timeline}>
        {NORMAL_PROGRESSION.map((step, index) => {
          const stepState =
            index < currentIndex
              ? 'completed'
              : index === currentIndex
                ? 'current'
                : 'upcoming';
          const stateLabel =
            stepState === 'completed'
              ? 'Completed step'
              : stepState === 'current'
                ? 'Current status'
                : 'Upcoming step';
          return (
            <li
              className={styles.timelineStep}
              data-state={stepState}
              aria-current={stepState === 'current' ? 'step' : undefined}
              key={step}
            >
              <span className={styles.marker} aria-hidden="true">
                {stepState === 'completed' ? '✓' : index + 1}
              </span>
              <span>
                <strong>{ORDER_STATUS_LABELS[step]}</strong>
                <small>{stateLabel}</small>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
