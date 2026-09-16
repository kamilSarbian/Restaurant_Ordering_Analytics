import { lazy, Suspense, useEffect, useRef, type ComponentType } from 'react';
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  type RouteObject,
  useLocation,
} from 'react-router-dom';

import AppShell from '../components/AppShell';
import AsyncNotice from '../components/AsyncNotice';
import Button from '../components/ui/Button';
import { CartProvider } from '../features/cart/CartContext';
import { AuthProvider, useAuth } from '../features/auth/AuthContext';
import LandingPage from '../features/landing/LandingPage';
import { adminRoutes } from './adminRoutes';
import NotFoundPage from './NotFoundPage';

function focusRouteMainIfAbandoned(main: HTMLElement | null): void {
  if (main === null) return;

  const activeElement = document.activeElement;
  if (
    activeElement === null ||
    activeElement === document.body ||
    !activeElement.isConnected ||
    (activeElement instanceof HTMLButtonElement && activeElement.disabled)
  ) {
    main.focus({ preventScroll: true });
  }
}

function routeLoadingFallback(standalone = false) {
  const notice = (
    <AsyncNotice title="Loading page">Preparing the requested page.</AsyncNotice>
  );

  return standalone ? (
    <main
      ref={focusRouteMainIfAbandoned}
      id="main-content"
      aria-busy="true"
      tabIndex={-1}
    >
      {notice}
    </main>
  ) : (
    <div aria-busy="true">{notice}</div>
  );
}

function withStandaloneRouteFocus(Page: ComponentType): ComponentType {
  return function FocusedStandaloneRoute() {
    const { phase } = useAuth();

    useEffect(() => {
      const main = document.querySelector<HTMLElement>('main');
      if (main !== null) {
        main.tabIndex = -1;
      }
      focusRouteMainIfAbandoned(main);
    }, [phase]);

    return <Page />;
  };
}

function lazyRoute(
  load: () => Promise<{ default: ComponentType }>,
  standalone = false,
) {
  const Page = lazy(async () => {
    const loadedRoute = await load();
    return standalone
      ? { default: withStandaloneRouteFocus(loadedRoute.default) }
      : loadedRoute;
  });

  return (
    <Suspense fallback={routeLoadingFallback(standalone)}>
      <Page />
    </Suspense>
  );
}

// The root route exports configuration from this module alongside its error UI.
// eslint-disable-next-line react-refresh/only-export-components
function RouteErrorPage() {
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <main ref={mainRef} id="main-content" tabIndex={-1}>
      <section className="not-found" aria-labelledby="route-error-heading">
        <p className="eyebrow">Nordic Hearth</p>
        <h1 id="route-error-heading">Page unavailable</h1>
        <AsyncNotice role="alert" tone="error" title="The page could not be loaded">
          Please return home and try again.
        </AsyncNotice>
        <a className="action-link" href="/">
          Return home
        </a>
      </section>
    </main>
  );
}

// The account guard stays beside the route tree so both account pages share one boundary.
// eslint-disable-next-line react-refresh/only-export-components
function AccountRouteGuard() {
  const { logout, phase, retrySession } = useAuth();
  const location = useLocation();
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRetryFocusRef = useRef(false);

  useEffect(() => {
    if (phase === 'checking-session' || !restoreRetryFocusRef.current) {
      return;
    }

    restoreRetryFocusRef.current = false;
    if (phase !== 'temporarily-unavailable') {
      return;
    }

    const activeElement = document.activeElement;
    const main = document.getElementById('main-content');
    if (
      activeElement === null ||
      activeElement === document.body ||
      !activeElement.isConnected ||
      activeElement === main
    ) {
      retryButtonRef.current?.focus();
    }
  }, [phase]);

  const handleRetrySession = (): void => {
    restoreRetryFocusRef.current = true;
    void retrySession();
  };

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
        <Button ref={retryButtonRef} onClick={handleRetrySession} size="md">
          Retry validation
        </Button>
        <Button onClick={logout} size="md" variant="ghost">
          Log out
        </Button>
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
    errorElement: <RouteErrorPage />,
    children: [
      adminRoutes,
      {
        path: '/login',
        element: lazyRoute(() => import('../features/auth/LoginPage'), true),
      },
      {
        path: '/register',
        element: lazyRoute(() => import('../features/auth/RegisterPage'), true),
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
            element: lazyRoute(() => import('../features/menu/MenuPage')),
          },
          {
            path: 'cart',
            element: lazyRoute(() => import('../features/cart/CartPage')),
          },
          {
            element: <AccountRouteGuard />,
            children: [
              {
                path: 'account',
                element: lazyRoute(
                  () => import('../features/account/AccountOrdersPage'),
                ),
              },
              {
                path: 'account/orders/:publicOrderNumber',
                element: lazyRoute(
                  () => import('../features/account/AccountOrderDetailPage'),
                ),
              },
            ],
          },
          {
            path: 'orders/:publicOrderNumber/checkout',
            element: lazyRoute(() => import('../features/checkout/CheckoutPage')),
          },
          {
            path: 'orders/:publicOrderNumber/payment-return',
            element: lazyRoute(() => import('../features/checkout/PaymentReturnPage')),
          },
          {
            path: 'orders/:publicOrderNumber/checkout-cancelled',
            element: lazyRoute(
              () => import('../features/checkout/CheckoutCancelledPage'),
            ),
          },
          {
            path: 'orders/:publicOrderNumber/status',
            element: lazyRoute(
              () => import('../features/order-status/OrderStatusPage'),
            ),
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
