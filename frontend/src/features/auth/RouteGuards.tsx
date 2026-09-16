import { useEffect, useRef, type RefObject } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import styles from '../../components/admin/AdminShell.module.css';
import { type AuthPhase, useAuth } from './AuthContext';
import { buildAdminLoginTarget } from './authNavigation';

type SessionValidationPhase = Extract<
  AuthPhase,
  'checking-session' | 'temporarily-unavailable'
>;

function shouldRestoreAsyncFocus(): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement === null ||
    activeElement === document.body ||
    !activeElement.isConnected ||
    (activeElement instanceof HTMLButtonElement && activeElement.disabled)
  );
}

function useSessionValidationFocus(
  phase: AuthPhase,
  retrySession: () => Promise<void>,
) {
  const checkingMainRef = useRef<HTMLElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (!restoreFocusRef.current) return;
    if (phase === 'checking-session') {
      if (shouldRestoreAsyncFocus()) {
        checkingMainRef.current?.focus({ preventScroll: true });
      }
      return;
    }

    restoreFocusRef.current = false;
    if (!shouldRestoreAsyncFocus()) return;
    const target =
      phase === 'temporarily-unavailable'
        ? retryButtonRef.current
        : document.getElementById('admin-main-content');
    target?.focus({ preventScroll: true });
  }, [phase]);

  const handleRetrySession = (): void => {
    restoreFocusRef.current = true;
    void retrySession();
  };

  return { checkingMainRef, handleRetrySession, retryButtonRef };
}

function CheckingSession({
  checkingMainRef,
}: {
  checkingMainRef: RefObject<HTMLElement | null>;
}) {
  return (
    <main ref={checkingMainRef} className={styles.stateScreen} tabIndex={-1}>
      <section className={styles.statePanel} role="status" aria-live="polite">
        <p className="eyebrow">Administrator access</p>
        <h1>Checking your session</h1>
        <p>Protected administrator content will appear after validation.</p>
      </section>
    </main>
  );
}

function SessionValidationState({
  checkingMainRef,
  handleRetrySession,
  phase,
  retryButtonRef,
}: {
  checkingMainRef: RefObject<HTMLElement | null>;
  handleRetrySession: () => void;
  phase: SessionValidationPhase;
  retryButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { logout } = useAuth();

  if (phase === 'checking-session') {
    return <CheckingSession checkingMainRef={checkingMainRef} />;
  }

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
            ref={retryButtonRef}
            className={styles.secondaryButton}
            type="button"
            onClick={handleRetrySession}
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
  const { phase, retrySession, user } = useAuth();
  const location = useLocation();
  const sessionFocus = useSessionValidationFocus(phase, retrySession);

  if (phase === 'checking-session' || phase === 'temporarily-unavailable') {
    return <SessionValidationState phase={phase} {...sessionFocus} />;
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
  const { phase, retrySession, user } = useAuth();
  const location = useLocation();
  const sessionFocus = useSessionValidationFocus(phase, retrySession);

  if (phase === 'checking-session' || phase === 'temporarily-unavailable') {
    return <SessionValidationState phase={phase} {...sessionFocus} />;
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
