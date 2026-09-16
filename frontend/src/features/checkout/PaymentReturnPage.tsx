import { Link, useParams } from 'react-router-dom';

import BrandMark from '../../components/branding/BrandMark';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import { useAuth } from '../auth/AuthContext';
import { isPublicOrderNumber, loadOrderAccess } from './orderAccessStorage';
import styles from './CheckoutPage.module.css';

/** Render neutral guidance after the customer returns from hosted checkout. */
export default function PaymentReturnPage() {
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
        aria-labelledby="payment-return-title"
      >
        <div className={styles.brandLockup}>
          <BrandMark className={styles.brandMark} size={24} />
          <span>Nordic Hearth</span>
        </div>
        <p className={styles.eyebrow}>Payment verification</p>
        <h1 id="payment-return-title">You returned from secure checkout</h1>
        <p className={styles.stateIntro}>
          Returning from secure checkout does not itself confirm a payment result.
        </p>
        {validPublicOrderNumber !== null && (
          <div className={styles.stateOrderContext}>
            <p className={styles.orderNumberLabel}>Public order number</p>
            <p className={styles.orderNumber}>{validPublicOrderNumber}</p>
          </div>
        )}
        <p className={styles.stateGuidance}>
          {showProtectedOrderActions
            ? 'Payment completion is verified outside this page. Use order status to follow the latest progress of your order.'
            : 'Payment completion is verified outside this page. Browse the menu without changing the order or payment state.'}
        </p>
        <p className={styles.stateDisclosure}>
          This page does not check payment status or make a payment claim.
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
        <nav className={styles.stateActions} aria-label="Payment return navigation">
          {showProtectedOrderActions && (
            <>
              <Link
                className={`${styles.stateAction} ${styles.statePrimaryAction}`}
                data-action-priority="primary"
                to={`/orders/${validPublicOrderNumber}/status`}
              >
                View order status
              </Link>
              <Link
                className={`${styles.stateAction} ${styles.stateSecondaryAction}`}
                to={`/orders/${validPublicOrderNumber}/checkout`}
              >
                Return to payment
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
