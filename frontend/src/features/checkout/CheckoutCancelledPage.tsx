import { Link, useParams } from 'react-router-dom';

import BrandMark from '../../components/branding/BrandMark';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import { useAuth } from '../auth/AuthContext';
import { isPublicOrderNumber, loadOrderAccess } from './orderAccessStorage';
import styles from './CheckoutPage.module.css';

/** Explain a hosted-checkout exit without changing order or payment state. */
export default function CheckoutCancelledPage() {
  const { publicOrderNumber } = useParams();
  const { logout, phase, retrySession } = useAuth();
  const validPublicOrderNumber = isPublicOrderNumber(publicOrderNumber)
    ? publicOrderNumber
    : null;
  const hasGuestAccess =
    validPublicOrderNumber !== null && loadOrderAccess(validPublicOrderNumber) !== null;
  const hasOrderAccess = hasGuestAccess || phase === 'authenticated';
  const authIsUnresolved =
    phase === 'checking-session' || phase === 'temporarily-unavailable';
  const showProtectedOrderActions =
    !authIsUnresolved && hasOrderAccess && validPublicOrderNumber !== null;

  return (
    <div className={styles.page}>
      <section
        className={`${styles.panel} ${styles.statePanel}`}
        aria-labelledby="checkout-cancelled-title"
      >
        <div className={styles.brandLockup}>
          <BrandMark className={styles.brandMark} size={24} />
          <span>Nordic Hearth</span>
        </div>
        <p className={styles.eyebrow}>Checkout paused</p>
        <h1 id="checkout-cancelled-title">You left secure checkout</h1>
        <p className={styles.stateIntro}>Hosted checkout was cancelled or closed.</p>
        {validPublicOrderNumber !== null && (
          <div className={styles.stateOrderContext}>
            <p className={styles.orderNumberLabel}>Public order number</p>
            <p className={styles.orderNumber}>{validPublicOrderNumber}</p>
          </div>
        )}
        <p className={styles.stateGuidance}>
          Your restaurant order was not cancelled. This page reports no payment result.
        </p>
        <p className={styles.stateDisclosure}>
          {showProtectedOrderActions
            ? 'You can return to payment when you are ready, follow the order, or browse the menu.'
            : 'Browse the menu without changing the order or payment state.'}
        </p>
        {phase === 'checking-session' && (
          <Notice className={styles.stateNotice} title="Checking saved access">
            Checking your saved session before showing protected order links.
          </Notice>
        )}
        {phase === 'temporarily-unavailable' && (
          <Notice
            className={styles.stateNotice}
            role="alert"
            title="We could not validate your saved access"
            variant="warning"
          >
            <p>Your saved session is retained, but it could not be validated.</p>
            <div className={styles.stateRecoveryActions}>
              <Button
                className={styles.stateRecoveryAction}
                onClick={() => void retrySession()}
                variant="secondary"
              >
                Retry validation
              </Button>
              <Button
                className={styles.stateRecoveryAction}
                onClick={logout}
                variant="ghost"
              >
                Log out
              </Button>
            </div>
          </Notice>
        )}
        <nav className={styles.stateActions} aria-label="Cancelled checkout navigation">
          {showProtectedOrderActions && (
            <>
              <Link
                className={`${styles.stateAction} ${styles.statePrimaryAction}`}
                data-action-priority="primary"
                to={`/orders/${validPublicOrderNumber}/checkout`}
              >
                Return to payment
              </Link>
              <Link
                className={`${styles.stateAction} ${styles.stateSecondaryAction}`}
                to={`/orders/${validPublicOrderNumber}/status`}
              >
                View order status
              </Link>
            </>
          )}
          <Link
            className={`${styles.stateAction} ${
              showProtectedOrderActions
                ? styles.stateTertiaryAction
                : styles.statePrimaryAction
            }`}
            data-action-priority={showProtectedOrderActions ? undefined : 'primary'}
            to="/menu"
          >
            Browse the menu
          </Link>
        </nav>
      </section>
    </div>
  );
}
