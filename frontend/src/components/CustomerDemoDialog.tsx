import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

import Button from './ui/Button';
import styles from './CustomerDemoDialog.module.css';

export interface CustomerDemoDialogProps {
  busy: boolean;
  feedback: string | null;
  onClose: () => void;
  onStartDemo: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/** Present the two explicit portfolio customer-session choices in a modal. */
export default function CustomerDemoDialog({
  busy,
  feedback,
  onClose,
  onStartDemo,
  returnFocusRef,
}: CustomerDemoDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const returnFocusElement = returnFocusRef.current;
    firstActionRef.current?.focus();
    return () => returnFocusElement?.focus();
  }, [returnFocusRef]);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || dialogRef.current === null) return;

    const focusable = getFocusableElements(dialogRef.current);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-describedby="customer-demo-description"
        aria-labelledby="customer-demo-title"
        aria-modal="true"
        className={styles.dialog}
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <div className={styles.headingRow}>
          <div>
            <p className={styles.eyebrow}>Portfolio access</p>
            <h2 id="customer-demo-title">Choose how to continue</h2>
          </div>
          <Button
            aria-label="Close login options"
            disabled={false}
            onClick={onClose}
            size="sm"
            type="button"
            variant="ghost"
          >
            Close
          </Button>
        </div>
        <p id="customer-demo-description" className={styles.description}>
          Customer demo uses a shared synthetic identity and shared order history. It is
          not a private visitor account.
        </p>
        {feedback !== null ? (
          <p className={styles.feedback} role="alert">
            {feedback}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button
            loading={busy}
            loadingLabel="Starting customer demo"
            onClick={onStartDemo}
            ref={firstActionRef}
            size="lg"
            type="button"
          >
            Try customer demo
          </Button>
          <Button onClick={onClose} size="lg" type="button" variant="secondary">
            Continue as guest
          </Button>
        </div>
      </div>
    </div>
  );
}
