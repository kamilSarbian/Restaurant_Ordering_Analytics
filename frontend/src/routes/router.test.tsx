import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryRouter,
  RouterProvider,
  type InitialEntry,
} from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import AsyncNotice from '../components/AsyncNotice';
import {
  AUTH_STORAGE_KEY,
  resetAuthMemoryForTests,
} from '../features/auth/authStorage';
import { CART_STORAGE_KEY } from '../features/cart/cartStorage';
import {
  loadOrderAccess,
  saveOrderAccess,
} from '../features/checkout/orderAccessStorage';
import { installFetchStub } from '../test/fetchStub';
import { routes } from './router';

const ROUTER_MENU = {
  categories: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Main dishes',
      description: null,
      display_order: 10,
      items: [
        {
          id: '00000000-0000-4000-8000-000000000011',
          name: 'Seasonal bowl',
          description: null,
          image_url: null,
          price_amount: 18900,
          currency: 'NOK',
          allergens: [],
          display_order: 10,
          is_available: true,
        },
      ],
    },
  ],
};

const AUTH_TOKEN = 'synthetic-router-auth-token';
const AUTH_USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ORDER_NUMBER = 'ROA-23456789ABCD';
const EMPTY_ACCOUNT_ORDERS = {
  items: [],
  limit: 50,
  offset: 0,
  total: 0,
};
const EMPTY_ADMIN_USERS = {
  items: [],
  limit: 50,
  offset: 0,
  total: 0,
};
const ACCOUNT_ORDER_DETAIL = {
  created_at: '2026-08-13T10:00:00Z',
  currency: 'NOK',
  items: [
    {
      line_total_amount: 18900,
      menu_item_id: '00000000-0000-4000-8000-000000000011',
      name: 'Seasonal bowl',
      quantity: 1,
      unit_price_amount: 18900,
    },
  ],
  order_type: 'takeaway',
  public_order_number: ACCOUNT_ORDER_NUMBER,
  status: 'created',
  subtotal_amount: 18900,
  table_number: null,
  total_amount: 18900,
  updated_at: '2026-08-13T10:05:00Z',
};

function currentUser(role: 'admin' | 'customer' | 'super_admin' = 'customer') {
  return {
    email: `${role}@example.invalid`,
    id: AUTH_USER_ID,
    is_active: true,
    role,
  };
}

function storeAuthToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: AUTH_TOKEN, version: 1 }),
  );
}

function renderRoute(initialEntry: InitialEntry) {
  const testRouter = createMemoryRouter(routes, {
    initialEntries: [initialEntry],
  });

  return { router: testRouter, ...render(<RouterProvider router={testRouter} />) };
}

