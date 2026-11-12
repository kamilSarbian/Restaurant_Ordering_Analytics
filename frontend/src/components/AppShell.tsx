import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { isDemoSessionEntryEnabled } from '../config/demoSession';
import { isCustomerDemoSessionEntryEnabled } from '../config/customerDemoSession';
import { isPortfolioModeEnabled } from '../config/portfolioMode';
import { useAuth } from '../features/auth/AuthContext';

import BrandMark from './branding/BrandMark';
import CustomerDemoDialog from './CustomerDemoDialog';
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
  const { demoSessionKind, logout, phase, startCustomerDemoSession, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const initialLocationKeyRef = useRef(location.key);
  const isFirstRouteEffectRef = useRef(true);
  const previousSessionPhaseRef = useRef(phase);
  const previousPathnameRef = useRef(location.pathname);
  const sessionRetryPendingRef = useRef(false);
  const customerDemoTriggerRef = useRef<HTMLButtonElement>(null);
  const customerDemoRequestRef = useRef(0);
  const customerDemoPendingRef = useRef(false);
  const customerDemoControllerRef = useRef<AbortController | null>(null);
  const customerDemoAuthStateRef = useRef({ demoSessionKind, phase });
  const [customerDemoDialogOpen, setCustomerDemoDialogOpen] = useState(false);
  const [customerDemoPending, setCustomerDemoPending] = useState(false);
  const [customerDemoFeedback, setCustomerDemoFeedback] = useState<string | null>(null);
  const canOpenAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const demoSessionEntryEnabled = isDemoSessionEntryEnabled();
  const customerDemoSessionEntryEnabled = isCustomerDemoSessionEntryEnabled();
  const portfolioModeEnabled = isPortfolioModeEnabled();
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

  const cancelCustomerDemoAttempt = useCallback((): boolean => {
    customerDemoRequestRef.current += 1;
    const wasPending = customerDemoPendingRef.current;
    customerDemoPendingRef.current = false;
    customerDemoControllerRef.current?.abort();
    customerDemoControllerRef.current = null;
    return wasPending;
  }, []);

  useEffect(() => {
    customerDemoAuthStateRef.current = { demoSessionKind, phase };
  }, [demoSessionKind, phase]);

  useEffect(() => {
    const isFirstRouteEffect = isFirstRouteEffectRef.current;
    const pathnameChanged = previousPathnameRef.current !== location.pathname;
    const mountedAfterClientNavigation =
      isFirstRouteEffect && initialLocationKeyRef.current !== 'default';
    isFirstRouteEffectRef.current = false;
    previousPathnameRef.current = location.pathname;

    if (pathnameChanged && customerDemoPendingRef.current) {
      cancelCustomerDemoAttempt();
      setCustomerDemoPending(false);
      setCustomerDemoFeedback(null);
      setCustomerDemoDialogOpen(false);
    }
    if (pathnameChanged || mountedAfterClientNavigation) {
      mainRef.current?.focus({ preventScroll: true });
    }
  }, [cancelCustomerDemoAttempt, location.pathname]);

  useEffect(
    () => () => {
      const wasPending = cancelCustomerDemoAttempt();
      const latestAuthState = customerDemoAuthStateRef.current;
      if (
        !wasPending &&
        latestAuthState.demoSessionKind === 'customer' &&
        latestAuthState.phase !== 'authenticated'
      ) {
        logout();
      }
    },
    [cancelCustomerDemoAttempt, logout],
  );

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

  const closeCustomerDemoDialog = (): void => {
    const wasPending = cancelCustomerDemoAttempt();
    if (!wasPending && phase !== 'authenticated' && demoSessionKind === 'customer') {
      logout();
    }
    setCustomerDemoPending(false);
    setCustomerDemoFeedback(null);
    setCustomerDemoDialogOpen(false);
  };

  const handleCustomerDemoStart = async (): Promise<void> => {
    if (customerDemoPendingRef.current) return;
    const requestId = customerDemoRequestRef.current + 1;
    customerDemoRequestRef.current = requestId;
    const controller = new AbortController();
    customerDemoControllerRef.current = controller;
    customerDemoPendingRef.current = true;
    setCustomerDemoFeedback(null);
    setCustomerDemoPending(true);
    const outcome = await startCustomerDemoSession(controller.signal);
    if (customerDemoControllerRef.current === controller) {
      customerDemoControllerRef.current = null;
    }
    if (customerDemoRequestRef.current !== requestId) return;
    customerDemoPendingRef.current = false;
    setCustomerDemoPending(false);
    if (outcome.kind === 'authenticated') {
      setCustomerDemoDialogOpen(false);
      navigate('/account');
      return;
    }
    if (outcome.kind === 'aborted') return;
    if (outcome.kind === 'rate-limited') {
      setCustomerDemoFeedback(
        outcome.retryAfterSeconds === null
          ? 'Too many attempts. Please wait before trying again.'
          : `Too many attempts. Try again in ${outcome.retryAfterSeconds} seconds.`,
      );
      return;
    }
    setCustomerDemoFeedback(
      outcome.kind === 'timeout'
        ? 'The customer demo took too long to respond.'
        : outcome.kind === 'network'
          ? 'Could not start the customer demo. Check your connection.'
          : 'The customer demo is unavailable right now.',
    );
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
                  {!portfolioModeEnabled ? (
                    <NavLink className={styles.navigationLink} to="/login">
                      Log in
                    </NavLink>
                  ) : null}
                  {demoSessionEntryEnabled ? (
                    <NavLink
                      className={styles.navigationLink}
                      to="/login?next=%2Fadmin"
                    >
                      Try admin demo
                    </NavLink>
                  ) : null}
                  {portfolioModeEnabled && customerDemoSessionEntryEnabled ? (
                    <button
                      className={`${styles.navigationLink} ${styles.navigationLinkButton}`}
                      onClick={() => {
                        setCustomerDemoFeedback(null);
                        setCustomerDemoDialogOpen(true);
                      }}
                      ref={customerDemoTriggerRef}
                      type="button"
                    >
                      Log in
                    </button>
                  ) : null}
                  {!portfolioModeEnabled ? (
                    <NavLink className={styles.navigationLink} to="/register">
                      Create account
                    </NavLink>
                  ) : null}
                </>
              )}
              {phase === 'authenticated' && user !== null && (
                <>
                  {demoSessionKind !== null ? (
                    <span className={styles.sessionStatus}>
                      {demoSessionKind === 'customer'
                        ? 'Customer demo · shared synthetic history'
                        : 'Admin demo · shared synthetic data'}
                    </span>
                  ) : null}
                  {demoSessionKind !== 'admin' ? (
                    <NavLink className={styles.navigationLink} to="/account">
                      My account
                    </NavLink>
                  ) : null}
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
      {customerDemoDialogOpen ? (
        <CustomerDemoDialog
          busy={customerDemoPending}
          feedback={customerDemoFeedback}
          onClose={closeCustomerDemoDialog}
          onStartDemo={() => void handleCustomerDemoStart()}
          returnFocusRef={customerDemoTriggerRef}
        />
      ) : null}
      <main ref={mainRef} id="main-content" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
