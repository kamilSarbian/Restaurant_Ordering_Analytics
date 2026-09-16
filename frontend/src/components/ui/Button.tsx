import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'accent' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

/** Render a native button with Nordic variants, sizes, and a guarded loading state. */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    'aria-busy': ariaBusy,
    'aria-label': ariaLabel,
    children,
    className,
    disabled = false,
    loading = false,
    loadingLabel = 'Loading',
    size = 'md',
    type = 'button',
    variant = 'primary',
    ...buttonProps
  },
  ref,
) {
  const accessibleLoadingLabel = loadingLabel.trim() || 'Loading';
  const classNames = [styles.button, styles[variant], styles[size], className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...buttonProps}
      ref={ref}
      aria-busy={loading ? true : ariaBusy}
      aria-label={loading ? accessibleLoadingLabel : ariaLabel}
      className={classNames}
      data-loading={loading || undefined}
      data-size={size}
      data-variant={variant}
      disabled={disabled || loading}
      type={type}
    >
      <span aria-hidden={loading || undefined} className={styles.content}>
        {children}
      </span>
      {loading ? (
        <span aria-hidden="true" className={styles.loadingIndicator}>
          <span className={styles.spinner} />
        </span>
      ) : null}
    </button>
  );
});

export default Button;
