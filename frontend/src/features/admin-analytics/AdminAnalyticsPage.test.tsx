import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import { adminRoutes } from '../../routes/adminRoutes';
import { installFetchStub, type FetchStep } from '../../test/fetchStub';
import { AuthProvider } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import {
  addCalendarDays,
  buildAdminAwareDateRange,
} from '../../components/admin/adminDateRange';

const TOKEN = 'synthetic-analytics-admin-token';
const ME = {
  email: 'analytics-admin@example.test',
  id: '00000000-0000-4000-8000-000000000901',
  is_active: true,
  role: 'admin',
};
const CUSTOMER_ME = { ...ME, role: 'customer' };
const FIXED_NOW = new Date('2026-08-12T12:00:00+02:00');
const RANGE = {
  end: '2026-08-13T00:00:00+02:00',
  start: '2026-08-06T00:00:00+02:00',
  timezone: 'Europe/Oslo',
};
const PRODUCT_ID = '00000000-0000-4000-8000-000000000301';

function overview(currencies: Record<string, unknown>[] = []) {
  return { currencies, range: RANGE };
}

function products(items: Record<string, unknown>[] = [], limit = 50) {
  return { items, limit_per_currency: limit, range: RANGE };
}

function categories(items: Record<string, unknown>[] = [], limit = 50) {
  return { items, limit_per_currency: limit, range: RANGE };
}

function orderTypes(items: Record<string, unknown>[] = []) {
  return { items, range: RANGE };
}

function emptyAnalyticsSteps(limit = 50): FetchStep[] {
  return [
    { json: overview() },
    { json: products([], limit) },
    { json: categories([], limit) },
    { json: orderTypes() },
  ];
}

function storeToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: TOKEN, version: 1 }),
  );
}

function renderAnalytics(): ReturnType<typeof createMemoryRouter> {
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
    { initialEntries: ['/admin/analytics'] },
  );
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  return router;
}

function queryFor(url: string): URLSearchParams {
  return new URL(url, 'http://analytics.test').searchParams;
}

