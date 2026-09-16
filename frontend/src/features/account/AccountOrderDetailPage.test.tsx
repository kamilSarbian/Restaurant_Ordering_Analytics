import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import type { OrderStatus, OrderStatusResponse } from '../../api/types';
import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import OrderStatusSummary, {
  formatCustomerDate,
  formatCustomerMoney,
} from '../order-status/OrderStatusSummary';
import AccountOrderDetailPage from './AccountOrderDetailPage';

const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const ACCESS_TOKEN = 'synthetic-account-detail-token';
const NEXT_ACCESS_TOKEN = 'synthetic-next-account-detail-token';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CURRENT_USER = {
  email: 'customer@example.invalid',
  id: USER_ID,
  is_active: true,
  role: 'customer',
};
const NEXT_USER = {
  ...CURRENT_USER,
  email: 'next-customer@example.invalid',
  id: '22222222-2222-4222-8222-222222222222',
};
const VALID_ORDER: OrderStatusResponse = {
  created_at: '2026-01-15T10:00:00Z',
  currency: 'NOK',
  items: [
    {
      line_total_amount: 45_800,
      menu_item_id: '00000000-0000-4000-8000-000000000010',
      name: 'Historical Burger',
      quantity: 2,
      unit_price_amount: 22_900,
    },
  ],
  order_type: 'takeaway',
  public_order_number: PUBLIC_ORDER_NUMBER,
  status: 'ready',
  subtotal_amount: 45_800,
  table_number: null,
  total_amount: 45_800,
  updated_at: '2026-01-15T10:05:00Z',
};

function storeToken(accessToken = ACCESS_TOKEN): void {
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ accessToken, version: 1 }));
}

function SessionSwitcher() {
  const { login, logout } = useAuth();
  return (
    <button
      type="button"
      onClick={() => {
        logout();
        void login('next-customer@example.invalid', 'synthetic-password');
      }}
    >
      Switch session
    </button>
  );
}

