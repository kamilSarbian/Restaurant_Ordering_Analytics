import { Link, useParams } from 'react-router-dom';

import { isPublicOrderNumber, loadOrderAccess } from './orderAccessStorage';
import styles from './CheckoutPage.module.css';

/** Render neutral guidance after the customer returns from hosted checkout. */
export default function PaymentReturnPage() {
  const { publicOrderNumber } = useParams();
  const validPublicOrderNumber = isPublicOrderNumber(publicOrderNumber)
    ? publicOrderNumber
    : null;
  const hasOrderAccess =
    validPublicOrderNumber !== null && loadOrderAccess(validPublicOrderNumber) !== null;

  return (
    <div className={styles.page}>
      <section className={styles.panel} aria-labelledby="payment-return-title">
        <p className={styles.eyebrow}>Secure checkout</p>
        <h1 id="payment-return-title">You returned from secure checkout</h1>
        {validPublicOrderNumber !== null && (
          <>
            <p className={styles.orderNumberLabel}>Public order number</p>
            <p className={styles.orderNumber}>{validPublicOrderNumber}</p>
          </>
        )}
        <p>Payment confirmation can take a moment.</p>
        <p>This page does not check payment status or make a payment claim.</p>
        <nav className={styles.links} aria-label="Payment return navigation">
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
