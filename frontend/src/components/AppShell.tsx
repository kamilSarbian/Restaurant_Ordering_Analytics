import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../features/auth/AuthContext';

import BrandMark from './branding/BrandMark';
import Button from './ui/Button';
import styles from './AppShell.module.css';

function shouldRestoreAsyncFocus(): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement === null ||
    activeElement === document.body ||
    !activeElement.isConnected ||
    (activeElement instanceof HTMLButtonElement && activeElement.disabled)
  );
}

/** Render shared customer navigation and the active customer route. */
export default function AppShell() {
  const { logout, phase, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const initialLocationKeyRef = useRef(location.key);
  const isFirstRouteEffectRef = useRef(true);
  const previousSessionPhaseRef = useRef(phase);
  const previousPathnameRef = useRef(location.pathname);
  const sessionRetryPendingRef = useRef(false);
  const canOpenAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const sessionFeedbackPath =
    location.pathname.length > 1
      ? location.pathname.replace(/\/+$/u, '')
      : location.pathname;
  const pageOwnsSessionFeedback =
    sessionFeedbackPath === '/' ||
    sessionFeedbackPath === '/cart' ||
    sessionFeedbackPath === '/account' ||
    /^\/account\/orders\/[^/]+$/u.test(sessionFeedbackPath) ||
    /^\/orders\/[^/]+\/(?:checkout|payment-return|checkout-cancelled|status)$/u.test(
      sessionFeedbackPath,
    );

  useEffect(() => {
    const isFirstRouteEffect = isFirstRouteEffectRef.current;
    const pathnameChanged = previousPathnameRef.current !== location.pathname;
    const mountedAfterClientNavigation =
      isFirstRouteEffect && initialLocationKeyRef.current !== 'default';
    isFirstRouteEffectRef.current = false;
    previousPathnameRef.current = location.pathname;

    if (pathnameChanged || mountedAfterClientNavigation) {
      mainRef.current?.focus({ preventScroll: true });
    }
  }, [location.pathname]);

  useEffect(() => {
    const previousPhase = previousSessionPhaseRef.current;
    previousSessionPhaseRef.current = phase;
    if (previousPhase === 'temporarily-unavailable' && phase === 'checking-session') {
      sessionRetryPendingRef.current = true;
      if (shouldRestoreAsyncFocus()) {
        mainRef.current?.focus({ preventScroll: true });
      }
      return undefined;
    }
    if (phase === 'checking-session' || !sessionRetryPendingRef.current) {
      return undefined;
    }

    sessionRetryPendingRef.current = false;
    const focusTimeout = window.setTimeout(() => {
      if (shouldRestoreAsyncFocus()) {
        mainRef.current?.focus({ preventScroll: true });
      }
    }, 0);
    return () => window.clearTimeout(focusTimeout);
  }, [phase]);

  const handleLogout = () => {
    logout();
    navigate('/', { flushSync: true, replace: true });
  };

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">
        Skip to main content
      </a>
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <Link className={styles.brand} to="/" aria-label="Nordic Hearth home">
            <BrandMark className={styles.brandMark} size={32} />
            <span className={styles.brandText}>Nordic Hearth</span>
          </Link>
          <nav className={styles.navigation} aria-label="Customer navigation">
            <div className={styles.navigationGroup} data-navigation-group="primary">
              <NavLink className={styles.navigationLink} to="/" end>
                Home
              </NavLink>
              <NavLink className={styles.navigationLink} to="/menu">
                Menu
              </NavLink>
              <NavLink className={styles.navigationLink} to="/cart">
                Cart
              </NavLink>
            </div>
            <div className={styles.navigationGroup} data-navigation-group="account">
              {phase === 'unauthenticated' && (
                <>
                  <NavLink className={styles.navigationLink} to="/login">
                    Log in
                  </NavLink>
                  <NavLink className={styles.navigationLink} to="/register">
                    Create account
                  </NavLink>
                </>
              )}
              {phase === 'authenticated' && user !== null && (
                <>
                  <NavLink className={styles.navigationLink} to="/account">
                    My account
                  </NavLink>
                  {canOpenAdmin && (
                    <NavLink className={styles.navigationLink} to="/admin">
                      Admin
                    </NavLink>
                  )}
                  <Button
                    className={styles.navigationButton}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={handleLogout}
                  >
                    Log out
                  </Button>
                </>
              )}
              {phase === 'checking-session' && (
                <span
                  className={styles.sessionStatus}
                  role={pageOwnsSessionFeedback ? undefined : 'status'}
                >
                  Checking session...
                </span>
              )}
              {phase === 'temporarily-unavailable' && (
                <span
                  className={styles.sessionStatus}
                  role={pageOwnsSessionFeedback ? undefined : 'status'}
                >
                  Session unavailable
                </span>
              )}
            </div>
          </nav>
        </div>
      </header>
      <main ref={mainRef} id="main-content" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
