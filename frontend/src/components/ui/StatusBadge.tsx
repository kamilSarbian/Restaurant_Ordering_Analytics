import styles from './StatusBadge.module.css';

export type StatusBadgeVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface StatusBadgeProps {
  children: string;
  className?: string;
  variant?: StatusBadgeVariant;
}

const VARIANT_MARKERS: Record<StatusBadgeVariant, string> = {
  danger: '×',
  info: 'i',
  neutral: '•',
  success: '✓',
  warning: '!',
};

/** Render compact visible status text with a redundant semantic marker. */
export default function StatusBadge({
  children,
  className,
  variant = 'neutral',
}: StatusBadgeProps) {
  const classNames = [styles.badge, styles[variant], className]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classNames} data-variant={variant}>
      <span aria-hidden="true" className={styles.marker}>
        {VARIANT_MARKERS[variant]}
      </span>
      <span>{children}</span>
    </span>
  );
}
