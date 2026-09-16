import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import {
  buildAdminAwareDateRange,
  getDefaultAdminDateRange,
} from '../../components/admin/adminDateRange';
import { adminRoutes } from '../../routes/adminRoutes';
import { installFetchStub } from '../../test/fetchStub';
import { formatAnalyticsMoney } from '../admin-analytics/adminAnalyticsApi';
import { AuthProvider } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';

const SYNTHETIC_TOKEN = 'stage21-f1-admin-token';
const ADMIN_ID = '00000000-0000-4000-8000-000000000901';
const CATEGORY_ID = '00000000-0000-4000-8000-000000000010';

const ADMIN_PROFILE = {
  email: 'admin@example.test',
  id: ADMIN_ID,
  is_active: true,
  role: 'admin',
};

const ORDERS = [
  {
    created_at: '2026-08-27T10:00:00+02:00',
    currency: 'NOK',
    order_type: 'dine_in',
    public_order_number: 'ROA-23456789ABCD',
    status: 'created',
    table_number: 8,
    total_amount: 25_800,
    updated_at: '2026-08-27T10:01:00+02:00',
  },
  {
    created_at: '2026-08-27T09:30:00+02:00',
    currency: 'NOK',
    order_type: 'takeaway',
    public_order_number: 'ROA-BCDEFGHJKLMN',
    status: 'ready',
    table_number: null,
    total_amount: 15_900,
    updated_at: '2026-08-27T09:44:00+02:00',
  },
  {
    created_at: '2026-08-27T08:15:00+02:00',
    currency: 'USD',
    order_type: 'takeaway',
    public_order_number: 'ROA-PQRSTUVWXYZ2',
    status: 'completed',
    table_number: null,
    total_amount: 4_275,
    updated_at: '2026-08-27T08:50:00+02:00',
  },
] as const;

function menuItem(
  index: number,
  overrides: Partial<{ is_active: boolean; is_available: boolean; name: string }> = {},
) {
  return {
    allergens: [],
    category_id: CATEGORY_ID,
    cost_amount: null,
    created_at: '2026-08-20T08:00:00+02:00',
    currency: 'NOK',
    description: null,
    display_order: index,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    image_url: null,
    is_active: overrides.is_active ?? true,
    is_available: overrides.is_available ?? true,
    name: overrides.name ?? `Menu item ${index}`,
    price_amount: 12_900 + index,
    updated_at: '2026-08-26T08:00:00+02:00',
  };
}

function ordersResponse(items: readonly unknown[] = ORDERS, total = 27) {
  return { items, limit: 6, offset: 0, total };
}

function menuResponse(items: readonly unknown[], total = items.length) {
  return { items, limit: 100, offset: 0, total };
}

function analyticsResponse(currencies: readonly unknown[] = []) {
  const range = buildAdminAwareDateRange(getDefaultAdminDateRange());
  return {
    currencies,
    range: { end: range.end, start: range.start, timezone: 'Europe/Oslo' },
  };
}

function storeToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 1 }),
  );
}

function renderHome(role: 'admin' | 'super_admin' = 'admin') {
  storeToken();
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [
          { path: '/', element: <h1>Customer home</h1> },
          { path: '/account', element: <h1>Customer account</h1> },
          { path: '/login', element: <h1>Sign in</h1> },
          adminRoutes,
        ],
      },
    ],
    { initialEntries: ['/admin'] },
  );
  render(<RouterProvider router={router} />);
  return { profile: { ...ADMIN_PROFILE, role }, router };
}

function shortcut(name: string) {
  const shortcuts = screen.getByRole('region', { name: 'Workspace shortcuts' });
  return within(shortcuts).getByRole('link', { name: new RegExp(`^${name}`, 'u') });
}

function normalizedText(value: string): (content: string) => boolean {
  const expected = value.replace(/\s/gu, ' ');
  return (content) => content.replace(/\s/gu, ' ') === expected;
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolveResponse: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  return { promise, resolve: resolveResponse };
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.unstubAllGlobals();
});

