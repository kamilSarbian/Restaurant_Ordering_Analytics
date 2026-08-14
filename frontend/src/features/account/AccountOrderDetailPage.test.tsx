import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import type { OrderStatusResponse } from '../../api/types';
import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import OrderStatusSummary, {
  formatCustomerDate,
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
      line_total_amount: 45800,
      menu_item_id: '00000000-0000-4000-8000-000000000010',
      name: 'Historical Burger',
      quantity: 2,
      unit_price_amount: 22900,
    },
  ],
  order_type: 'takeaway',
  public_order_number: PUBLIC_ORDER_NUMBER,
  status: 'ready',
  subtotal_amount: 45800,
  table_number: null,
  total_amount: 45800,
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
    expect(screen.getByRole('link', { name: 'Back to my orders' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads one safe detail with exact Bearer authority and deterministic values', async () => {
    storeToken();
    const stub = installFetchStub({ json: CURRENT_USER }, { json: VALID_ORDER });

    renderDetail();

    expect(await screen.findByText('Loading order details…')).toBeVisible();
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Ready' }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Order details' }),
    ).toBeVisible();
    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeVisible();
    expect(screen.getByText('Historical Burger')).toBeVisible();
    expect(screen.getAllByText(/458,00/)).toHaveLength(3);
    expect(screen.getByText(formatCustomerDate(VALID_ORDER.created_at))).toBeVisible();
    expect(screen.getByText(formatCustomerDate(VALID_ORDER.updated_at))).toBeVisible();

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

  it('keeps the shared summary presentation-only', () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    render(<OrderStatusSummary order={VALID_ORDER} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Ready' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Order summary' })).toBeVisible();
    expect(screen.getByText('Historical Burger')).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
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
    'keeps the session and retries a %s failure explicitly',
    async (_kind, step) => {
      storeToken();
      const stub = installFetchStub({ json: CURRENT_USER }, step, {
        json: VALID_ORDER,
      });
      const user = userEvent.setup();

      renderDetail();

      const retry = await screen.findByRole('button', { name: 'Retry order details' });
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(ACCESS_TOKEN);
      await user.click(retry);

      expect(
        await screen.findByRole('heading', { level: 2, name: 'Ready' }),
      ).toBeVisible();
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(ACCESS_TOKEN);
      expect(
        stub.calls.filter((call) => call.url.includes('/api/v1/account/orders/')),
      ).toHaveLength(2);
    },
  );

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
    expect(
      screen.getByText('The order response could not be used safely.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Retry order details' }),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(USER_ID);
  });
});
