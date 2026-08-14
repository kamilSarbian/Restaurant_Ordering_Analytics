import { act, render, screen, waitFor } from '@testing-library/react';
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
    expect(
      screen.getByRole('table', { name: 'Your orders, newest first' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Your orders, newest first' }),
    ).toBeInTheDocument();
    for (const order of [FIRST_ORDER, SECOND_ORDER]) {
      const links = screen.getAllByRole('link', { name: order.public_order_number });
      expect(links).toHaveLength(2);
      for (const link of links) {
        expect(link).toHaveAttribute(
          'href',
          `/account/orders/${order.public_order_number}`,
        );
      }
      const formattedTotal = formatCustomerMoney(order.total_amount, order.currency);
      expect(
        screen.getAllByText(
          (_content, element) =>
            element?.childElementCount === 0 && element.textContent === formattedTotal,
        ),
      ).toHaveLength(2);
      expect(screen.getAllByText(formatCustomerDate(order.created_at))).toHaveLength(2);
      expect(screen.getAllByText(formatCustomerDate(order.updated_at))).toHaveLength(2);
      expect(screen.getAllByText(order.currency)).toHaveLength(2);
    }
    expect(screen.getAllByText('Order received')).toHaveLength(2);
    expect(screen.getAllByText('Ready')).toHaveLength(2);
    expect(screen.getAllByText('Dine-in')).toHaveLength(2);
    expect(screen.getAllByText('Takeaway')).toHaveLength(2);
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
    const stub = installFetchStub(
      { json: currentUser('customer') },
      { json: listResponse([FIRST_ORDER], { total: 51 }) },
      { status: 503 },
      {
        json: listResponse([SECOND_ORDER], {
          offset: 50,
          total: 51,
        }),
      },
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
    expect(await screen.findByText('Showing 51–51 of 51')).toBeVisible();
    expect(stub.calls[3]?.url).toBe('/api/v1/account/orders?limit=50&offset=50');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Showing 1–1 of 51')).toBeVisible();
    expect(stub.calls[4]?.url).toBe('/api/v1/account/orders?limit=50&offset=0');
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
