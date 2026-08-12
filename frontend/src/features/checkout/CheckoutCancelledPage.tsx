import { Link, useParams } from 'react-router-dom';

import { isPublicOrderNumber, loadOrderAccess } from './orderAccessStorage';
import styles from './CheckoutPage.module.css';

/** Explain a hosted-checkout exit without changing order or payment state. */
export default function CheckoutCancelledPage() {
  const { publicOrderNumber } = useParams();
  const validPublicOrderNumber = isPublicOrderNumber(publicOrderNumber)
    ? publicOrderNumber
    : null;
  const hasOrderAccess =
    validPublicOrderNumber !== null && loadOrderAccess(validPublicOrderNumber) !== null;

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
        <nav className={styles.links} aria-label="Cancelled checkout navigation">
          {hasOrderAccess && validPublicOrderNumber !== null && (
            <>
              <Link to={`/orders/${validPublicOrderNumber}/status`}>
                View order status
              </Link>
              <Link to={`/orders/${validPublicOrderNumber}/checkout`}>
                Return to payment
              </Link>
            </>
          )}
          <Link to="/">Browse the menu</Link>
        </nav>
      </section>
    </div>
  );
}
