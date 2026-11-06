import { lazy, Suspense, type ComponentType } from 'react';
import { Link, Navigate, type RouteObject } from 'react-router-dom';

import AsyncNotice from '../components/AsyncNotice';
import AdminShell from '../components/admin/AdminShell';
import {
  AdministratorRouteGuard,
  SuperAdminRouteGuard,
} from '../features/auth/RouteGuards';
import { useAuth } from '../features/auth/AuthContext';
import AdminNotFoundPage from './AdminNotFoundPage';

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
  return (
    <section aria-labelledby="admin-demo-heading">
      <p className="eyebrow">Portfolio demo</p>
      <h1 id="admin-demo-heading">Administrator workspace</h1>
      <AsyncNotice title="Shared synthetic workspace">
        Orders, analytics, and exports show shared portfolio data. Runtime activity can
        be visible to other demo visitors; the canonical seeded dataset remains
        protected by the backend.
      </AsyncNotice>
      <p>
        Menu management and personal account views are intentionally unavailable in this
        shared demo.
      </p>
      <ul>
        <li>
          <Link to="/admin/orders">Review orders</Link>
        </li>
        <li>
          <Link to="/admin/analytics">Open analytics</Link>
        </li>
        <li>
          <Link to="/admin/exports">Download reports</Link>
        </li>
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
  if (!isDemoSession) return adminMenuPage;

  return (
    <section aria-labelledby="admin-demo-menu-heading">
      <p className="eyebrow">Portfolio demo</p>
      <h1 id="admin-demo-menu-heading">Menu management is unavailable</h1>
      <AsyncNotice title="The shared catalog is read-only here">
        Administrator menu reads and mutations are disabled for the shared demo
        identity. No administrator menu request was sent.
      </AsyncNotice>
      <Link to="/menu">View the public menu</Link>
    </section>
  );
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
          element: <AdminShell />,
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
