import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryRouter,
  RouterProvider,
  type InitialEntry,
} from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import { AuthProvider } from '../features/auth/AuthContext';
import LoginPage from '../features/auth/LoginPage';
import {
  AUTH_STORAGE_KEY,
  resetAuthMemoryForTests,
} from '../features/auth/authStorage';
import { installFetchStub } from '../test/fetchStub';
import { adminRoutes } from './adminRoutes';

vi.mock('../features/admin-home/AdminHomePage', () => ({
  default: () => (
    <section aria-labelledby="admin-workspace-heading">
      <h1 id="admin-workspace-heading">Administrator workspace</h1>
      <p>
        Manage orders, menu availability, analytics, and CSV exports from the
        administrator tools.
      </p>
    </section>
  ),
}));

const SYNTHETIC_TOKEN = 'test-admin-token';
const FIXED_NOW = new Date('2026-08-12T12:00:00+02:00');
const LOGIN_RESPONSE = {
  access_token: SYNTHETIC_TOKEN,
  expires_in: 1_800,
  token_type: 'bearer',
};
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000900';
const ME_RESPONSE = {
  email: 'admin@example.test',
  id: ADMIN_USER_ID,
  is_active: true,
  role: 'admin',
};
const CUSTOMER_ME_RESPONSE = { ...ME_RESPONSE, role: 'customer' };
const SUPER_ADMIN_ME_RESPONSE = { ...ME_RESPONSE, role: 'super_admin' };
const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const EMPTY_ORDERS_RESPONSE = { items: [], total: 0, limit: 50, offset: 0 };
const EMPTY_CATEGORIES_RESPONSE = { items: [], total: 0, limit: 50, offset: 0 };
const EMPTY_MENU_ITEMS_RESPONSE = { items: [], total: 0, limit: 50, offset: 0 };
const EMPTY_USERS_RESPONSE = { items: [], total: 0, limit: 50, offset: 0 };
const ANALYTICS_RANGE = {
  start: '2026-08-06T00:00:00+02:00',
  end: '2026-08-13T00:00:00+02:00',
  timezone: 'Europe/Oslo',
};
const EMPTY_ANALYTICS_OVERVIEW = { range: ANALYTICS_RANGE, currencies: [] };
const EMPTY_PRODUCT_ANALYTICS = {
  range: ANALYTICS_RANGE,
  limit_per_currency: 50,
  items: [],
};
const EMPTY_CATEGORY_ANALYTICS = {
  range: ANALYTICS_RANGE,
  limit_per_currency: 50,
  items: [],
};
const EMPTY_ORDER_TYPE_ANALYTICS = { range: ANALYTICS_RANGE, items: [] };
const ORDER_DETAIL_RESPONSE = {
  order_id: '00000000-0000-4000-8000-000000000001',
  public_order_number: PUBLIC_ORDER_NUMBER,
  status: 'created',
  order_type: 'takeaway',
  table_number: null,
  currency: 'NOK',
  subtotal_amount: 1_000,
  total_amount: 1_000,
  created_at: '2026-08-12T10:00:00+00:00',
  updated_at: '2026-08-12T10:00:00+00:00',
  items: [],
  status_history: [],
  payments: [],
};

function storeToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 1 }),
  );
}

