import type { RouteObject } from 'react-router-dom';

import AdminShell from '../components/admin/AdminShell';
import AdminAnalyticsPage from '../features/admin-analytics/AdminAnalyticsPage';
import AdminExportsPage from '../features/admin-exports/AdminExportsPage';
import { AdminAuthProvider } from '../features/admin-auth/AdminAuthContext';
import AdminLoginPage from '../features/admin-auth/AdminLoginPage';
import AdminRouteGuard from '../features/admin-auth/AdminRouteGuard';
import AdminMenuPage from '../features/admin-menu/AdminMenuPage';
import AdminOrderDetailPage from '../features/admin-orders/AdminOrderDetailPage';
import AdminOrdersPage from '../features/admin-orders/AdminOrdersPage';
import AdminNotFoundPage from './AdminNotFoundPage';

export const adminRoutes: RouteObject = {
  path: '/admin',
  element: <AdminAuthProvider />,
  children: [
    {
      path: 'login',
      element: <AdminLoginPage />,
    },
    {
      element: <AdminRouteGuard />,
      children: [
        {
          element: <AdminShell />,
          children: [
            {
              index: true,
              element: (
                <section
                  className="foundation-page"
                  aria-labelledby="admin-workspace-heading"
                >
                  <div>
                    <p className="eyebrow">Administrator workspace</p>
                    <h1 id="admin-workspace-heading">Administrator workspace</h1>
                    <p>
                      Manage orders, menu availability, analytics, and CSV exports from
                      the administrator tools.
                    </p>
                  </div>
                </section>
              ),
            },
            {
              path: 'orders',
              element: <AdminOrdersPage />,
            },
            {
              path: 'orders/:publicOrderNumber',
              element: <AdminOrderDetailPage />,
            },
            {
              path: 'menu',
              element: <AdminMenuPage />,
            },
            {
              path: 'analytics',
              element: <AdminAnalyticsPage />,
            },
            {
              path: 'exports',
              element: <AdminExportsPage />,
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
