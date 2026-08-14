import { Link, useParams } from 'react-router-dom';

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

  return (
    <div className={styles.page}>
      <section className={styles.panel} aria-labelledby="checkout-cancelled-title">
        <p className={styles.eyebrow}>Secure checkout</p>
        <h1 id="checkout-cancelled-title">You left secure checkout</h1>
        {validPublicOrderNumber !== null && (
          <>
            <p className={styles.orderNumberLabel}>Public order number</p>
            <p className={styles.orderNumber}>{validPublicOrderNumber}</p>
          </>
        )}
        <p>Hosted checkout was cancelled or closed.</p>
        <p>
          Your restaurant order was not cancelled. This page reports no payment result.
        </p>
        {phase === 'checking-session' && (
          <p role="status" aria-live="polite">
            Checking your saved session before showing protected order links.
          </p>
        )}
        {phase === 'temporarily-unavailable' && (
          <div role="alert" aria-live="assertive">
            <p>Your saved session is retained, but it could not be validated.</p>
            <button type="button" onClick={() => void retrySession()}>
              Retry validation
            </button>
            <button type="button" onClick={logout}>
              Log out
            </button>
          </div>
        )}
        <nav className={styles.links} aria-label="Cancelled checkout navigation">
          {!authIsUnresolved && hasOrderAccess && validPublicOrderNumber !== null && (
            <>
              <Link to={`/orders/${validPublicOrderNumber}/status`}>
                View order status
              </Link>
              <Link to={`/orders/${validPublicOrderNumber}/checkout`}>
                Return to payment
              </Link>
            </>
          )}
          <Link to="/menu">Browse the menu</Link>
        </nav>
      </section>
    </div>
  );
}
