import {
  createBrowserRouter,
  Navigate,
  Outlet,
  type RouteObject,
  useLocation,
} from 'react-router-dom';

import AppShell from '../components/AppShell';
import AsyncNotice from '../components/AsyncNotice';
import AccountOrderDetailPage from '../features/account/AccountOrderDetailPage';
import AccountOrdersPage from '../features/account/AccountOrdersPage';
import RegisterPage from '../features/auth/RegisterPage';
import CartPage from '../features/cart/CartPage';
import { CartProvider } from '../features/cart/CartContext';
import CheckoutPage from '../features/checkout/CheckoutPage';
import CheckoutCancelledPage from '../features/checkout/CheckoutCancelledPage';
import PaymentReturnPage from '../features/checkout/PaymentReturnPage';
import { AuthProvider, useAuth } from '../features/auth/AuthContext';
import LoginPage from '../features/auth/LoginPage';
import LandingPage from '../features/landing/LandingPage';
import MenuPage from '../features/menu/MenuPage';
import OrderStatusPage from '../features/order-status/OrderStatusPage';
import { adminRoutes } from './adminRoutes';
import NotFoundPage from './NotFoundPage';

// The account guard stays beside the route tree so both account pages share one boundary.
// eslint-disable-next-line react-refresh/only-export-components
function AccountRouteGuard() {
  const { logout, phase, retrySession } = useAuth();
  const location = useLocation();

  if (phase === 'checking-session') {
    return (
      <AsyncNotice title="Checking your session">
        Personal orders will appear after your saved session is validated.
      </AsyncNotice>
    );
  }
  if (phase === 'temporarily-unavailable') {
    return (
      <AsyncNotice role="alert" tone="error" title="Session validation is unavailable">
        <p>Your saved session remains available for another validation attempt.</p>
        <button type="button" onClick={() => void retrySession()}>
          Retry validation
        </button>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </AsyncNotice>
    );
  }
  if (phase === 'unauthenticated') {
    return (
      <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />
    );
  }
  return <Outlet />;
}

export const routes: RouteObject[] = [
  {
    element: <AuthProvider />,
    children: [
      adminRoutes,
      {
        path: '/login',
        element: <LoginPage />,
      },
      {
        path: '/register',
        element: <RegisterPage />,
      },
      {
        path: '/',
        element: (
          <CartProvider>
            <AppShell />
          </CartProvider>
        ),
        children: [
          {
            index: true,
            element: <LandingPage />,
          },
          {
            path: 'menu',
            element: <MenuPage />,
          },
          {
            path: 'cart',
            element: <CartPage />,
          },
          {
            element: <AccountRouteGuard />,
            children: [
              {
                path: 'account',
                element: <AccountOrdersPage />,
              },
              {
                path: 'account/orders/:publicOrderNumber',
                element: <AccountOrderDetailPage />,
              },
            ],
          },
          {
            path: 'orders/:publicOrderNumber/checkout',
            element: <CheckoutPage />,
          },
          {
            path: 'orders/:publicOrderNumber/payment-return',
            element: <PaymentReturnPage />,
          },
          {
            path: 'orders/:publicOrderNumber/checkout-cancelled',
            element: <CheckoutCancelledPage />,
          },
          {
            path: 'orders/:publicOrderNumber/status',
            element: <OrderStatusPage />,
          },
          {
            path: '*',
            element: <NotFoundPage />,
          },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
