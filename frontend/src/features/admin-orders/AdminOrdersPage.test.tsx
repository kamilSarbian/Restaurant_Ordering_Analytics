import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { adminRoutes } from '../../routes/adminRoutes';
import { installFetchStub, type FetchStep } from '../../test/fetchStub';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import { AuthProvider } from '../auth/AuthContext';
import { fetchAdminOrders, formatAdminDate, formatAdminMoney } from './adminOrdersApi';
import styles from './AdminOrdersPage.module.css';

const SYNTHETIC_TOKEN = 'test-admin-token';
const ME_RESPONSE = {
  email: 'admin@example.test',
  id: '00000000-0000-4000-8000-000000000904',
  is_active: true,
  role: 'admin',
};
const CUSTOMER_ME_RESPONSE = { ...ME_RESPONSE, role: 'customer' };
const FIRST_ORDER = {
  public_order_number: 'ROA-23456789ABCD',
  status: 'created',
  order_type: 'dine_in',
  table_number: 7,
  total_amount: 12_550,
  currency: 'NOK',
  created_at: '2026-08-12T10:00:00+00:00',
  updated_at: '2026-08-12T10:05:00+00:00',
};
const SECOND_ORDER = {
  ...FIRST_ORDER,
  public_order_number: 'ROA-BCDEFGHJKLMN',
  status: 'accepted',
  order_type: 'takeaway',
  table_number: null,
  total_amount: 99_999,
  currency: 'USD',
  created_at: '2026-08-12T09:00:00+00:00',
  updated_at: '2026-08-12T09:15:00+00:00',
};
const STATUS_ORDERS = [
  FIRST_ORDER,
  SECOND_ORDER,
  { ...FIRST_ORDER, public_order_number: 'ROA-CDEFGHJKLMNP', status: 'preparing' },
  { ...FIRST_ORDER, public_order_number: 'ROA-DEFGHJKLMNPQ', status: 'ready' },
  {
    ...FIRST_ORDER,
    public_order_number: 'ROA-EFGHJKLMNPQR',
    status: 'completed',
    total_amount: 987_654_321,
  },
  { ...FIRST_ORDER, public_order_number: 'ROA-FGHJKLMNPQRS', status: 'cancelled' },
];

function listResponse(
  items: unknown[] = [FIRST_ORDER],
  overrides: Partial<{ limit: number; offset: number; total: number }> = {},
) {
  return {
    items,
    limit: overrides.limit ?? 50,
    offset: overrides.offset ?? 0,
    total: overrides.total ?? items.length,
  };
}

function storeToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 1 }),
  );
}