function deferredJsonResponse(): {
  promise: Promise<Response>;
  resolve: (body: unknown) => void;
} {
  let resolveResponse!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  return {
    promise,
    resolve: (body) =>
      resolveResponse(
        new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
  };
}

async function waitForInitialAnalytics(): Promise<void> {
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Analytics' }),
  ).toBeVisible();
  await screen.findByText('No paid orders in this period.');
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

describe('administrator analytics filters and transport', () => {
  it('loads exactly four authenticated endpoints with the default seven Oslo calendar days', async () => {
    const stub = installFetchStub({ json: ME }, ...emptyAnalyticsSteps());
    renderAnalytics();

    expect(
      screen.getByRole('heading', { name: 'Checking your session' }),
    ).toBeVisible();
    await waitForInitialAnalytics();
    expect(
      within(
        screen.getByRole('region', { name: 'Applied analytics context' }),
      ).getByText('Europe/Oslo'),
    ).toBeVisible();
    expect(stub.calls).toHaveLength(5);
    expect(
      stub.calls.slice(1).map((call) => new URL(call.url, 'http://x').pathname),
    ).toEqual([
      '/api/v1/admin/analytics/overview',
      '/api/v1/admin/analytics/products',
      '/api/v1/admin/analytics/categories',
      '/api/v1/admin/analytics/order-types',
    ]);
    expect(
      stub.calls
        .slice(1)
        .every((call) => call.headers.get('Authorization') === `Bearer ${TOKEN}`),
    ).toBe(true);

    const startDate = (screen.getByLabelText('Start date') as HTMLInputElement).value;
    const endDate = (screen.getByLabelText('End date') as HTMLInputElement).value;
    expect(addCalendarDays(startDate, 6)).toBe(endDate);
    const aware = buildAdminAwareDateRange({ startDate, endDate });
    for (const call of stub.calls.slice(1)) {
      expect(queryFor(call.url).get('start')).toBe(aware.start);
      expect(queryFor(call.url).get('end')).toBe(aware.end);
      expect(queryFor(call.url).has('currency')).toBe(false);
    }
    expect(queryFor(stub.calls[1]!.url).has('limit')).toBe(false);
    expect(queryFor(stub.calls[2]!.url).get('limit')).toBe('50');
    expect(queryFor(stub.calls[3]!.url).get('limit')).toBe('50');
    expect(queryFor(stub.calls[4]!.url).has('limit')).toBe(false);
  });

  it('applies uppercase currency and a shared breakdown limit, then refreshes the applied filters', async () => {
    const stub = installFetchStub(
      { json: ME },
      ...emptyAnalyticsSteps(),
      ...emptyAnalyticsSteps(7),
      ...emptyAnalyticsSteps(7),
    );
    const user = userEvent.setup();
    renderAnalytics();
    await waitForInitialAnalytics();

    await user.type(screen.getByLabelText('Currency (optional)'), 'eur');
    await user.clear(screen.getByLabelText('Breakdown limit'));
    await user.type(screen.getByLabelText('Breakdown limit'), '7');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(stub.calls).toHaveLength(9));
    expect(screen.getByLabelText('Currency (optional)')).toHaveValue('EUR');
    for (const call of stub.calls.slice(5, 9)) {
      expect(queryFor(call.url).get('currency')).toBe('EUR');
    }
    expect(queryFor(stub.calls[5]!.url).has('limit')).toBe(false);
    expect(queryFor(stub.calls[6]!.url).get('limit')).toBe('7');
    expect(queryFor(stub.calls[7]!.url).get('limit')).toBe('7');
    expect(queryFor(stub.calls[8]!.url).has('limit')).toBe(false);

    await user.clear(screen.getByLabelText('Currency (optional)'));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(stub.calls).toHaveLength(13));
    for (const call of stub.calls.slice(9, 13)) {
      expect(queryFor(call.url).get('currency')).toBe('EUR');
    }
  });

  it('changes draft presets without requesting or changing the applied indicator', async () => {
    const stub = installFetchStub({ json: ME }, ...emptyAnalyticsSteps());
    const user = userEvent.setup();
    renderAnalytics();
    await waitForInitialAnalytics();

    const endDate = (screen.getByLabelText('End date') as HTMLInputElement).value;
    const sevenDays = screen.getByRole('button', { name: '7 days' });
    const thirtyDays = screen.getByRole('button', { name: '30 days' });
    const ninetyDays = screen.getByRole('button', { name: '90 days' });
    expect(sevenDays).toHaveAttribute('aria-pressed', 'true');
    expect(thirtyDays).toHaveAttribute('aria-pressed', 'false');

    await user.click(thirtyDays);
    expect(screen.getByLabelText('Start date')).toHaveValue(
      addCalendarDays(endDate, -29),
    );
    expect(thirtyDays).toHaveAttribute('aria-pressed', 'false');
    expect(sevenDays).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('Changes not applied').length).toBeGreaterThan(0);
    expect(stub.calls).toHaveLength(5);

    await user.click(ninetyDays);
    expect(screen.getByLabelText('Start date')).toHaveValue(
      addCalendarDays(endDate, -89),
    );
    expect(ninetyDays).toHaveAttribute('aria-pressed', 'false');
    expect(stub.calls).toHaveLength(5);

    await user.click(sevenDays);
    expect(screen.queryByText('Changes not applied')).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(5);
  });

  it('keeps old applied data visible and commits a successful Apply atomically', async () => {
    const nextOverview = deferredJsonResponse();
    const nextProducts = deferredJsonResponse();
    const nextCategories = deferredJsonResponse();
    const nextOrderTypes = deferredJsonResponse();
    const stub = installFetchStub(
      { json: ME },
      {
        json: overview([
          {
            average_order_value_amount: 700,
            collected_revenue_amount: 700,
            currency: 'EUR',
            succeeded_orders_count: 1,
          },
        ]),
      },
      {
        json: products([
          {
            currency: 'EUR',
            item_name: 'Previous product',
            menu_item_id: PRODUCT_ID,
            quantity_sold: 1,
            sales_amount: 700,
          },
        ]),
      },
      { json: categories() },
      { json: orderTypes() },
      { responsePromise: nextOverview.promise },
      { responsePromise: nextProducts.promise },
      { responsePromise: nextCategories.promise },
      { responsePromise: nextOrderTypes.promise },
    );
    const user = userEvent.setup();
    renderAnalytics();
    expect((await screen.findAllByText('Previous product'))[0]).toBeVisible();
    const context = screen.getByRole('region', {
      name: 'Applied analytics context',
    });
    expect(within(context).getByText(/All returned currencies/)).toBeVisible();

    await user.type(screen.getByLabelText('Currency (optional)'), 'nok');
    expect(screen.getAllByText('Changes not applied').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(
      screen.getByRole('button', { name: 'Applying analytics filters' }),
    ).toBeDisabled();
    expect(screen.getAllByText('Previous product')[0]).toBeVisible();
    expect(within(context).getByText(/All returned currencies/)).toBeVisible();

    nextOverview.resolve(
      overview([
        {
          average_order_value_amount: 900,
          collected_revenue_amount: 900,
          currency: 'NOK',
          succeeded_orders_count: 1,
        },
      ]),
    );
    nextProducts.resolve(
      products([
        {
          currency: 'NOK',
          item_name: 'New product',
          menu_item_id: '00000000-0000-4000-8000-000000000302',
          quantity_sold: 1,
          sales_amount: 900,
        },
      ]),
    );
    nextCategories.resolve(categories());
    nextOrderTypes.resolve(orderTypes());

    expect((await screen.findAllByText('New product'))[0]).toBeVisible();
    await waitFor(() => expect(context).toHaveFocus());
    expect(within(context).getByText('NOK')).toBeVisible();
    expect(screen.queryByText('Previous product')).not.toBeInTheDocument();
    expect(screen.queryByText('Changes not applied')).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(9);
    for (const call of stub.calls.slice(5, 9)) {
      expect(queryFor(call.url).get('currency')).toBe('NOK');
    }
  });

  it('preserves previous applied context and data when a changed Apply partly fails', async () => {
    const previousOverview = overview([
      {
        average_order_value_amount: 700,
        collected_revenue_amount: 700,
        currency: 'EUR',
        succeeded_orders_count: 1,
      },
    ]);
    const previousProducts = products([
      {
        currency: 'EUR',
        item_name: 'Preserved product',
        menu_item_id: PRODUCT_ID,
        quantity_sold: 1,
        sales_amount: 700,
      },
    ]);
    const stub = installFetchStub(
      { json: ME },
      { json: previousOverview },
      { json: previousProducts },
      { json: categories() },
      { json: orderTypes() },
      {
        json: overview([
          {
            average_order_value_amount: 900,
            collected_revenue_amount: 900,
            currency: 'NOK',
            succeeded_orders_count: 1,
          },
        ]),
      },
      { json: { ...products(), unexpected: true } },
      { json: categories() },
      { json: orderTypes() },
      { json: previousOverview },
      { json: previousProducts },
      { json: categories() },
      { json: orderTypes() },
    );
    const user = userEvent.setup();
    renderAnalytics();
    expect((await screen.findAllByText('Preserved product'))[0]).toBeVisible();

    await user.type(screen.getByLabelText('Currency (optional)'), 'nok');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    const failureTitle = await screen.findByText('Filters not applied');
    expect(failureTitle).toBeVisible();
    const failureFeedback = failureTitle.closest('[tabindex]');
    expect(failureFeedback).not.toBeNull();
    expect(failureFeedback).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(failureFeedback).toHaveFocus());
    expect(
      screen.getByText(/Previous results and applied context are unchanged/),
    ).toBeVisible();
    expect(screen.getByText(/unexpected response/i)).toBeVisible();

    const context = screen.getByRole('region', {
      name: 'Applied analytics context',
    });
    expect(within(context).getByText(/All returned currencies/)).toBeVisible();
    expect(within(context).queryByText('NOK')).not.toBeInTheDocument();
    expect(screen.getAllByText('Preserved product')[0]).toBeVisible();
    expect(screen.getAllByText('Changes not applied').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(stub.calls).toHaveLength(13));
    for (const call of stub.calls.slice(9, 13)) {
      expect(queryFor(call.url).has('currency')).toBe(false);
    }
    expect(screen.queryByText('Filters not applied')).not.toBeInTheDocument();
  });

  it('blocks reversed dates, invalid currency, and invalid limit without API calls and focuses first errors', async () => {
    const stub = installFetchStub({ json: ME }, ...emptyAnalyticsSteps());
    const user = userEvent.setup();
    renderAnalytics();
    await waitForInitialAnalytics();
    const initialCalls = stub.calls.length;

    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-08-20');
    await user.clear(screen.getByLabelText('End date'));
    await user.type(screen.getByLabelText('End date'), '2026-08-12');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByText(/same as or after start date/i)).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText(/^End date/)).toHaveFocus());

    await user.clear(screen.getByLabelText(/^Start date/));
    await user.type(screen.getByLabelText(/^Start date/), '2026-08-06');
    await user.clear(screen.getByLabelText(/^Currency/));
    await user.type(screen.getByLabelText(/^Currency/), 'N1');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByText(/three uppercase ASCII letters/i)).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText(/^Currency/)).toHaveFocus());

    await user.clear(screen.getByLabelText(/^Currency/));
    await user.clear(screen.getByLabelText(/^Breakdown limit/));
    await user.type(screen.getByLabelText(/^Breakdown limit/), '101');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByText(/whole number from 1 to 100/i)).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText(/^Breakdown limit/)).toHaveFocus(),
    );
    expect(stub.calls).toHaveLength(initialCalls);
  });

  it('shows initial loading states while all endpoint requests are pending', async () => {
    const pending = new Promise<Response>(() => undefined);
    installFetchStub(
      { json: ME },
      { responsePromise: pending },
      { responsePromise: pending },
      { responsePromise: pending },
      { responsePromise: pending },
    );
    renderAnalytics();
    await screen.findByRole('heading', { level: 1, name: 'Analytics' });
    expect(await screen.findByRole('status')).toHaveTextContent('Loading analytics…');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Loading overview' })).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Loading product sales' }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Loading category sales' }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Loading order-type sales' }),
    ).toBeVisible();
  });
});

