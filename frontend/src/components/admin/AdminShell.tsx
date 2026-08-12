import { NavLink, Outlet, useNavigate } from 'react-router-dom';

import { useAdminAuth } from '../../features/admin-auth/AdminAuthContext';
import styles from './AdminShell.module.css';

export default function AdminShell() {
  const { admin, logout } = useAdminAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/admin/login', { replace: true });
  };

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#admin-main-content">
        Skip to administrator content
      </a>
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <NavLink className={styles.brand} to="/admin" end>
            <span className={styles.brandMark} aria-hidden="true">
              R
            </span>
            <span>Restaurant Administration</span>
          </NavLink>
          <div className={styles.identity}>
            {admin !== null ? (
              <span className={styles.email}>{admin.email}</span>
            ) : null}
            <button
              className={styles.logoutButton}
              type="button"
              onClick={handleLogout}
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <nav className={styles.navigation} aria-label="Administrator navigation">
        <div className={styles.navigationContent} style={{ flexWrap: 'wrap' }}>
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
        </div>
      </nav>
      <main id="admin-main-content" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
