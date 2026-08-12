import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryRouter,
  RouterProvider,
  type InitialEntry,
} from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../test/fetchStub';
import { adminRoutes } from './adminRoutes';
import { ADMIN_AUTH_STORAGE_KEY } from '../features/admin-auth/adminAuthStorage';

const SYNTHETIC_TOKEN = 'test-admin-token';
const LOGIN_RESPONSE = {
  access_token: SYNTHETIC_TOKEN,
  expires_in: 1_800,
  token_type: 'bearer',
};
const ME_RESPONSE = { email: 'admin@example.test', is_active: true };
const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const EMPTY_ORDERS_RESPONSE = { items: [], total: 0, limit: 50, offset: 0 };
const EMPTY_CATEGORIES_RESPONSE = { items: [], total: 0, limit: 50, offset: 0 };
const EMPTY_MENU_ITEMS_RESPONSE = { items: [], total: 0, limit: 50, offset: 0 };
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
    ADMIN_AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 1 }),
  );
}

function renderAdminRoute(initialEntry: InitialEntry) {
  const router = createMemoryRouter([adminRoutes], { initialEntries: [initialEntry] });
  return { router, ...render(<RouterProvider router={router} />) };
}

async function signIn(): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), 'admin@example.test');
  await user.type(screen.getByLabelText('Password'), 'synthetic password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('administrator authentication routes and guard', () => {
  it('renders the public login route when no token is stored', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    renderAdminRoute('/admin/login');

    expect(
      await screen.findByRole('heading', { name: 'Administrator sign-in' }),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('redirects an unauthenticated protected route to login', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const { router } = renderAdminRoute('/admin');

    expect(
      await screen.findByRole('heading', { name: 'Administrator sign-in' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/login');
    expect(router.state.location.state).toEqual({ returnTo: '/admin' });
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
    expect(stub.calls[0]?.url).toBe('/api/v1/admin/auth/me');
  });

  it('renders AdminShell and the safe profile after successful /me validation', async () => {
    storeToken();
    installFetchStub({ json: ME_RESPONSE });

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
    expect(screen.getByRole('link', { name: 'Admin home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
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
    expect(screen.queryByText(SYNTHETIC_TOKEN)).not.toBeInTheDocument();
  });

  it('clears a stored token on /me 401 and returns to login', async () => {
    storeToken();
    installFetchStub({ status: 401 });

    renderAdminRoute('/admin');

    expect(
      await screen.findByRole('heading', { name: 'Administrator sign-in' }),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('keeps a stored token on /me 503 and retries validation explicitly', async () => {
    storeToken();
    const stub = installFetchStub({ status: 503 }, { json: ME_RESPONSE });
    const user = userEvent.setup();

    renderAdminRoute('/admin');

    expect(
      await screen.findByRole('heading', { name: 'Session validation is unavailable' }),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toContain(SYNTHETIC_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Retry validation' }));

    expect(
      await screen.findByRole('heading', { name: 'Administrator workspace' }),
    ).toBeInTheDocument();
    expect(stub.calls).toHaveLength(2);
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
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toContain(SYNTHETIC_TOKEN);
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

  it('logs out without a server request and clears the administrator session', async () => {
    storeToken();
    const stub = installFetchStub({ json: ME_RESPONSE });
    const user = userEvent.setup();
    const { router } = renderAdminRoute('/admin');
    await screen.findByRole('heading', { name: 'Administrator workspace' });

    await user.click(screen.getByRole('button', { name: 'Log out' }));

    expect(router.state.location.pathname).toBe('/admin/login');
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toBeNull();
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

    expect(
      await screen.findByRole('heading', { name: 'Administrator sign-in' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/login');
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

    expect(
      await screen.findByRole('heading', { name: 'Administrator sign-in' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Administrator page not found')).not.toBeInTheDocument();
  });

  it('returns to a safe admin deep link after login', async () => {
    installFetchStub({ json: LOGIN_RESPONSE }, { json: ME_RESPONSE });
    const { router } = renderAdminRoute('/admin/unknown');

    await signIn();

    expect(
      await screen.findByRole('heading', { name: 'Administrator page not found' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/unknown');
  });

  it.each(['https://example.invalid/admin', '//example.invalid/admin', '/admin/login'])(
    'rejects the unsafe return target %s',
    async (returnTo) => {
      installFetchStub({ json: LOGIN_RESPONSE }, { json: ME_RESPONSE });
      const { router } = renderAdminRoute({
        pathname: '/admin/login',
        state: { returnTo },
      });

      await signIn();

      expect(
        await screen.findByRole('heading', { name: 'Administrator workspace' }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/admin');
    },
  );

  it.each(['/admin/users', '/stage17'])(
    'does not expose the future route %s',
    async (path) => {
      storeToken();
      installFetchStub({ json: ME_RESPONSE });

      renderAdminRoute(path.startsWith('/admin') ? path : '/admin/stage17');

      expect(
        await screen.findByRole('heading', { name: 'Administrator page not found' }),
      ).toBeInTheDocument();
    },
  );
});