function renderDetail(
  publicOrderNumber = PUBLIC_ORDER_NUMBER,
  options: { withSessionSwitcher?: boolean } = {},
) {
  return render(
    <MemoryRouter initialEntries={[`/account/orders/${publicOrderNumber}`]}>
      <AuthProvider>
        {options.withSessionSwitcher === true && <SessionSwitcher />}
        <Routes>
          <Route
            path="/account/orders/:publicOrderNumber"
            element={<AccountOrderDetailPage />}
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function statusBadge(label: string): HTMLElement {
  return screen.getByText(label, {
    selector: 'span[data-variant] > span:last-child',
  }).parentElement as HTMLElement;
}

function expectDefinitionValue(scope: HTMLElement, label: string, value: string): void {
  const term = within(scope).getByText(label, { selector: 'dt' });
  expect(term.parentElement?.querySelector('dd')?.textContent).toBe(value);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
});

describe('AccountOrderDetailPage', () => {
  it('rejects an invalid route value locally without starting a request', () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    renderDetail('not-a-public-order-number');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order unavailable' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to orders' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads one safe detail with exact Bearer authority and deterministic values', async () => {
    storeToken();
    const stub = installFetchStub({ json: CURRENT_USER }, { json: VALID_ORDER });

    renderDetail();

    expect(await screen.findByText('Order details are on the way.')).toBeVisible();
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Ready' }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Order details' }),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Nordic Hearth', { exact: true })).toBeVisible();
    expect(
      screen.queryByRole('img', { name: 'Nordic Hearth' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeVisible();
    expect(screen.getByText('Historical Burger')).toBeVisible();
    expect(screen.getByText('Quantity: 2')).toBeVisible();
    const item = screen.getByRole('listitem');
    expectDefinitionValue(item, 'Unit price', formatCustomerMoney(22_900, 'NOK'));
    expectDefinitionValue(item, 'Line total', formatCustomerMoney(45_800, 'NOK'));
    const totals = screen.getByText('Amounts in NOK from your confirmed order.')
      .parentElement as HTMLElement;
    expectDefinitionValue(totals, 'Subtotal', formatCustomerMoney(45_800, 'NOK'));
    expectDefinitionValue(totals, 'Total', formatCustomerMoney(45_800, 'NOK'));
    expect(
      screen.getAllByText(formatCustomerDate(VALID_ORDER.created_at)),
    ).toHaveLength(2);
    expect(screen.getByText(formatCustomerDate(VALID_ORDER.updated_at))).toBeVisible();
    expect(screen.getByText('Amounts in NOK from your confirmed order.')).toBeVisible();
    expect(statusBadge('Ready')).toHaveAttribute('data-variant', 'info');
    expect(screen.getByRole('link', { name: 'Back to orders' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(screen.getByRole('link', { name: 'View menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(
      screen.queryByRole('heading', { name: 'Order timeline' }),
    ).not.toBeInTheDocument();

    const detailCall = stub.calls.find((call) =>
      call.url.endsWith(`/api/v1/account/orders/${PUBLIC_ORDER_NUMBER}`),
    );
    expect(detailCall?.method).toBe('GET');
    expect(detailCall?.headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(detailCall?.headers.has('X-Order-Access-Token')).toBe(false);
    expect(detailCall?.url).not.toContain(ACCESS_TOKEN);
    expect(document.body).not.toHaveTextContent(
      /customer@example\.invalid|owner|payment|stripe/i,
    );
    expect(stub.calls).toHaveLength(2);
  });

  it('keeps the account summary presentation-only and omits projected history', () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    render(<OrderStatusSummary order={VALID_ORDER} presentation="account-detail" />);

    expect(screen.getByRole('heading', { level: 2, name: 'Ready' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'What you ordered' })).toBeVisible();
    expect(screen.getByText('Historical Burger')).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Order timeline' }),
    ).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['accepted', 'Accepted', 'info'],
    ['cancelled', 'Cancelled', 'danger'],
    ['completed', 'Completed', 'success'],
    ['created', 'Order received', 'neutral'],
    ['preparing', 'Preparing', 'warning'],
    ['ready', 'Ready', 'info'],
  ] as const)(
    'preserves the server %s status with the %s semantic variant',
    async (status: OrderStatus, label, variant) => {
      storeToken();
      installFetchStub({ json: CURRENT_USER }, { json: { ...VALID_ORDER, status } });

      renderDetail();

      expect(
        await screen.findByRole('heading', { level: 2, name: label }),
      ).toBeVisible();
      expect(statusBadge(label)).toHaveAttribute('data-variant', variant);
      expect(
        screen
          .getByRole('heading', { level: 2, name: label })
          .closest('[data-order-status]'),
      ).toHaveAttribute('data-order-status', status);
      if (status === 'cancelled') {
        expect(statusBadge(label)).not.toHaveAttribute('data-variant', 'success');
      }
    },
  );

  it('preserves item ordering, long content, unit prices, and authoritative totals', async () => {
    storeToken();
    const firstName =
      'NordicForestMushroomBarleyFeastWithPickledShallotsRoastedJuniper'.repeat(2);
    const secondName = 'Warm apple cake';
    const order: OrderStatusResponse = {
      ...VALID_ORDER,
      items: [
        {
          line_total_amount: 25_800,
          menu_item_id: '00000000-0000-4000-8000-000000000011',
          name: firstName,
          quantity: 2,
          unit_price_amount: 12_900,
        },
        {
          line_total_amount: 15_900,
          menu_item_id: '00000000-0000-4000-8000-000000000012',
          name: secondName,
          quantity: 1,
          unit_price_amount: 15_900,
        },
      ],
      subtotal_amount: 987_654,
      total_amount: 1_234_567,
    };
    installFetchStub({ json: CURRENT_USER }, { json: order });

    renderDetail();

    await screen.findByRole('heading', { level: 2, name: 'Ready' });
    const itemList = screen.getByRole('list', { name: 'Ordered items' });
    const items = within(itemList).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const firstItem = items[0];
    const secondItem = items[1];
    if (firstItem === undefined || secondItem === undefined) {
      throw new Error('Expected two rendered order items.');
    }
    expect(firstItem).toHaveTextContent(firstName);
    expect(secondItem).toHaveTextContent(secondName);
    expectDefinitionValue(firstItem, 'Unit price', formatCustomerMoney(12_900, 'NOK'));
    expectDefinitionValue(firstItem, 'Line total', formatCustomerMoney(25_800, 'NOK'));

    const totals = screen.getByText('Amounts in NOK from your confirmed order.')
      .parentElement as HTMLElement;
    expectDefinitionValue(totals, 'Subtotal', formatCustomerMoney(987_654, 'NOK'));
    expectDefinitionValue(totals, 'Total', formatCustomerMoney(1_234_567, 'NOK'));
    expect(document.body).not.toHaveTextContent(/paid|payment|stripe/i);
  });

  it('renders one generic 404 without backend detail or ownership disclosure', async () => {
    storeToken();
    const stub = installFetchStub(
      { json: CURRENT_USER },
      { json: { detail: 'Order belongs to another user' }, status: 404 },
    );

    renderDetail();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Order unavailable' }),
    ).toBeVisible();
    expect(screen.getByText('This order is unavailable.')).toBeVisible();
    expect(document.body).not.toHaveTextContent(/belongs|another user|ownership/i);
    expect(
      screen.queryByRole('button', { name: 'Retry order details' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to orders' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(stub.calls).toHaveLength(2);
  });

  it('invalidates the exact session on 401 without anonymous or capability retry', async () => {
    storeToken();
    const stub = installFetchStub({ json: CURRENT_USER }, { status: 401 });

    renderDetail();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your session expired' }),
    ).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/account/orders/${PUBLIC_ORDER_NUMBER}`)}`,
    );
    expect(
      stub.calls.filter((call) => call.url.includes('/api/v1/account/orders/')),
    ).toHaveLength(1);
    expect(stub.calls).toHaveLength(2);
  });

  it('ignores a stale 401 after a newer session generation succeeds', async () => {
    storeToken();
    let resolveOldDetail: ((response: Response) => void) | undefined;
    const oldDetail = new Promise<Response>((resolve) => {
      resolveOldDetail = resolve;
    });
    const stub = installFetchStub(
      { json: CURRENT_USER },
      { responsePromise: oldDetail },
      {
        json: {
          access_token: NEXT_ACCESS_TOKEN,
          expires_in: 900,
          token_type: 'bearer',
        },
      },
      { json: NEXT_USER },
      { json: VALID_ORDER },
    );
    const user = userEvent.setup();

    renderDetail(PUBLIC_ORDER_NUMBER, { withSessionSwitcher: true });
    await waitFor(() => expect(stub.calls).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Switch session' }));

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Ready' }),
    ).toBeVisible();
    resolveOldDetail?.(new Response(null, { status: 401 }));
    await waitFor(() =>
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(NEXT_ACCESS_TOKEN),
    );
    expect(screen.queryByText('Your session expired')).not.toBeInTheDocument();
    expect(
      stub.calls.filter((call) => call.url.includes('/api/v1/account/orders/')),
    ).toHaveLength(2);
  });

  it.each([
    ['network', { error: new TypeError('offline details') }],
    ['service', { status: 503 }],
  ] as const)(
    'keeps the session and retries a %s failure with predictable focus',
    async (_kind, step) => {
      storeToken();
      const stub = installFetchStub({ json: CURRENT_USER }, step, {
        json: VALID_ORDER,
      });
      const user = userEvent.setup();

      renderDetail();

      const retry = await screen.findByRole('button', {
        name: 'Retry order details',
      });
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(ACCESS_TOKEN);
      await user.click(retry);

      const heading = await screen.findByRole('heading', {
        level: 1,
        name: 'Order details',
      });
      expect(
        await screen.findByRole('heading', { level: 2, name: 'Ready' }),
      ).toBeVisible();
      expect(heading).toHaveFocus();
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(ACCESS_TOKEN);
      expect(
        stub.calls.filter((call) => call.url.includes('/api/v1/account/orders/')),
      ).toHaveLength(2);
    },
  );

  it('does not steal focus moved to a connected control while retry is pending', async () => {
    storeToken();
    let resolveRetry: ((response: Response) => void) | undefined;
    const retryResponse = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    const stub = installFetchStub(
      { json: CURRENT_USER },
      { status: 503 },
      { responsePromise: retryResponse },
    );
    const user = userEvent.setup();

    renderDetail(PUBLIC_ORDER_NUMBER, { withSessionSwitcher: true });
    await user.click(
      await screen.findByRole('button', { name: 'Retry order details' }),
    );
    await waitFor(() => expect(stub.calls).toHaveLength(3));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 1, name: 'Order details' }),
      ).toHaveFocus(),
    );
    const persistentControl = screen.getByRole('button', { name: 'Switch session' });
    persistentControl.focus();
    expect(persistentControl).toHaveFocus();

    resolveRetry?.(
      new Response(JSON.stringify(VALID_ORDER), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Ready' }),
    ).toBeVisible();
    expect(persistentControl).toHaveFocus();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Order details' }),
    ).not.toHaveFocus();
  });

  it('fails closed on an invalid detail response without offering a retry loop', async () => {
    storeToken();
    installFetchStub(
      { json: CURRENT_USER },
      { json: { ...VALID_ORDER, owner_id: USER_ID } },
    );

    renderDetail();

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Unable to load order details',
      }),
    ).toBeVisible();
    expect(screen.getByText('This order cannot be displayed safely.')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Retry order details' }),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(USER_ID);
  });
});
