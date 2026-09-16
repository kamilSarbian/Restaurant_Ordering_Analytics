import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub, type FetchStep } from '../../test/fetchStub';
import { useAuth, AuthProvider } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import {
  formatCustomerDate,
  formatCustomerMoney,
} from '../order-status/OrderStatusSummary';
import AccountOrdersPage from './AccountOrdersPage';

const TOKEN = 'synthetic-account-list-token';
const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const SECOND_PUBLIC_ORDER_NUMBER = 'ROA-3456789ABCDE';

const FIRST_ORDER = {
  created_at: '2026-08-12T10:00:00+00:00',
  currency: 'NOK',
  order_type: 'dine_in',
  public_order_number: PUBLIC_ORDER_NUMBER,
  status: 'created',
  total_amount: 12_550,
  updated_at: '2026-08-12T10:05:00+00:00',
};

const SECOND_ORDER = {
  ...FIRST_ORDER,
  created_at: '2026-08-11T11:00:00+00:00',
  currency: 'USD',
  order_type: 'takeaway',
  public_order_number: SECOND_PUBLIC_ORDER_NUMBER,
  status: 'ready',
  total_amount: 2_500,
  updated_at: '2026-08-11T11:20:00+00:00',
};

function currentUser(role: 'admin' | 'customer' | 'super_admin') {
  return {
    email: `${role}@example.invalid`,
    id: '11111111-1111-4111-8111-111111111111',
    is_active: true,
    role,
  };
}

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
    JSON.stringify({ accessToken: TOKEN, version: 1 }),
  );
}

function AccountGate() {
  const { phase } = useAuth();
  if (phase === 'checking-session') {
    return <h1>Checking account session</h1>;
  }
  if (phase === 'temporarily-unavailable') {
    return <h1>Account session unavailable</h1>;
  }
  if (phase === 'unauthenticated') {
    return <h1>Signed out</h1>;
  }
  return <AccountOrdersPage />;
}

