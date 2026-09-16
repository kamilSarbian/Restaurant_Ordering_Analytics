import type { ReactNode } from 'react';

import styles from './Notice.module.css';

export type NoticeVariant = 'info' | 'success' | 'warning' | 'danger';
export type NoticeRole = 'alert' | 'status';

export interface NoticeProps {
  children: ReactNode;
  className?: string;
  role?: NoticeRole;
  title?: ReactNode;
  variant?: NoticeVariant;
}

const VARIANT_MARKERS: Record<NoticeVariant, string> = {
  danger: '×',
  info: 'i',
  success: '✓',
  warning: '!',
};

/** Render inline feedback with severity styling and live-region semantics. */
export default function Notice({
  children,
  className,
  role,
  title,
  variant = 'info',
}: NoticeProps) {
  const semanticRole = role ?? (variant === 'danger' ? 'alert' : 'status');
  const classNames = [styles.notice, styles[variant], className]
    .filter(Boolean)
    .join(' ');

  return (
    <section
      aria-atomic="true"
      aria-live={semanticRole === 'alert' ? 'assertive' : 'polite'}
      className={classNames}
      data-variant={variant}
      role={semanticRole}
    >
      <span aria-hidden="true" className={styles.marker}>
        {VARIANT_MARKERS[variant]}
      </span>
      <div className={styles.content}>
        {title === undefined ? null : <strong className={styles.title}>{title}</strong>}
        <div className={styles.body}>{children}</div>
      </div>
    </section>
  );
}