describe('administrator home dashboard', () => {
  it('uses exactly three bounded API sources and renders only their authoritative data', async () => {
    const menuItems = [
      menuItem(1),
      menuItem(2, { is_available: false, name: 'Unavailable seasonal plate' }),
    ];
    const overview = analyticsResponse([
      {
        average_order_value_amount: 18_450,
        collected_revenue_amount: 73_800,
        currency: 'NOK',
        succeeded_orders_count: 4,
      },
      {
        average_order_value_amount: 2_138,
        collected_revenue_amount: 4_275,
        currency: 'USD',
        succeeded_orders_count: 1,
      },
    ]);
    const stub = installFetchStub(
      { json: ADMIN_PROFILE },
      { json: ordersResponse() },
      { json: menuResponse(menuItems) },
      { json: overview },
    );

    renderHome();

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Administrator workspace',
      }),
    ).toBeVisible();
    expect(await screen.findByText('All orders')).toBeVisible();
    expect(screen.getByText('27')).toBeVisible();
    expect(screen.getByText('Menu items')).toBeVisible();
    expect(screen.getByText('2 recent orders need review')).toBeVisible();
    expect(screen.getByText('1 active menu item is unavailable')).toBeVisible();
    expect(
      screen.getAllByText(normalizedText(formatAnalyticsMoney(73_800, 'NOK')))[0],
    ).toBeVisible();
    expect(
      screen.getAllByText(normalizedText(formatAnalyticsMoney(4_275, 'USD')))[0],
    ).toBeVisible();
    expect(
      screen.getAllByText(normalizedText(formatAnalyticsMoney(18_450, 'NOK')))[0],
    ).toBeVisible();
    expect(
      screen.getAllByText(normalizedText(formatAnalyticsMoney(2_138, 'USD')))[0],
    ).toBeVisible();

    expect(
      screen.getByRole('link', { name: ORDERS[0].public_order_number }),
    ).toHaveAttribute('href', `/admin/orders/${ORDERS[0].public_order_number}`);
    expect(screen.getByText('Created', { selector: 'span' })).toBeVisible();
    expect(screen.getByText('Ready')).toBeVisible();
    expect(screen.getByText('Completed')).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    expect(shortcut('Orders')).toHaveAttribute('href', '/admin/orders');
    expect(shortcut('Menu')).toHaveAttribute('href', '/admin/menu');
    expect(shortcut('Analytics')).toHaveAttribute('href', '/admin/analytics');
    expect(shortcut('Exports')).toHaveAttribute('href', '/admin/exports');
    expect(screen.queryByRole('link', { name: /^Users/u })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/reservation|inventory|staffing|delivery|forecast/iu),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/payment (?:status|pending|failed|succeeded|expired)/iu),
    ).not.toBeInTheDocument();

    await waitFor(() => expect(stub.calls).toHaveLength(4));
    expect(stub.calls[1]?.url).toBe('/api/v1/admin/orders?limit=6&offset=0');
    expect(stub.calls[2]?.url).toBe('/api/v1/admin/menu/items?limit=100&offset=0');
    const analyticsUrl = new URL(stub.calls[3]?.url ?? '', 'http://test.local');
    expect(analyticsUrl.pathname).toBe('/api/v1/admin/analytics/overview');
    expect(analyticsUrl.searchParams.get('start')).toBe(overview.range.start);
    expect(analyticsUrl.searchParams.get('end')).toBe(overview.range.end);
    for (const call of stub.calls.slice(1)) {
      expect(call.method).toBe('GET');
      expect(call.headers.get('Authorization')).toBe(`Bearer ${SYNTHETIC_TOKEN}`);
      expect(call.body).toBeNull();
    }
  });

  it('renders an exact empty snapshot and preserves the super-admin-only shortcut', async () => {
    const stub = installFetchStub(
      { json: { ...ADMIN_PROFILE, role: 'super_admin' } },
      { json: ordersResponse([], 0) },
      { json: menuResponse([]) },
      { json: analyticsResponse() },
    );

    renderHome('super_admin');

    expect(
      await screen.findByText('No attention signals in the available snapshot'),
    ).toBeVisible();
    expect(screen.getByText('No orders have been created yet.')).toBeVisible();
    expect(screen.getAllByText('No paid sales')).toHaveLength(2);
    expect(
      within(screen.getByText('All orders').closest('article')!).getByText('0'),
    ).toBeVisible();
    expect(
      within(screen.getByText('Menu items').closest('article')!).getByText('0'),
    ).toBeVisible();
    expect(shortcut('Users')).toHaveAttribute('href', '/admin/users');
    expect(screen.queryByText(/payment status/iu)).not.toBeInTheDocument();
    await waitFor(() => expect(stub.calls).toHaveLength(4));
  });

  it('keeps successful sections visible and retries only a failed menu snapshot', async () => {
    const menuItems = [menuItem(1)];
    const overview = analyticsResponse([
      {
        average_order_value_amount: 12_900,
        collected_revenue_amount: 31_700,
        currency: 'NOK',
        succeeded_orders_count: 1,
      },
    ]);
    const stub = installFetchStub(
      { json: ADMIN_PROFILE },
      { json: ordersResponse([ORDERS[0]], 9) },
      { json: { items: [] } },
      { json: overview },
      { json: menuResponse(menuItems) },
    );
    const user = userEvent.setup();

    renderHome();

    expect(await screen.findByText('Menu availability unavailable')).toBeVisible();
    expect(screen.getByText('All orders')).toBeVisible();
    expect(screen.getByText('9')).toBeVisible();
    expect(
      screen.getAllByText(normalizedText(formatAnalyticsMoney(31_700, 'NOK')))[0],
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: ORDERS[0].public_order_number }),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Retry menu availability' }));

    expect(await screen.findByText('All active items available')).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Menu availability' }),
    ).toHaveFocus();
    expect(screen.queryByText('Menu availability unavailable')).not.toBeInTheDocument();
    await waitFor(() => expect(stub.calls).toHaveLength(5));
    expect(stub.calls[4]?.url).toBe('/api/v1/admin/menu/items?limit=100&offset=0');
    expect(
      stub.calls.filter((call) => call.url.startsWith('/api/v1/admin/orders?')),
    ).toHaveLength(1);
    expect(
      stub.calls.filter((call) =>
        call.url.startsWith('/api/v1/admin/analytics/overview?'),
      ),
    ).toHaveLength(1);
  });

  it('shows loading only for the failed section whose retry is active', async () => {
    const menuRetry = deferredResponse();
    const stub = installFetchStub(
      { json: ADMIN_PROFILE },
      { json: { items: [] } },
      { json: { items: [] } },
      { json: analyticsResponse() },
      { responsePromise: menuRetry.promise },
    );
    const user = userEvent.setup();

    renderHome();

    expect(await screen.findByText('Recent orders unavailable')).toBeVisible();
    expect(screen.getByText('Menu availability unavailable')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Retry menu availability' }));

    expect(
      screen.getByRole('button', { name: 'Retrying menu availability' }),
    ).toHaveAttribute('aria-busy', 'true');
    const unrelatedRetry = screen.getByRole('button', {
      name: 'Retry recent orders',
    });
    expect(unrelatedRetry).toBeDisabled();
    expect(unrelatedRetry).not.toHaveAttribute('aria-busy');

    menuRetry.resolve(
      new Response(JSON.stringify(menuResponse([menuItem(1)])), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    expect(await screen.findByText('All active items available')).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Menu availability' }),
    ).toHaveFocus();
    expect(screen.getByText('Recent orders unavailable')).toBeVisible();
    await waitFor(() => expect(stub.calls).toHaveLength(5));
    expect(stub.calls[4]?.url).toBe('/api/v1/admin/menu/items?limit=100&offset=0');
  });

  it('announces the initial loading state while real requests are active', async () => {
    installFetchStub(
      { json: ADMIN_PROFILE },
      { waitForAbort: true },
      { waitForAbort: true },
      { waitForAbort: true },
    );

    renderHome();

    expect(await screen.findByText('Loading operational snapshot')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Orders, menu availability, and the sales summary are being requested.',
    );
  });

  it('does not claim a full availability count for a catalog beyond one page', async () => {
    const stub = installFetchStub(
      { json: ADMIN_PROFILE },
      { json: ordersResponse([], 0) },
      {
        json: menuResponse(
          [menuItem(1, { is_available: false, name: 'Bounded unavailable item' })],
          101,
        ),
      },
      { json: analyticsResponse() },
    );

    renderHome();

    expect(await screen.findByText('Bounded menu snapshot')).toBeVisible();
    expect(screen.getByText(/does not issue extra page requests/iu)).toBeVisible();
    expect(
      screen.getByText('At least 1 active menu item is unavailable'),
    ).toBeVisible();
    expect(screen.getByText('1+ signal in snapshot')).toBeVisible();
    expect(
      screen.queryByText('1 active menu item is unavailable'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('1 unavailable')).not.toBeInTheDocument();
    await waitFor(() => expect(stub.calls).toHaveLength(4));
  });
});
