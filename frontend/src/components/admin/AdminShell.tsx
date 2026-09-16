import { useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../../features/auth/AuthContext';
import BrandMark from '../branding/BrandMark';
import Button from '../ui/Button';
import styles from './AdminShell.module.css';

/** Render the protected administrator navigation and active workspace route. */
export default function AdminShell() {
  const { logout, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const initialLocationKeyRef = useRef(location.key);
  const isFirstRouteEffectRef = useRef(true);
  const previousPathnameRef = useRef(location.pathname);

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

  const handleLogout = () => {
    logout();
    navigate('/', { flushSync: true, replace: true });
  };

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#admin-main-content">
        Skip to administrator content
      </a>
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <Link className={styles.brand} to="/admin">
            <BrandMark className={styles.brandMark} size={24} />
            <span className={styles.brandText}>Nordic Hearth</span>
          </Link>
          <div className={styles.identity}>
            {user !== null ? <span className={styles.email}>{user.email}</span> : null}
            <Button
              className={styles.logoutButton}
              size="md"
              type="button"
              variant="secondary"
              onClick={handleLogout}
            >
              Log out
            </Button>
          </div>
        </div>
      </header>
      <nav className={styles.navigation} aria-label="Administrator navigation">
        <div className={styles.navigationContent}>
          <NavLink
            className={({ isActive }) =>
              `${styles.navigationLink} ${isActive ? styles.navigationLinkActive : ''}`
            }
            to="/admin"
            end
          >
            Admin home
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `${styles.navigationLink} ${isActive ? styles.navigationLinkActive : ''}`
            }
            to="/admin/orders"
          >
            Orders
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `${styles.navigationLink} ${isActive ? styles.navigationLinkActive : ''}`
            }
            to="/admin/menu"
          >
            Menu
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `${styles.navigationLink} ${isActive ? styles.navigationLinkActive : ''}`
            }
            to="/admin/analytics"
          >
            Analytics
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `${styles.navigationLink} ${isActive ? styles.navigationLinkActive : ''}`
            }
            to="/admin/exports"
          >
            Exports
          </NavLink>
          {user?.role === 'super_admin' ? (
            <NavLink
              className={({ isActive }) =>
                `${styles.navigationLink} ${isActive ? styles.navigationLinkActive : ''}`
              }
              to="/admin/users"
            >
              Users
            </NavLink>
          ) : null}
        </div>
      </nav>
      <main ref={mainRef} id="admin-main-content" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