describe('customer frontend routing foundation', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetAuthMemoryForTests();
    installFetchStub({ json: ROUTER_MENU });
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    resetAuthMemoryForTests();
    vi.unstubAllGlobals();
  });

  it('renders the public landing page at the application root', () => {
    renderRoute('/');

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Fresh food, ordered your way',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main-content',
    );
  });

  it('renders the local not-found page for an unknown path', () => {
    renderRoute('/missing-page');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back home' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('returns from the not-found page to the landing route', async () => {
    const user = userEvent.setup();
    renderRoute('/missing-page');

    await user.click(screen.getByRole('link', { name: 'Back home' }));

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Fresh food, ordered your way',
      }),
    ).toBeInTheDocument();
  });

  it('redirects the administrator login bookmark to the shared login route', async () => {
    const { router } = renderRoute('/admin/login');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      '/admin',
    );
    expect(
      screen.queryByRole('link', { name: 'Restaurant ordering home' }),
    ).not.toBeInTheDocument();
  });

  it('exposes one shared public login route', async () => {
    renderRoute('/login');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /role/i })).not.toBeInTheDocument();
  });

  it('guards the administrator root and does not render protected content', async () => {
    renderRoute('/admin');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Administrator workspace')).not.toBeInTheDocument();
  });

  it('renders the exact unauthenticated customer navigation in AppShell', () => {
    renderRoute('/');

    const navigation = screen.getByRole('navigation', { name: 'Customer navigation' });
    expect(within(navigation).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(within(navigation).getByRole('link', { name: 'Menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(within(navigation).getByRole('link', { name: 'Cart' })).toHaveAttribute(
      'href',
      '/cart',
    );
    expect(within(navigation).getByRole('link', { name: 'Log in' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(
      within(navigation).getByRole('link', { name: 'Create account' }),
    ).toHaveAttribute('href', '/register');
    expect(
      within(navigation).queryByRole('link', { name: 'My account' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
    expect(
      within(navigation).queryByRole('link', { name: 'Admin' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('navigation', { name: 'Administrator navigation' }),
    ).not.toBeInTheDocument();
  });

  it('logs out from the guarded account route to Home and preserves customer state', async () => {
    storeAuthToken();
    const cartRecord = JSON.stringify({ items: [], version: 1 });
    sessionStorage.setItem(CART_STORAGE_KEY, cartRecord);
    saveOrderAccess(ACCOUNT_ORDER_NUMBER, 'private-guest-access-token');
    installFetchStub({ json: currentUser('customer') }, { json: EMPTY_ACCOUNT_ORDERS });
    const user = userEvent.setup();
    const { router } = renderRoute('/account');

    const navigation = await screen.findByRole('navigation', {
      name: 'Customer navigation',
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'My orders' }),
    ).toBeVisible();
    expect(
      within(navigation).getByRole('link', { name: 'My account' }),
    ).toHaveAttribute('href', '/account');
    expect(within(navigation).getByRole('button', { name: 'Log out' })).toBeEnabled();
    expect(
      within(navigation).queryByRole('link', { name: 'Log in' }),
    ).not.toBeInTheDocument();
    expect(
      within(navigation).queryByRole('link', { name: 'Create account' }),
    ).not.toBeInTheDocument();
    expect(
      within(navigation).queryByRole('link', { name: 'Admin' }),
    ).not.toBeInTheDocument();

    await user.click(within(navigation).getByRole('button', { name: 'Log out' }));

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Fresh food, ordered your way',
      }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.location.search).toBe('');
    expect(router.state.historyAction).toBe('REPLACE');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(CART_STORAGE_KEY)).toBe(cartRecord);
    expect(loadOrderAccess(ACCOUNT_ORDER_NUMBER)).toBe('private-guest-access-token');
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'My orders' }),
    ).not.toBeInTheDocument();
    expect(within(navigation).getByRole('link', { name: 'Log in' })).toBeVisible();
  });

  it.each(['admin', 'super_admin'] as const)(
    'adds the administrator destination for an authenticated %s',
    async (role) => {
      storeAuthToken();
      installFetchStub({ json: currentUser(role) });

      renderRoute('/');

      const navigation = await screen.findByRole('navigation', {
        name: 'Customer navigation',
      });
      expect(
        await within(navigation).findByRole('link', { name: 'Admin' }),
      ).toHaveAttribute('href', '/admin');
      expect(
        within(navigation).getByRole('link', { name: 'My account' }),
      ).toHaveAttribute('href', '/account');
    },
  );

  it('provides appropriate live-region semantics for reusable notices', () => {
    render(
      <>
        <AsyncNotice title="Loading">Please wait.</AsyncNotice>
        <AsyncNotice tone="error" title="Unable to continue">
          Try again.
        </AsyncNotice>
      </>,
    );

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
  });

  it('renders the exact cart route with an empty-cart state', () => {
    renderRoute('/cart');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Your cart' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Your cart is empty.')).toBeInTheDocument();
  });

  it('shares cart state across a menu-to-cart route transition', async () => {
    const user = userEvent.setup();
    installFetchStub({ json: ROUTER_MENU }, { json: ROUTER_MENU });
    renderRoute('/menu');
    const card = await screen.findByRole('article', { name: 'Seasonal bowl' });

    await user.click(within(card).getByRole('button', { name: 'Add to cart' }));
    await user.click(screen.getByRole('link', { name: 'View cart' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your cart' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Seasonal bowl' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Seasonal bowl quantity')).toHaveTextContent('1');
  });

  it('renders the exact order checkout route without starting a request', () => {
    const publicOrderNumber = 'ROA-23456789ABCD';
    saveOrderAccess(publicOrderNumber, 'private-guest-access-token');

    renderRoute(`/orders/${publicOrderNumber}/checkout`);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order created' }),
    ).toBeInTheDocument();
    expect(screen.getByText(publicOrderNumber)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeEnabled();
    expect(screen.queryByText('private-guest-access-token')).not.toBeInTheDocument();
  });

  it('renders the neutral payment-return route without guest access', () => {
    const publicOrderNumber = 'ROA-23456789ABCD';

    renderRoute(`/orders/${publicOrderNumber}/payment-return`);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'You returned from secure checkout',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(publicOrderNumber)).toBeVisible();
  });

  it('renders the neutral checkout-cancelled route without guest access', () => {
    const publicOrderNumber = 'ROA-23456789ABCD';

    renderRoute(`/orders/${publicOrderNumber}/checkout-cancelled`);

    expect(
      screen.getByRole('heading', { level: 1, name: 'You left secure checkout' }),
    ).toBeInTheDocument();
    expect(screen.getByText(publicOrderNumber)).toBeVisible();
  });

  it('renders the protected order-status route with safe missing-token recovery', () => {
    const publicOrderNumber = 'ROA-23456789ABCD';

    renderRoute(`/orders/${publicOrderNumber}/status`);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order status unavailable' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/private-guest-access-token/i)).not.toBeInTheDocument();
  });

  it('renders the existing MenuPage only at the direct /menu route', async () => {
    installFetchStub({ json: ROUTER_MENU });

    renderRoute('/menu');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Our menu' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Fresh food, ordered your way' }),
    ).not.toBeInTheDocument();
  });

  it('renders the public registration page without a role selector', () => {
    renderRoute('/register');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Create account' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /role/i })).not.toBeInTheDocument();
  });

  it.each(['/account', `/account/orders/${ACCOUNT_ORDER_NUMBER}`])(
    'redirects unauthenticated account route %s to shared login with a safe next',
    async (path) => {
      const fetchSpy = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchSpy);
      const { router } = renderRoute(path);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/login');
      expect(new URLSearchParams(router.state.location.search).get('next')).toBe(path);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each(['customer', 'admin', 'super_admin'] as const)(
    'allows an authenticated %s to render only the personal account list',
    async (role) => {
      storeAuthToken();
      installFetchStub({ json: currentUser(role) }, { json: EMPTY_ACCOUNT_ORDERS });
      const { router } = renderRoute('/account');

      expect(
        await screen.findByRole('heading', { level: 1, name: 'My orders' }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/account');
      const navigation = screen.getByRole('navigation', {
        name: 'Customer navigation',
      });
      expect(
        within(navigation).getByRole('link', { name: 'My account' }),
      ).toHaveAttribute('href', '/account');
      if (role === 'customer') {
        expect(
          within(navigation).queryByRole('link', { name: 'Admin' }),
        ).not.toBeInTheDocument();
      } else {
        expect(within(navigation).getByRole('link', { name: 'Admin' })).toHaveAttribute(
          'href',
          '/admin',
        );
      }
    },
  );

  it('renders an authenticated personal account order detail', async () => {
    storeAuthToken();
    installFetchStub({ json: currentUser('customer') }, { json: ACCOUNT_ORDER_DETAIL });
    const { router } = renderRoute(`/account/orders/${ACCOUNT_ORDER_NUMBER}`);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Order details' }),
    ).toBeInTheDocument();
    expect(await screen.findByText(ACCOUNT_ORDER_NUMBER)).toBeVisible();
    expect(router.state.location.pathname).toBe(
      `/account/orders/${ACCOUNT_ORDER_NUMBER}`,
    );
  });

  it('fails closed while an account session is being checked', async () => {
    storeAuthToken();
    const pending = new Promise<Response>(() => undefined);
    const stub = installFetchStub({ responsePromise: pending });

    renderRoute('/account');

    expect(await screen.findByText('Checking your session')).toBeVisible();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'My orders' }),
    ).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe('/api/v1/auth/me');
  });

  it('keeps an unavailable account session retryable', async () => {
    storeAuthToken();
    const stub = installFetchStub(
      { status: 503 },
      { json: currentUser('customer') },
      { json: EMPTY_ACCOUNT_ORDERS },
    );
    const user = userEvent.setup();

    renderRoute('/account');

    expect(await screen.findByText('Session validation is unavailable')).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(AUTH_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Retry validation' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'My orders' }),
    ).toBeInTheDocument();
    expect(stub.calls).toHaveLength(3);
  });

  it('allows an unavailable account session to be cleared explicitly', async () => {
    storeAuthToken();
    installFetchStub({ status: 503 });
    const user = userEvent.setup();
    const { router } = renderRoute('/account');

    expect(await screen.findByText('Session validation is unavailable')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Log out' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      '/account',
    );
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('redirects an authenticated /register visit to the account default', async () => {
    storeAuthToken();
    installFetchStub({ json: currentUser('customer') }, { json: EMPTY_ACCOUNT_ORDERS });
    const { router } = renderRoute('/register');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'My orders' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account');
  });

  it.each(['/orders', '/checkout', '/status'])(
    'does not expose the future customer route %s',
    (path) => {
      renderRoute(path);
      expect(
        screen.getByRole('heading', { level: 1, name: 'Page not found' }),
      ).toBeInTheDocument();
    },
  );

  it('preserves the protected users destination for unauthenticated login', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const { router } = renderRoute('/admin/users');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      '/admin/users',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes an authenticated customer away from administrator content', async () => {
    storeAuthToken();
    installFetchStub({ json: currentUser('customer') }, { json: EMPTY_ACCOUNT_ORDERS });
    const { router } = renderRoute('/admin');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'My orders' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/account');
    expect(screen.queryByText('Administrator workspace')).not.toBeInTheDocument();
  });

  it('routes a customer away from super-admin user management', async () => {
    storeAuthToken();
    installFetchStub({ json: currentUser('customer') }, { json: EMPTY_ACCOUNT_ORDERS });
    const { router } = renderRoute('/admin/users');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'My orders' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/account');
    expect(screen.queryByRole('heading', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('routes an ordinary admin away from super-admin user management', async () => {
    storeAuthToken();
    installFetchStub({ json: currentUser('admin') });
    const { router } = renderRoute('/admin/users');

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Administrator workspace',
      }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/admin');
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('renders user management only for a current super administrator', async () => {
    storeAuthToken();
    installFetchStub({ json: currentUser('super_admin') }, { json: EMPTY_ADMIN_USERS });
    const { router } = renderRoute('/admin/users');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Users' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/admin/users');
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it.each([
    '/orders/ROA-23456789ABCD/cancelled',
    '/orders/ROA-23456789ABCD/payment-return/extra',
    '/orders/ROA-23456789ABCD/status/extra',
  ])('does not expose the future post-order route %s', (path) => {
    renderRoute(path);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument();
  });
});
