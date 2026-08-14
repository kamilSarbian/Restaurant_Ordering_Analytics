import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';

import { useAuth } from '../features/auth/AuthContext';

import styles from './AppShell.module.css';

/** Render shared customer navigation and the active customer route. */
export default function AppShell() {
  const { logout, phase, user } = useAuth();
  const navigate = useNavigate();
  const canOpenAdmin = user?.role === 'admin' || user?.role === 'super_admin';

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
          <Link className={styles.brand} to="/" aria-label="Restaurant ordering home">
            <span className={styles.brandMark} aria-hidden="true">
              R
            </span>
            <span>Restaurant Ordering</span>
          </Link>
          <nav className={styles.navigation} aria-label="Customer navigation">
            <NavLink className={styles.navigationLink} to="/" end>
              Home
            </NavLink>
            <NavLink className={styles.navigationLink} to="/menu">
              Menu
            </NavLink>
            <NavLink className={styles.navigationLink} to="/cart">
              Cart
            </NavLink>
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
                <button
                  className={styles.navigationButton}
                  type="button"
                  onClick={handleLogout}
                >
                  Log out
                </button>
              </>
            )}
            {phase === 'checking-session' && (
              <span className={styles.sessionStatus} role="status">
                Checking session...
              </span>
            )}
            {phase === 'temporarily-unavailable' && (
              <span className={styles.sessionStatus}>Session unavailable</span>
            )}
          </nav>
        </div>
      </header>
      <main id="main-content" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