function renderOrders(
  initialEntry = '/admin/orders',
): ReturnType<typeof createMemoryRouter> {
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
    { initialEntries: [initialEntry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function getStatusBadges(label: string): HTMLElement[] {
  return screen
    .getAllByText(label)
    .map((element) => element.closest<HTMLElement>('span[data-variant]'))
    .filter((element): element is HTMLElement => element !== null);
}

function getFormattedMoney(amount: number, currency: string): HTMLElement[] {
  const expected = formatAdminMoney(amount, currency).replace(/\s/gu, ' ');
  return screen.getAllByText((content) => content.replace(/\s/gu, ' ') === expected);
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('administrator orders list', () => {
  it('uses the exact default authenticated GET and renders server-ordered safe data', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse([FIRST_ORDER, SECOND_ORDER]) },
    );

    renderOrders();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Orders' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Showing 1\u20132 of 2')).toBeInTheDocument();
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]?.url).toBe('/api/v1/admin/orders?limit=50&offset=0');
    expect(stub.calls[1]?.method).toBe('GET');
    expect(stub.calls[1]?.body).toBeNull();
    expect(stub.calls[1]?.headers.get('Authorization')).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
    expect(stub.calls[1]?.headers.has('X-Order-Access-Token')).toBe(false);

    const table = screen.getByRole('table', {
      name: 'Administrator orders, newest first',
    });
    expect(
      within(table)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([FIRST_ORDER.public_order_number, SECOND_ORDER.public_order_number]);
    expect(
      screen.getByRole('link', { name: FIRST_ORDER.public_order_number }),
    ).toHaveAttribute('href', `/admin/orders/${FIRST_ORDER.public_order_number}`);
    expect(
      screen.getByRole('link', {
        name: `View order ${FIRST_ORDER.public_order_number}`,
      }),
    ).toHaveAttribute('href', `/admin/orders/${FIRST_ORDER.public_order_number}`);
    expect(screen.getAllByText('Dine in')).not.toHaveLength(0);
    expect(screen.getAllByText('Not applicable')).not.toHaveLength(0);
    expect(getFormattedMoney(FIRST_ORDER.total_amount, 'NOK')).not.toHaveLength(0);
    expect(getFormattedMoney(SECOND_ORDER.total_amount, 'USD')).not.toHaveLength(0);
    expect(
      screen.getAllByText(formatAdminDate(FIRST_ORDER.updated_at)),
    ).not.toHaveLength(0);
    expect(screen.queryByText(/payment|stripe|paid/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/00000000-0000-4000/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /accept|cancel|prepar|ready|complete/i }),
    ).not.toBeInTheDocument();
  });

  it('maps every authoritative status to redundant semantic badge treatment', async () => {
    installFetchStub({ json: ME_RESPONSE }, { json: listResponse(STATUS_ORDERS) });

    renderOrders();
    await screen.findByText('Showing 1\u20136 of 6');

    const variants = {
      Accepted: 'info',
      Cancelled: 'danger',
      Completed: 'success',
      Created: 'neutral',
      Preparing: 'warning',
      Ready: 'info',
    } as const;
    for (const [label, variant] of Object.entries(variants)) {
      const badges = getStatusBadges(label);
      expect(badges).toHaveLength(2);
      for (const badge of badges) {
        expect(badge).toHaveAttribute('data-variant', variant);
        expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull();
      }
    }
    const readyStatusClass = styles.readyStatus;
    if (readyStatusClass === undefined) {
      throw new Error('Ready status class is unavailable');
    }
    for (const badge of getStatusBadges('Ready')) {
      expect(badge).toHaveClass(readyStatusClass);
    }
    expect(getFormattedMoney(987_654_321, 'NOK')).not.toHaveLength(0);
  });

  it('announces a stable initial loading state', async () => {
    installFetchStub(
      { json: ME_RESPONSE },
      { responsePromise: new Promise<Response>(() => undefined) },
    );

    renderOrders();

    const title = await screen.findByText('Loading orders');
    const status = title.closest<HTMLElement>('[role="status"]');
    expect(status).not.toBeNull();
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('distinguishes the unfiltered and filtered empty states', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse([]) },
      { json: listResponse([]) },
    );
    const user = userEvent.setup();

    renderOrders();

    expect(
      await screen.findByRole('heading', { name: 'No orders yet' }),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'ready');
    expect(
      await screen.findByRole('heading', { name: 'No matching orders' }),
    ).toBeInTheDocument();
    expect(stub.calls[2]?.url).toBe(
      '/api/v1/admin/orders?status=ready&limit=50&offset=0',
    );
  });

  it('hydrates supported filters and pagination from the URL', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse([SECOND_ORDER], { offset: 50, total: 51 }) },
    );
    const router = renderOrders(
      '/admin/orders?status=ready&order_type=takeaway&offset=50',
    );

    await screen.findByText('Showing 51\u201351 of 51');
    expect(screen.getByLabelText('Status')).toHaveValue('ready');
    expect(screen.getByLabelText('Order type')).toHaveValue('takeaway');
    expect(stub.calls[1]?.url).toBe(
      '/api/v1/admin/orders?status=ready&order_type=takeaway&limit=50&offset=50',
    );
    expect(router.state.location.search).toBe(
      '?status=ready&order_type=takeaway&offset=50',
    );
  });

  it('canonicalizes unsupported URL values without forwarding them', async () => {
    const stub = installFetchStub({ json: ME_RESPONSE }, { json: listResponse() });
    const router = renderOrders(
      '/admin/orders?status=invented&order_type=delivery&offset=51&sort=oldest',
    );

    await screen.findByText('Showing 1\u20131 of 1');
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(stub.calls[1]?.url).toBe('/api/v1/admin/orders?limit=50&offset=0');
    expect(stub.calls).toHaveLength(2);
  });

  it('sends one exact request per filter change and restores focus when clearing', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse() },
      { json: listResponse() },
      { json: listResponse() },
      { json: listResponse() },
    );
    const user = userEvent.setup();
    const router = renderOrders();

    await screen.findByText('Showing 1\u20131 of 1');
    const statusSelect = screen.getByLabelText('Status');
    await user.selectOptions(statusSelect, 'accepted');
    await waitFor(() => expect(stub.calls).toHaveLength(3));
    expect(stub.calls[2]?.url).toBe(
      '/api/v1/admin/orders?status=accepted&limit=50&offset=0',
    );
    expect(router.state.location.search).toBe('?status=accepted');

    await user.selectOptions(screen.getByLabelText('Order type'), 'takeaway');
    await waitFor(() => expect(stub.calls).toHaveLength(4));
    expect(stub.calls[3]?.url).toBe(
      '/api/v1/admin/orders?status=accepted&order_type=takeaway&limit=50&offset=0',
    );
    expect(router.state.location.search).toBe('?status=accepted&order_type=takeaway');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(stub.calls).toHaveLength(5));
    expect(stub.calls[4]?.url).toBe('/api/v1/admin/orders?limit=50&offset=0');
    expect(router.state.location.search).toBe('');
    expect(statusSelect).toHaveFocus();
  });

  it('retains filters across pagination and moves focus to the result summary', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse([FIRST_ORDER], { total: 51 }) },
      { json: listResponse([SECOND_ORDER], { offset: 50, total: 51 }) },
    );
    const user = userEvent.setup();
    const router = renderOrders('/admin/orders?status=ready');

    await screen.findByText('Showing 1\u20131 of 51');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const summary = await screen.findByText('Showing 51\u201351 of 51');
    expect(stub.calls[2]?.url).toBe(
      '/api/v1/admin/orders?status=ready&limit=50&offset=50',
    );
    expect(router.state.location.search).toBe('?status=ready&offset=50');
    await waitFor(() => expect(summary).toHaveFocus());
  });

  it('keeps filter intent focused when it supersedes a pending page request', async () => {
    let resolvePage: ((response: Response) => void) | undefined;
    const pageResponse = new Promise<Response>((resolve) => {
      resolvePage = resolve;
    });
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse([FIRST_ORDER], { total: 51 }) },
      { responsePromise: pageResponse },
      { json: listResponse([SECOND_ORDER]) },
    );
    const user = userEvent.setup();

    renderOrders();
    await screen.findByText('Showing 1\u20131 of 51');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(stub.calls).toHaveLength(3));
    const statusSelect = screen.getByLabelText('Status');
    await user.selectOptions(statusSelect, 'accepted');
    await screen.findByRole('link', { name: SECOND_ORDER.public_order_number });
    expect(statusSelect).toHaveFocus();
    expect(stub.calls[2]?.signal?.aborted).toBe(true);

    resolvePage?.(
      new Response(
        JSON.stringify(listResponse([FIRST_ORDER], { offset: 50, total: 51 })),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await act(async () => Promise.resolve());
    expect(statusSelect).toHaveFocus();
  });

  it('hides pagination when the authoritative result fits on one page', async () => {
    installFetchStub({ json: ME_RESPONSE }, { json: listResponse() });

    renderOrders();

    await screen.findByText('Showing 1\u20131 of 1');
    expect(
      screen.queryByRole('navigation', { name: 'Orders pagination' }),
    ).not.toBeInTheDocument();
  });

  it('distinguishes an empty later page and focuses its recovery heading', async () => {
    installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse([FIRST_ORDER], { total: 51 }) },
      { json: listResponse([], { offset: 50, total: 50 }) },
    );
    const user = userEvent.setup();

    renderOrders();
    await screen.findByText('Showing 1\u20131 of 51');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const heading = await screen.findByRole('heading', {
      name: 'No orders on this page',
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('preserves same-query rows through a failed refresh and retries exactly', async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse() },
      { responsePromise: refreshResponse },
      { json: listResponse([SECOND_ORDER]) },
    );
    const user = userEvent.setup();

    renderOrders();
    const summary = await screen.findByText('Showing 1\u20131 of 1');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'Refreshing orders' })).toBeDisabled();
    expect(
      within(screen.getByRole('status')).getByText('Refreshing current page'),
    ).toBeInTheDocument();
    expect(summary.closest('section')).toHaveAttribute('aria-busy', 'true');
    expect(
      screen.getByRole('link', { name: FIRST_ORDER.public_order_number }),
    ).toBeInTheDocument();

    resolveRefresh?.(
      new Response(JSON.stringify({ unexpected: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Orders refresh failed')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: FIRST_ORDER.public_order_number }),
    ).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Retry orders' }));
    await screen.findByRole('link', { name: SECOND_ORDER.public_order_number });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText('Showing 1\u20131 of 1')).toHaveFocus(),
    );
    expect(stub.calls.slice(1).map((call) => call.url)).toEqual([
      '/api/v1/admin/orders?limit=50&offset=0',
      '/api/v1/admin/orders?limit=50&offset=0',
      '/api/v1/admin/orders?limit=50&offset=0',
    ]);
  });

  it('returns focus to Retry orders when another retry fails', async () => {
    installFetchStub(
      { json: ME_RESPONSE },
      { error: new TypeError('offline') },
      { error: new TypeError('still offline') },
    );
    const user = userEvent.setup();

    renderOrders();
    await user.click(await screen.findByRole('button', { name: 'Retry orders' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry orders' })).toHaveFocus(),
    );
  });

  it('ignores a stale response after a filter starts a newer request', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { responsePromise: firstResponse },
      { json: listResponse([SECOND_ORDER]) },
    );
    const user = userEvent.setup();

    renderOrders();
    await screen.findByRole('heading', { level: 1, name: 'Orders' });
    await user.selectOptions(screen.getByLabelText('Status'), 'accepted');
    await screen.findByRole('link', { name: SECOND_ORDER.public_order_number });

    resolveFirst?.(
      new Response(JSON.stringify(listResponse([FIRST_ORDER])), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await act(async () => Promise.resolve());
    expect(
      screen.queryByRole('link', { name: FIRST_ORDER.public_order_number }),
    ).not.toBeInTheDocument();
    expect(stub.calls[1]?.signal?.aborted).toBe(true);
  });

  it.each<[string, FetchStep, string]>([
    ['network', { error: new TypeError('offline') }, 'could not be reached'],
    ['validation', { status: 422 }, 'filters are not valid'],
    ['service', { status: 503 }, 'temporarily unavailable'],
    ['server', { status: 500 }, 'temporarily unavailable'],
  ])('shows a safe retryable %s error', async (_kind, step, message) => {
    installFetchStub({ json: ME_RESPONSE }, step);

    renderOrders();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Unable to load orders')).toBeInTheDocument();
    expect(within(alert).getByText(new RegExp(message, 'i'))).toBeInTheDocument();
    expect(
      within(alert).getByRole('button', { name: 'Retry orders' }),
    ).toBeInTheDocument();
  });

  it('maps a request timeout to a safe connectivity state', async () => {
    vi.useFakeTimers();
    installFetchStub({ json: ME_RESPONSE }, { waitForAbort: true });

    renderOrders();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      within(screen.getByRole('status')).getByText('Loading orders'),
    ).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Unable to load orders')).toBeInTheDocument();
    expect(within(alert).getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it.each([
    { ...listResponse(), unexpected: true },
    listResponse([{ ...FIRST_ORDER, status: 'invented' }]),
    listResponse([{ ...FIRST_ORDER, created_at: '2026-08-12T10:00:00' }]),
  ])('rejects a malformed successful response', async (response) => {
    installFetchStub({ json: response });

    await expect(fetchAdminOrders(SYNTHETIC_TOKEN)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('expires the exact shared session after a list 401', async () => {
    const stub = installFetchStub({ json: ME_RESPONSE }, { status: 401 });
    const router = renderOrders();

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      '/admin/orders',
    );
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(stub.calls).toHaveLength(2);
  });

  it('refreshes identity after a list 403 and applies the customer guard', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { status: 403 },
      { json: CUSTOMER_ME_RESPONSE },
    );
    const router = renderOrders();

    expect(
      await screen.findByRole('heading', { name: 'Customer account' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account');
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[stub.calls.length - 1]?.url).toBe('/api/v1/auth/me');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBe(
      JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 1 }),
    );
  });
});
