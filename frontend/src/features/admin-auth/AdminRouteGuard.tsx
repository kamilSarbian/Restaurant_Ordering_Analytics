import { Navigate, Outlet, useLocation } from 'react-router-dom';

import styles from '../../components/admin/AdminShell.module.css';
import { useAdminAuth } from './AdminAuthContext';

export default function AdminRouteGuard() {
  const { phase, logout, retrySessionValidation } = useAdminAuth();
  const location = useLocation();

  if (phase === 'checking-session') {
    return (
      <main className={styles.stateScreen}>
        <section className={styles.statePanel} role="status" aria-live="polite">
          <p className="eyebrow">Administrator access</p>
          <h1>Checking your session</h1>
          <p>Protected administrator content will appear after validation.</p>
        </section>
      </main>
    );
  }

  if (phase === 'temporarily-unavailable') {
    return (
      <main className={styles.stateScreen}>
        <section className={styles.statePanel} role="alert" aria-live="assertive">
          <p className="eyebrow">Administrator access</p>
          <h1>Session validation is unavailable</h1>
          <p>
            Your saved session has not been removed. Retry when the service or
            connection is available.
          </p>
          <div className={styles.stateActions}>
            <button
              className={styles.secondaryButton}
              type="button"
              onClick={() => void retrySessionValidation()}
            >
              Retry validation
            </button>
            <button className={styles.secondaryButton} type="button" onClick={logout}>
              Log out
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (phase === 'unauthenticated') {
    return (
      <Navigate
        to="/admin/login"
        replace
        state={{ returnTo: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <Outlet />;
}