function renderOrders() {
  storeToken();
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [{ path: '/account', element: <AccountGate /> }],
      },
    ],
    { initialEntries: ['/account'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('customer account orders list', () => {
  it.each(['customer', 'admin', 'super_admin'] as const)(
    'loads the personal account page for an authenticated %s',
    async (role) => {
      const stub = installFetchStub(
        { json: currentUser(role) },
        { json: listResponse([]) },
      );

      renderOrders();

      expect(
        await screen.findByRole('heading', { level: 1, name: 'My orders' }),
      ).toBeVisible();
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      const brandName = screen.getByText('Nordic Hearth', { exact: true });
      const brandLockup = brandName.parentElement;
      expect(brandLockup).not.toBeNull();
      expect(within(brandLockup as HTMLElement).queryByRole('img')).toBeNull();
      expect(brandLockup?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(brandLockup?.querySelector('svg')).toHaveAttribute('focusable', 'false');
      expect(
        await screen.findByRole('heading', { name: 'No orders yet' }),
      ).toBeVisible();
      expect(stub.calls).toHaveLength(2);
      expect(stub.calls[1]?.url).toBe('/api/v1/account/orders?limit=50&offset=0');
      expect(stub.calls[1]?.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    },
  );

  it('renders only safe responsive order fields, formatting, and detail links', async () => {
    const stub = installFetchStub(
      { json: currentUser('customer') },
      { json: listResponse([FIRST_ORDER, SECOND_ORDER]) },
    );

    renderOrders();

    expect(await screen.findByText('Showing 1–2 of 2')).toBeVisible();
    const orders = screen.getByRole('list', {
      name: 'Your orders, newest first',
    });
    expect(screen.queryByRole('table')).toBeNull();
    expect(
      within(orders)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([FIRST_ORDER.public_order_number, SECOND_ORDER.public_order_number]);
    for (const order of [FIRST_ORDER, SECOND_ORDER]) {
      const link = within(orders).getByRole('link', {
        name: order.public_order_number,
      });
      expect(link).toHaveAttribute(
        'href',
        `/account/orders/${order.public_order_number}`,
      );
      const formattedTotal = formatCustomerMoney(order.total_amount, order.currency);
      expect(
        within(orders).getByText(
          (_content, element) =>
            element?.childElementCount === 0 && element.textContent === formattedTotal,
        ),
      ).toBeVisible();
      expect(
        within(orders).getByText(formatCustomerDate(order.created_at)),
      ).toBeVisible();
      expect(
        within(orders).getByText(formatCustomerDate(order.updated_at)),
      ).toBeVisible();
      expect(within(orders).getByText(order.currency)).toBeVisible();
    }
    expect(within(orders).getByText('Order received')).toBeVisible();
    expect(within(orders).getByText('Ready')).toBeVisible();
    expect(within(orders).getByText('Dine-in')).toBeVisible();
    expect(within(orders).getByText('Takeaway')).toBeVisible();
    expect(
      screen.queryByRole('navigation', { name: 'Your orders pagination' }),
    ).toBeNull();
    expect(document.body).not.toHaveTextContent(
      /customer_user|owner|email|phone|payment|stripe|cost|margin|guest access/i,
    );
    expect(
      screen.queryByRole('button', { name: /accept|cancel|complete/i }),
    ).toBeNull();
    expect(stub.calls[1]?.method).toBe('GET');
    expect(stub.calls[1]?.body).toBeNull();
    expect(stub.calls[1]?.headers.has('X-Order-Access-Token')).toBe(false);
    expect(stub.calls[1]?.url).not.toContain(TOKEN);
  });

  it('preserves backend order and maps every account status without payment inference', async () => {
    const statusOrders = [
      {
        ...FIRST_ORDER,
        public_order_number: 'ROA-ZZZZZZZZZZZZ',
        status: 'completed',
        total_amount: 9_876_543,
      },
      {
        ...FIRST_ORDER,
        public_order_number: 'ROA-CCCCCCCCCCCC',
        status: 'cancelled',
      },
      {
        ...FIRST_ORDER,
        public_order_number: 'ROA-PPPPPPPPPPPP',
        status: 'preparing',
      },
      {
        ...FIRST_ORDER,
        public_order_number: 'ROA-AAAAAAAAAAAA',
        status: 'accepted',
      },
      SECOND_ORDER,
      FIRST_ORDER,
    ];
    installFetchStub(
      { json: currentUser('customer') },
      { json: listResponse(statusOrders) },
    );

    renderOrders();

    const orders = await screen.findByRole('list', {
      name: 'Your orders, newest first',
    });
    expect(
      within(orders)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(statusOrders.map((order) => order.public_order_number));
    expect(
      within(orders).getByRole('link', { name: 'ROA-ZZZZZZZZZZZZ' }),
    ).toHaveAttribute('href', '/account/orders/ROA-ZZZZZZZZZZZZ');
    expect(
      within(orders).getByText(
        (_content, element) =>
          element?.childElementCount === 0 &&
          element.textContent === formatCustomerMoney(9_876_543, 'NOK'),
      ),
    ).toBeVisible();

    for (const [label, variant] of [
      ['Completed', 'success'],
      ['Cancelled', 'danger'],
      ['Preparing', 'warning'],
      ['Accepted', 'info'],
      ['Ready', 'info'],
      ['Order received', 'neutral'],
    ] as const) {
      expect(within(orders).getByText(label).closest('[data-variant]')).toHaveAttribute(
        'data-variant',
        variant,
      );
    }
    expect(
      within(orders).getByText('Cancelled').closest('[data-variant]'),
    ).not.toHaveAttribute('data-variant', 'success');
    expect(
      within(orders).getByText('Ready').closest('[data-variant]'),
    ).not.toHaveAttribute('data-variant', 'success');
    expect(document.body).not.toHaveTextContent(/paid|payment|stripe/i);
  });

  it('shows a loading state and aborts the in-flight request on unmount', async () => {
    const stub = installFetchStub(
      { json: currentUser('customer') },
      { waitForAbort: true },
    );
    const view = renderOrders();

    expect(
      await screen.findByRole('heading', { name: 'Loading your orders' }),
    ).toBeVisible();
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    expect(stub.calls[1]?.signal?.aborted).toBe(false);

    view.unmount();

    expect(stub.calls[1]?.signal?.aborted).toBe(true);
  });

  it('shows the personal empty state without pagination or polling', async () => {
    const stub = installFetchStub(
      { json: currentUser('customer') },
      { json: listResponse([]) },
    );

    renderOrders();

    expect(await screen.findByRole('heading', { name: 'No orders yet' })).toBeVisible();
    expect(
      screen.getByText('Orders placed while you are signed in will appear here.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: /menu/i })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(
      screen.queryByRole('navigation', { name: 'Your orders pagination' }),
    ).toBeNull();

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(stub.calls).toHaveLength(2);
  });

  it('uses exact offsets for Next and Previous while retry preserves the failed page', async () => {
    let resolveRetry!: (response: Response) => void;
    const pendingRetry = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    const stub = installFetchStub(
      { json: currentUser('customer') },
      { json: listResponse([FIRST_ORDER], { total: 51 }) },
      { status: 503 },
      { responsePromise: pendingRetry },
      { json: listResponse([FIRST_ORDER], { total: 51 }) },
    );
    const user = userEvent.setup();

    renderOrders();
    expect(await screen.findByText('Showing 1–1 of 51')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      await screen.findByRole('heading', { name: 'Unable to load your orders' }),
    ).toBeVisible();
    expect(stub.calls[2]?.url).toBe('/api/v1/account/orders?limit=50&offset=50');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      screen.queryByRole('heading', { name: 'Unable to load your orders' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Updating your orders while the current page stays available.'),
    ).toBeVisible();
    resolveRetry(
      new Response(
        JSON.stringify(
          listResponse([SECOND_ORDER], {
            offset: 50,
            total: 51,
          }),
        ),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(await screen.findByText('Showing 51–51 of 51')).toBeVisible();
    expect(stub.calls[3]?.url).toBe('/api/v1/account/orders?limit=50&offset=50');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Showing 1–1 of 51')).toBeVisible();
    expect(stub.calls[4]?.url).toBe('/api/v1/account/orders?limit=50&offset=0');
  });

  it('preserves focus moved elsewhere while pagination is pending', async () => {
    let resolveNextPage!: (response: Response) => void;
    const pendingNextPage = new Promise<Response>((resolve) => {
      resolveNextPage = resolve;
    });
    installFetchStub(
      { json: currentUser('customer') },
      { json: listResponse([FIRST_ORDER], { total: 51 }) },
      { responsePromise: pendingNextPage },
    );
    const user = userEvent.setup();
    const outsideFocusTarget = document.createElement('button');
    outsideFocusTarget.textContent = 'Persistent navigation target';
    document.body.append(outsideFocusTarget);

    try {
      renderOrders();
      expect(await screen.findByText(/Showing 1.+1 of 51/u)).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Next' }));
      expect(
        screen.getByText(
          'Updating your orders while the current page stays available.',
        ),
      ).toBeVisible();
      outsideFocusTarget.focus();
      expect(outsideFocusTarget).toHaveFocus();

      resolveNextPage(
        new Response(
          JSON.stringify(
            listResponse([SECOND_ORDER], {
              offset: 50,
              total: 51,
            }),
          ),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );

      expect(await screen.findByText(/Showing 51.+51 of 51/u)).toBeVisible();
      await act(async () => {
        await Promise.resolve();
      });
      expect(outsideFocusTarget).toHaveFocus();
    } finally {
      outsideFocusTarget.remove();
    }
  });

  it.each([
    ['service', { status: 503 } satisfies FetchStep, /temporarily unavailable/i],
    [
      'network',
      { error: new TypeError('private network detail') } satisfies FetchStep,
      /could not be reached/i,
    ],
  ] as const)(
    'keeps the session and retries a %s failure without guest fallback',
    async (_kind, failingStep, expectedMessage) => {
      const stub = installFetchStub({ json: currentUser('customer') }, failingStep, {
        json: listResponse([]),
      });
      const user = userEvent.setup();

      renderOrders();

      expect(
        await screen.findByRole('heading', { name: 'Unable to load your orders' }),
      ).toBeVisible();
      expect(screen.getByText(expectedMessage)).toBeVisible();
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);

      await user.click(screen.getByRole('button', { name: 'Retry' }));

      expect(
        await screen.findByRole('heading', { name: 'No orders yet' }),
      ).toBeVisible();
      expect(stub.calls).toHaveLength(3);
      expect(stub.calls[2]?.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(stub.calls[2]?.headers.has('X-Order-Access-Token')).toBe(false);
    },
  );

  it('shows a safe invalid-response error and retains the authenticated session', async () => {
    installFetchStub(
      { json: currentUser('customer') },
      { json: { ...listResponse(), unexpected_private_field: 'private detail' } },
    );

    renderOrders();

    expect(
      await screen.findByRole('heading', { name: 'Unable to load your orders' }),
    ).toBeVisible();
    expect(screen.getByText(/unexpected response/i)).toBeVisible();
    expect(document.body).not.toHaveTextContent('private detail');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
  });

  it('invalidates only the captured current session after a 401 with no retry', async () => {
    const stub = installFetchStub(
      { json: currentUser('customer') },
      {
        body: JSON.stringify({ detail: 'private authentication detail' }),
        status: 401,
      },
    );

    renderOrders();

    expect(await screen.findByRole('heading', { name: 'Signed out' })).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(document.body).not.toHaveTextContent('private authentication detail');
    expect(stub.calls).toHaveLength(2);
  });
});