describe('administrator analytics results and resilience', () => {
  it('renders separate multi-currency KPIs and historical breakdowns in backend order', async () => {
    const stub = installFetchStub(
      { json: ME },
      {
        json: overview([
          {
            average_order_value_amount: 700,
            collected_revenue_amount: 700,
            currency: 'EUR',
            succeeded_orders_count: 1,
          },
          {
            average_order_value_amount: 250,
            collected_revenue_amount: 500,
            currency: 'NOK',
            succeeded_orders_count: 2,
          },
        ]),
      },
      {
        json: products([
          {
            currency: 'EUR',
            item_name: 'Historical Soup',
            menu_item_id: PRODUCT_ID,
            quantity_sold: 4,
            sales_amount: 700,
          },
          {
            currency: 'NOK',
            item_name: 'Historical Coffee',
            menu_item_id: '00000000-0000-4000-8000-000000000302',
            quantity_sold: 2,
            sales_amount: 500,
          },
        ]),
      },
      {
        json: categories([
          {
            category_name: 'Lunch',
            currency: 'EUR',
            quantity_sold: 4,
            sales_amount: 700,
          },
          {
            category_name: 'Drinks',
            currency: 'NOK',
            quantity_sold: 2,
            sales_amount: 500,
          },
        ]),
      },
      {
        json: orderTypes([
          {
            collected_revenue_amount: 700,
            currency: 'EUR',
            order_type: 'takeaway',
            succeeded_orders_count: 1,
          },
          {
            collected_revenue_amount: 500,
            currency: 'NOK',
            order_type: 'dine_in',
            succeeded_orders_count: 2,
          },
        ]),
      },
    );
    renderAnalytics();

    expect((await screen.findAllByText('Historical Soup'))[0]).toBeVisible();
    expect((await screen.findAllByText('Historical Coffee'))[0]).toBeVisible();
    expect((await screen.findAllByText('Lunch'))[0]).toBeVisible();
    expect((await screen.findAllByText('Drinks'))[0]).toBeVisible();
    expect((await screen.findAllByText('Takeaway'))[0]).toBeVisible();
    expect((await screen.findAllByText('Dine-in'))[0]).toBeVisible();
    expect(screen.getAllByText('EUR').length).toBeGreaterThan(1);
    expect(screen.getAllByText('NOK').length).toBeGreaterThan(1);
    const overviewRegion = screen.getByRole('region', { name: 'Overview' });
    expect(within(overviewRegion).getAllByRole('heading', { level: 3 })).toHaveLength(
      3,
    );
    expect(
      within(overviewRegion).getByRole('heading', {
        level: 3,
        name: 'Collected revenue',
      }),
    ).toBeVisible();
    expect(screen.queryByText(PRODUCT_ID)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/cost|margin|profit|market share/i),
    ).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(5);
  });

  it('keeps three successful sections when one endpoint returns 503 and recovers on Refresh', async () => {
    const stub = installFetchStub(
      { json: ME },
      { status: 503 },
      { json: products() },
      { json: categories() },
      { json: orderTypes() },
      ...emptyAnalyticsSteps(),
    );
    const user = userEvent.setup();
    renderAnalytics();

    expect(await screen.findByText(/temporarily unavailable/i)).toBeVisible();
    expect(screen.getByText('No product sales in this period.')).toBeVisible();
    expect(screen.getByText('No category sales in this period.')).toBeVisible();
    expect(screen.getByText('No order-type sales in this period.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('No paid orders in this period.');
    expect(screen.queryByText(/temporarily unavailable/i)).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(9);
  });

  it('rejects malformed success DTOs independently for all four sections', async () => {
    installFetchStub(
      { json: ME },
      { json: { ...overview(), extra: true } },
      {
        json: products([
          {
            currency: 'NOK',
            item_name: 'Invalid product',
            menu_item_id: 'not-a-uuid',
            quantity_sold: 1,
            sales_amount: 100,
          },
        ]),
      },
      {
        json: categories([
          {
            category_name: 'Invalid category',
            currency: 'NOK',
            quantity_sold: -1,
            sales_amount: 100,
          },
        ]),
      },
      {
        json: orderTypes([
          {
            collected_revenue_amount: 100,
            currency: 'NOK',
            order_type: 'delivery',
            succeeded_orders_count: 1,
          },
        ]),
      },
    );
    renderAnalytics();
    expect(await screen.findAllByText(/unexpected response/i)).toHaveLength(4);
  });

  it('maps a network failure to one section while preserving other empty results', async () => {
    installFetchStub(
      { json: ME },
      { json: overview() },
      { error: new TypeError('synthetic analytics network error') },
      { json: categories() },
      { json: orderTypes() },
    );
    renderAnalytics();
    expect(await screen.findByText(/could not reach the service/i)).toBeVisible();
    expect(screen.getByText('No paid orders in this period.')).toBeVisible();
    expect(screen.getByText('No category sales in this period.')).toBeVisible();
  });

  it('maps an endpoint timeout safely without blanking successful sections', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub(
      { json: ME },
      { waitForAbort: true },
      { json: products() },
      { json: categories() },
      { json: orderTypes() },
    );
    renderAnalytics();
    for (let cycle = 0; cycle < 10 && stub.calls.length < 5; cycle += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      });
    }
    expect(stub.calls).toHaveLength(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/could not reach the service/i)).toBeVisible();
    expect(screen.getByText('No product sales in this period.')).toBeVisible();
  });

  it('expires the administrator session when any analytics endpoint returns 401', async () => {
    installFetchStub(
      { json: ME },
      { json: overview() },
      { status: 401 },
      { json: categories() },
      { json: orderTypes() },
    );
    renderAnalytics();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('refreshes the shared identity after an analytics 403 and applies the customer guard', async () => {
    const stub = installFetchStub(
      { json: ME },
      { json: overview() },
      { status: 403 },
      { json: categories() },
      { json: orderTypes() },
      { json: CUSTOMER_ME },
    );
    const router = renderAnalytics();

    expect(
      await screen.findByRole('heading', { name: 'Customer account' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/account');
    expect(stub.calls).toHaveLength(6);
    expect(stub.calls[stub.calls.length - 1]?.url).toBe('/api/v1/auth/me');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBe(
      JSON.stringify({ accessToken: TOKEN, version: 1 }),
    );
  });

  it('blocks duplicate Apply and Refresh requests while one batch is pending', async () => {
    const pending = new Promise<Response>(() => undefined);
    const stub = installFetchStub(
      { json: ME },
      ...emptyAnalyticsSteps(),
      { responsePromise: pending },
      { responsePromise: pending },
      { responsePromise: pending },
      { responsePromise: pending },
    );
    const user = userEvent.setup();
    renderAnalytics();
    await waitForInitialAnalytics();

    await user.type(screen.getByLabelText('Currency (optional)'), 'nok');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(stub.calls).toHaveLength(9));

    const applying = screen.getByRole('button', {
      name: 'Applying analytics filters',
    });
    expect(applying).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    await user.click(applying);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(stub.calls).toHaveLength(9);
  });
});
