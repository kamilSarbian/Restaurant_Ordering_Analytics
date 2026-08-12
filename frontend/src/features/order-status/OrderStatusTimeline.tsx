import type { OrderStatus } from '../../api/types';
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

interface OrderStatusTimelineProps {
  status: OrderStatus;
}

/** Render textual and visual fulfilment progress without color-only meaning. */
export default function OrderStatusTimeline({ status }: OrderStatusTimelineProps) {
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
