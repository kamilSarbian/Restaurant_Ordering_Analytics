import { Link, Outlet } from 'react-router-dom';

import styles from './AppShell.module.css';

export default function AppShell() {
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
        </div>
      </header>
      <main id="main-content" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
