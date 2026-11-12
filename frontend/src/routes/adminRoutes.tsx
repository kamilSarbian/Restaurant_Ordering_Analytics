import { lazy, Suspense, type ComponentType } from 'react';
import { Link, Navigate, type RouteObject } from 'react-router-dom';

import AsyncNotice from '../components/AsyncNotice';
import AdminShell from '../components/admin/AdminShell';
import {
  AdministratorRouteGuard,
  SuperAdminRouteGuard,
} from '../features/auth/RouteGuards';
import { useAuth } from '../features/auth/AuthContext';
import DemoMenuSandbox, {
  DemoMenuSandboxProvider,
} from '../features/admin-menu/DemoMenuSandbox';
import AdminNotFoundPage from './AdminNotFoundPage';
import styles from './adminRoutes.module.css';

function routeLoadingFallback() {
  return (
    <div aria-busy="true">
      <AsyncNotice title="Loading page">Preparing the requested page.</AsyncNotice>
    </div>
  );
}

function lazyRoute(load: () => Promise<{ default: ComponentType }>) {
  const Page = lazy(load);
  return (
    <Suspense fallback={routeLoadingFallback()}>
      <Page />
    </Suspense>
  );
}

const adminHomePage = lazyRoute(() => import('../features/admin-home/AdminHomePage'));
const adminMenuPage = lazyRoute(() => import('../features/admin-menu/AdminMenuPage'));

function DemoAdministratorHome() {
  const cards = [
    {
      description: 'Review shared synthetic orders and their recorded details.',
      label: 'Review orders',
      title: 'Orders',
      to: '/admin/orders',
    },
    {
      description:
        'Explore the historical sample period without treating it as live trading data.',
      label: 'Open analytics',
      title: 'Analytics',
      to: '/admin/analytics',
    },
    {
      description: 'Download the available CSV views of shared synthetic data.',
      label: 'View exports',
      title: 'Exports',
      to: '/admin/exports',
    },
    {
      description:
        'Try browser-only catalog edits and preview them without changing the public menu.',
      label: 'Open menu sandbox',
      title: 'Menu sandbox',
      to: '/admin/menu',
    },
  ] as const;

  return (
    <section className={styles.demoHome} aria-labelledby="admin-demo-heading">
      <p className="eyebrow">Portfolio demo</p>
      <h1 id="admin-demo-heading">Administrator workspace</h1>
      <AsyncNotice title="Shared synthetic workspace">
        Orders, analytics, and exports show shared portfolio data. Runtime activity can
        be visible to other demo visitors; the canonical seeded dataset remains
        protected by the backend.
      </AsyncNotice>
      <ul className={styles.demoCardGrid}>
        {cards.map((card) => (
          <li className={styles.demoCard} key={card.to}>
            <h2>{card.title}</h2>
            <p>{card.description}</p>
            <Link to={card.to}>{card.label}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DemoAwareAdminHome() {
  const { isDemoSession } = useAuth();
  return isDemoSession ? <DemoAdministratorHome /> : adminHomePage;
}

function DemoAwareAdminMenu() {
  const { isDemoSession } = useAuth();
  return isDemoSession ? <DemoMenuSandbox /> : adminMenuPage;
}

export const adminRoutes: RouteObject = {
  path: '/admin',
  children: [
    {
      path: 'login',
      element: <Navigate to="/login?next=%2Fadmin" replace />,
    },
    {
      element: <SuperAdminRouteGuard />,
      children: [
        {
          element: <AdminShell />,
          children: [
            {
              path: 'users',
              element: lazyRoute(
                () => import('../features/admin-users/AdminUsersPage'),
              ),
            },
          ],
        },
      ],
    },
    {
      element: <AdministratorRouteGuard />,
      children: [
        {
          element: (
            <DemoMenuSandboxProvider>
              <AdminShell />
            </DemoMenuSandboxProvider>
          ),
          children: [
            {
              index: true,
              element: <DemoAwareAdminHome />,
            },
            {
              path: 'orders',
              element: lazyRoute(
                () => import('../features/admin-orders/AdminOrdersPage'),
              ),
            },
            {
              path: 'orders/:publicOrderNumber',
              element: lazyRoute(
                () => import('../features/admin-orders/AdminOrderDetailPage'),
              ),
            },
            {
              path: 'menu',
              element: <DemoAwareAdminMenu />,
            },
            {
              path: 'analytics',
              element: lazyRoute(
                () => import('../features/admin-analytics/AdminAnalyticsPage'),
              ),
            },
            {
              path: 'exports',
              element: lazyRoute(
                () => import('../features/admin-exports/AdminExportsPage'),
              ),
            },
            {
              path: '*',
              element: <AdminNotFoundPage />,
            },
          ],
        },
      ],
    },
  ],
};
