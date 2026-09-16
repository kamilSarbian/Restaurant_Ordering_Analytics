import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';

import AsyncNotice from '../components/AsyncNotice';
import AdminShell from '../components/admin/AdminShell';
import {
  AdministratorRouteGuard,
  SuperAdminRouteGuard,
} from '../features/auth/RouteGuards';
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
              element: lazyRoute(() => import('../features/admin-home/AdminHomePage')),
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
              element: lazyRoute(() => import('../features/admin-menu/AdminMenuPage')),
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