function renderAdminRoute(initialEntry: InitialEntry) {
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [
          { path: '/', element: <h1>Customer home</h1> },
          { path: '/account', element: <h1>Customer account</h1> },
          { path: '/menu', element: <h1>Customer menu</h1> },
          { path: '/login', element: <LoginPage /> },
          adminRoutes,
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

async function signIn(): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), 'admin@example.test');
  await user.type(screen.getByLabelText('Password'), 'synthetic password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('administrator authentication routes and guard', () => {
  it('renders the public login route when no token is stored', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    const { router } = renderAdminRoute('/admin/login');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      '/admin',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('redirects an unauthenticated protected route to login', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const { router } = renderAdminRoute('/admin');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      '/admin',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validates a stored token before rendering protected content', async () => {
    storeToken();
    const response = new Promise<Response>(() => undefined);
    const stub = installFetchStub({ responsePromise: response });

    renderAdminRoute('/admin');

    expect(
      await screen.findByRole('heading', { name: 'Checking your session' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Administrator workspace')).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe('/api/v1/auth/me');
  });

  it.each([
    ['admin', ME_RESPONSE],
    ['super_admin', SUPER_ADMIN_ME_RESPONSE],
  ])(
    'renders AdminShell and the safe %s profile after successful /me validation',
    async (role, profile) => {
      storeToken();
      installFetchStub({ json: profile }, { json: EMPTY_ORDERS_RESPONSE });
      const user = userEvent.setup();

      renderAdminRoute('/admin');

      expect(
        await screen.findByRole('heading', { name: 'Administrator workspace' }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'Manage orders, menu availability, analytics, and CSV exports from the administrator tools.',
        ),
      ).toBeVisible();
      expect(
        screen.queryByText(/Operational screens will be added/i),
      ).not.toBeInTheDocument();
      expect(screen.getByText('admin@example.test')).toBeVisible();
      expect(
        screen.getByRole('navigation', { name: 'Administrator navigation' }),
      ).toBeInTheDocument();
      const brand = screen.getByRole('link', {
        name: 'Nordic Hearth',
      });
      expect(brand).toHaveAttribute('href', '/admin');
      expect(brand).not.toHaveAttribute('aria-current');
      expect(brand.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(brand.querySelector('svg')).toHaveAttribute('width', '24');
      expect(brand.querySelector('[role="img"]')).toBeNull();
      const logoutButton = screen.getByRole('button', { name: 'Log out' });
      expect(logoutButton).toHaveAttribute('data-size', 'md');
      expect(logoutButton).toHaveAttribute('data-variant', 'secondary');
      expect(logoutButton).toHaveAttribute('type', 'button');
      expect(screen.getByRole('link', { name: 'Admin home' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(document.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
      expect(screen.getByRole('link', { name: 'Orders' })).toHaveAttribute(
        'href',
        '/admin/orders',
      );
      expect(screen.getByRole('link', { name: 'Menu' })).toHaveAttribute(
        'href',
        '/admin/menu',
      );
      expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute(
        'href',
        '/admin/analytics',
      );
      expect(screen.getByRole('link', { name: 'Exports' })).toHaveAttribute(
        'href',
        '/admin/exports',
      );
      if (role === 'super_admin') {
        expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute(
          'href',
          '/admin/users',
        );
      } else {
        expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
      }
      expect(screen.queryByText(SYNTHETIC_TOKEN)).not.toBeInTheDocument();

      await user.click(screen.getByRole('link', { name: 'Orders' }));
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Orders' }),
      ).toBeVisible();
      expect(screen.getByRole('main')).toHaveFocus();
    },
  );

  it('routes an authenticated customer away from administrator content', async () => {
    storeToken();
    installFetchStub({ json: CUSTOMER_ME_RESPONSE });
    const { router } = renderAdminRoute('/admin');

    expect(
      await screen.findByRole('heading', { name: 'Customer account' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/account');
    expect(screen.queryByText('Administrator workspace')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(SYNTHETIC_TOKEN);
  });

  it('preserves the super-admin users destination through shared login', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const { router } = renderAdminRoute('/admin/users');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      '/admin/users',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes a customer away from the super-admin users page', async () => {
    storeToken();
    installFetchStub({ json: CUSTOMER_ME_RESPONSE });
    const { router } = renderAdminRoute('/admin/users');

    expect(
      await screen.findByRole('heading', { name: 'Customer account' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/account');
    expect(screen.queryByRole('heading', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('routes an ordinary admin away from the super-admin users page', async () => {
    storeToken();
    installFetchStub({ json: ME_RESPONSE });
    const { router } = renderAdminRoute('/admin/users');

    expect(
      await screen.findByRole('heading', { name: 'Administrator workspace' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/admin');
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('renders the users page only for a current super-admin', async () => {
    storeToken();
    installFetchStub({ json: SUPER_ADMIN_ME_RESPONSE }, { json: EMPTY_USERS_RESPONSE });

    renderAdminRoute('/admin/users');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Users' }),
    ).toBeVisible();
    expect(
      await screen.findByRole('heading', { name: 'No users found' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('fails closed on the users route while the session is being checked', async () => {
    storeToken();
    const pending = new Promise<Response>(() => undefined);
    const stub = installFetchStub({ responsePromise: pending });

    renderAdminRoute('/admin/users');

    expect(
      await screen.findByRole('heading', { name: 'Checking your session' }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Users' })).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(1);
  });

  it('retains the users-route session when validation is unavailable', async () => {
    storeToken();
    installFetchStub({ status: 503 });

    renderAdminRoute('/admin/users');

    expect(
      await screen.findByRole('heading', { name: 'Session validation is unavailable' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry validation' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeEnabled();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(SYNTHETIC_TOKEN);
  });

  it('clears a stored token on /me 401 and returns to login', async () => {
    storeToken();
    installFetchStub({ status: 401 });

    renderAdminRoute('/admin');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('keeps a stored token on /me 503 and retries validation explicitly', async () => {
    storeToken();
    const stub = installFetchStub({ status: 503 }, { json: ME_RESPONSE });
    const user = userEvent.setup();

    renderAdminRoute('/admin');

    expect(
      await screen.findByRole('heading', { name: 'Session validation is unavailable' }),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(SYNTHETIC_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Retry validation' }));

    expect(
      await screen.findByRole('heading', { name: 'Administrator workspace' }),
    ).toBeInTheDocument();
    expect(stub.calls).toHaveLength(2);
  });

  it('restores Retry validation focus after another temporary failure', async () => {
    storeToken();
    const stub = installFetchStub({ status: 503 }, { status: 503 });
    const user = userEvent.setup();

    renderAdminRoute('/admin');

    await user.click(await screen.findByRole('button', { name: 'Retry validation' }));

    await waitFor(() => {
      expect(stub.calls).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Retry validation' })).toHaveFocus();
    });
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(SYNTHETIC_TOKEN);
  });

  it('does not steal Retry validation focus after the user moves elsewhere', async () => {
    storeToken();
    let resolveRetry!: (response: Response) => void;
    const retryResponse = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    installFetchStub({ status: 503 }, { responsePromise: retryResponse });
    const user = userEvent.setup();

    renderAdminRoute('/admin');

    await user.click(await screen.findByRole('button', { name: 'Retry validation' }));
    render(<button type={'button'}>Persistent focus target</button>);
    const focusTarget = screen.getByRole('button', { name: 'Persistent focus target' });
    focusTarget.focus();
    expect(focusTarget).toHaveFocus();

    await act(async () => {
      resolveRetry(new Response(null, { status: 503 }));
    });

    expect(
      await screen.findByRole('button', { name: 'Retry validation' }),
    ).not.toHaveFocus();
    expect(focusTarget).toHaveFocus();
  });

  it('keeps a stored token after a /me timeout', async () => {
    vi.useFakeTimers();
    storeToken();
    installFetchStub({ waitForAbort: true });

    renderAdminRoute('/admin');
    expect(
      screen.getByRole('heading', { name: 'Checking your session' }),
    ).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
    });

    expect(
      screen.getByRole('heading', { name: 'Session validation is unavailable' }),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(SYNTHETIC_TOKEN);
  });

  it('redirects an authenticated login route to the admin root', async () => {
    storeToken();
    installFetchStub({ json: ME_RESPONSE });
    const { router } = renderAdminRoute('/admin/login');

    expect(
      await screen.findByRole('heading', { name: 'Administrator workspace' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin');
  });

  it('logs out to Home without a server request or admin continuation', async () => {
    storeToken();
    const stub = installFetchStub({ json: ME_RESPONSE });
    const user = userEvent.setup();
    const { router } = renderAdminRoute('/admin');
    await screen.findByRole('heading', { name: 'Administrator workspace' });

    await user.click(screen.getByRole('button', { name: 'Log out' }));

    expect(await screen.findByRole('heading', { name: 'Customer home' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.location.search).toBe('');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Administrator workspace' }),
    ).not.toBeInTheDocument();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(stub.calls).toHaveLength(1);
  });

  it('renders the protected orders list and marks its navigation link current', async () => {
    storeToken();
    installFetchStub({ json: ME_RESPONSE }, { json: EMPTY_ORDERS_RESPONSE });

    renderAdminRoute('/admin/orders');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Orders' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Orders' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      await screen.findByRole('heading', { name: 'No orders yet' }),
    ).toBeInTheDocument();
  });

  it('renders the protected order detail route', async () => {
    storeToken();
    installFetchStub({ json: ME_RESPONSE }, { json: ORDER_DETAIL_RESPONSE });

    renderAdminRoute(`/admin/orders/${PUBLIC_ORDER_NUMBER}`);

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: `Order ${PUBLIC_ORDER_NUMBER}`,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Order items' }),
    ).toBeInTheDocument();
  });

  it('renders the protected menu route and marks its navigation link current', async () => {
    storeToken();
    installFetchStub(
      { json: ME_RESPONSE },
      { json: EMPTY_CATEGORIES_RESPONSE },
      { json: EMPTY_MENU_ITEMS_RESPONSE },
    );

    renderAdminRoute('/admin/menu');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Menu' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Menu' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      await screen.findByRole('heading', { name: 'No categories yet' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'No menu items yet' }),
    ).toBeInTheDocument();
  });

  it('renders the protected analytics route and marks its navigation link current', async () => {
    storeToken();
    installFetchStub(
      { json: ME_RESPONSE },
      { json: EMPTY_ANALYTICS_OVERVIEW },
      { json: EMPTY_PRODUCT_ANALYTICS },
      { json: EMPTY_CATEGORY_ANALYTICS },
      { json: EMPTY_ORDER_TYPE_ANALYTICS },
    );

    renderAdminRoute('/admin/analytics');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Analytics' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByText('No paid orders in this period.')).toBeVisible();
  });

  it('renders the protected exports route and marks its navigation link current', async () => {
    storeToken();
    installFetchStub({ json: ME_RESPONSE });

    renderAdminRoute('/admin/exports');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Exports' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Exports' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it.each([
    '/admin/orders',
    `/admin/orders/${PUBLIC_ORDER_NUMBER}`,
    '/admin/menu',
    '/admin/analytics',
    '/admin/exports',
  ])('guards the unauthenticated operational route %s', async (path) => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const { router } = renderAdminRoute(path);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(path);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows a protected admin-local 404 for an unknown route', async () => {
    storeToken();
    installFetchStub({ json: ME_RESPONSE });

    renderAdminRoute('/admin/unknown');

    expect(
      await screen.findByRole('heading', { name: 'Administrator page not found' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to admin home' })).toHaveAttribute(
      'href',
      '/admin',
    );
  });

  it('does not reveal the admin-local 404 before an unauthenticated login', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    renderAdminRoute('/admin/unknown');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Administrator page not found')).not.toBeInTheDocument();
  });

  it('returns to a safe known admin deep link after login', async () => {
    installFetchStub(
      { json: LOGIN_RESPONSE },
      { json: ME_RESPONSE },
      { json: EMPTY_ORDERS_RESPONSE },
    );
    const { router } = renderAdminRoute('/login?next=%2Fadmin%2Forders');

    await signIn();

    expect(await screen.findByRole('heading', { name: 'Orders' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/orders');
  });

  it('returns a super-admin to the safe users destination after login', async () => {
    installFetchStub(
      { json: LOGIN_RESPONSE },
      { json: SUPER_ADMIN_ME_RESPONSE },
      { json: EMPTY_USERS_RESPONSE },
    );
    const { router } = renderAdminRoute('/login?next=%2Fadmin%2Fusers');

    await signIn();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Users' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/admin/users');
  });

  it.each(['https://example.invalid/admin', '//example.invalid/admin', '/admin/login'])(
    'rejects the unsafe return target %s',
    async (returnTo) => {
      installFetchStub({ json: LOGIN_RESPONSE }, { json: ME_RESPONSE });
      const { router } = renderAdminRoute(
        `/login?next=${encodeURIComponent(returnTo)}`,
      );

      await signIn();

      expect(
        await screen.findByRole('heading', { name: 'Customer account' }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe('/account');
    },
  );

  it('does not expose the future Stage 17 route', async () => {
    storeToken();
    installFetchStub({ json: ME_RESPONSE });

    renderAdminRoute('/admin/stage17');

    expect(
      await screen.findByRole('heading', { name: 'Administrator page not found' }),
    ).toBeInTheDocument();
  });
});
