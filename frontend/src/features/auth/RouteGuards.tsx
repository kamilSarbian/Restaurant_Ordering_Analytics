import { Navigate, Outlet, useLocation } from 'react-router-dom';

import styles from '../../components/admin/AdminShell.module.css';
import { useAuth } from './AuthContext';
import { buildAdminLoginTarget } from './authNavigation';

function CheckingSession() {
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

function TemporarilyUnavailable() {
  const { logout, retrySession } = useAuth();
  return (
    <main className={styles.stateScreen}>
      <section className={styles.statePanel} role="alert" aria-live="assertive">
        <p className="eyebrow">Administrator access</p>
        <h1>Session validation is unavailable</h1>
        <p>
          Your saved session has not been removed. Retry when the service or connection
          is available.
        </p>
        <div className={styles.stateActions}>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => void retrySession()}
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

/** Guard current administrator routes with the canonical application session. */
export function AdministratorRouteGuard() {
  const { phase, user } = useAuth();
  const location = useLocation();

  if (phase === 'checking-session') {
    return <CheckingSession />;
  }
  if (phase === 'temporarily-unavailable') {
    return <TemporarilyUnavailable />;
  }
  if (phase === 'unauthenticated') {
    return <Navigate to={buildAdminLoginTarget(location.pathname)} replace />;
  }
  if (user?.role !== 'admin' && user?.role !== 'super_admin') {
    return <Navigate to="/account" replace state={{ accessDenied: 'administrator' }} />;
  }
  return <Outlet />;
}

/** Restrict the user-management route tree to the current super administrator. */
export function SuperAdminRouteGuard() {
  const { phase, user } = useAuth();
  const location = useLocation();

  if (phase === 'checking-session') {
    return <CheckingSession />;
  }
  if (phase === 'temporarily-unavailable') {
    return <TemporarilyUnavailable />;
  }
  if (phase === 'unauthenticated') {
    return <Navigate to={buildAdminLoginTarget(location.pathname)} replace />;
  }
  if (user?.role !== 'super_admin') {
    const destination = user?.role === 'admin' ? '/admin' : '/account';
    return <Navigate to={destination} replace />;
  }
  return <Outlet />;
}
