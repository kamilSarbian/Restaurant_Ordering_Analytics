import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import styles from './LandingPage.module.css';

/** Present the public ordering entry point without assuming an auth identity. */
export default function LandingPage() {
  const { logout, phase, retrySession, user } = useAuth();
  const canOpenAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-labelledby="landing-heading">
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Restaurant ordering</p>
          <h1 id="landing-heading">Fresh food, ordered your way</h1>
          <p className={styles.introduction}>
            Browse the current menu, build your cart, and follow your order from one
            clear place.
          </p>
        </div>

        {phase === 'checking-session' && (
          <div className={styles.sessionNotice} role="status" aria-live="polite">
            <strong>Checking your saved session</strong>
            <span>Your account options will appear after validation.</span>
          </div>
        )}

        {phase === 'temporarily-unavailable' && (
          <div className={styles.sessionNotice} role="alert" aria-live="assertive">
            <strong>Session validation is unavailable</strong>
            <span>Your saved session has not been removed.</span>
            <div className={styles.actions}>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => void retrySession()}
              >
                Retry validation
              </button>
              <button className={styles.secondaryButton} type="button" onClick={logout}>
                Clear session
              </button>
            </div>
          </div>
        )}

        {phase === 'unauthenticated' && (
          <nav className={styles.actions} aria-label="Start ordering">
            <Link className={styles.primaryAction} to="/menu">
              Order as guest
            </Link>
            <Link className={styles.secondaryAction} to="/login">
              Log in
            </Link>
            <Link className={styles.secondaryAction} to="/register">
              Create account
            </Link>
          </nav>
        )}

        {phase === 'authenticated' && user !== null && (
          <div className={styles.authenticatedActions}>
            <p>
              Signed in as <strong>{user.email}</strong>
            </p>
            <div className={styles.actions}>
              <Link className={styles.primaryAction} to="/menu">
                Continue ordering
              </Link>
              {canOpenAdmin && (
                <Link className={styles.secondaryAction} to="/admin">
                  Admin
                </Link>
              )}
              <button className={styles.secondaryButton} type="button" onClick={logout}>
                Log out
              </button>
            </div>
          </div>
        )}
      </section>

      <section className={styles.details} aria-labelledby="landing-details-heading">
        <div>
          <p className={styles.eyebrow}>Simple by design</p>
          <h2 id="landing-details-heading">Order without losing your place</h2>
        </div>
        <p>
          Guest ordering remains available, while an account gives you a consistent
          sign-in for future customer features. Your current cart stays in this browser
          session either way.
        </p>
      </section>
    </div>
  );
}
