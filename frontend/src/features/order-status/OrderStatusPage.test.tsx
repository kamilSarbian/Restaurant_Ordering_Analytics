import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import type { OrderStatus, OrderStatusResponse } from '../../api/types';
import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import { loadOrderAccess, saveOrderAccess } from '../checkout/orderAccessStorage';
import OrderStatusPage from './OrderStatusPage';

const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const TOKEN = 'private-guest-token-that-must-not-render';
const AUTH_TOKEN = 'private-auth-token-that-must-not-render';
const CURRENT_USER = {
  email: 'customer@example.invalid',
  id: '11111111-1111-4111-8111-111111111111',
  is_active: true,
  role: 'customer',
};

const VALID_STATUS: OrderStatusResponse = {
  created_at: '2026-08-11T15:00:00Z',
  currency: 'NOK',
  items: [
    {
      line_total_amount: 45800,
      menu_item_id: '00000000-0000-4000-8000-000000000010',
      name: 'Historical Burger',
      quantity: 2,
      unit_price_amount: 22900,
    },
    {
      line_total_amount: 7900,
      menu_item_id: '00000000-0000-4000-8000-000000000011',
      name: 'Historical Spritz',
      quantity: 1,
      unit_price_amount: 7900,
    },
  ],
  order_type: 'takeaway',
  public_order_number: PUBLIC_ORDER_NUMBER,
  status: 'created',
  subtotal_amount: 53700,
  table_number: null,
  total_amount: 53700,
  updated_at: '2026-08-11T15:05:00Z',
};

function responseFor(status: OrderStatus): OrderStatusResponse {
  return { ...VALID_STATUS, status };
}

function renderStatusPage(publicOrderNumber = PUBLIC_ORDER_NUMBER) {
  return render(
    <MemoryRouter initialEntries={[`/orders/${publicOrderNumber}/status`]}>
      <AuthProvider>
        <Routes>
          <Route
            path="/orders/:publicOrderNumber/status"
            element={<OrderStatusPage />}
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function storeAuthToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: AUTH_TOKEN, version: 1 }),
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
});

describe('OrderStatusPage', () => {
  it('shows local recovery without API access when the token is missing', () => {
    const stub = installFetchStub();

    renderStatusPage();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order status unavailable' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Browse the menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(stub.calls).toHaveLength(0);
  });

  it('shows loading, then the current status without rendering the token', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    installFetchStub({ responsePromise });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    renderStatusPage();

    expect(screen.getByRole('status')).toHaveTextContent('Loading order status…');
    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeVisible();
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
    resolveResponse?.(
      new Response(JSON.stringify(VALID_STATUS), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Order received' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Browse the menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
  });

  it('loads an authenticated owner without guest capability', async () => {
    storeAuthToken();
    const stub = installFetchStub({ json: CURRENT_USER }, { json: VALID_STATUS });

    renderStatusPage();

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Order received' }),
    ).toBeVisible();
    const statusCall = stub.calls.find((call) =>
      call.url.includes(PUBLIC_ORDER_NUMBER),
    );
    expect(statusCall?.headers.get('Authorization')).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(statusCall?.headers.has('X-Order-Access-Token')).toBe(false);
  });

  it('forwards both owner bearer and stored guest capability', async () => {
    storeAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    const stub = installFetchStub({ json: CURRENT_USER }, { json: VALID_STATUS });

    renderStatusPage();
    await screen.findByRole('heading', { level: 2, name: 'Order received' });

    const statusCall = stub.calls.find((call) =>
      call.url.includes(PUBLIC_ORDER_NUMBER),
    );
    expect(statusCall?.headers.get('Authorization')).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(statusCall?.headers.get('X-Order-Access-Token')).toBe(TOKEN);
  });

  it('does not start a guest request while session validation is pending', async () => {
    storeAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    const stub = installFetchStub({
      responsePromise: new Promise<Response>(() => undefined),
    });

    renderStatusPage();

    expect(
      await screen.findByRole('heading', { name: 'Checking your session' }),
    ).toBeVisible();
    expect(stub.calls.map((call) => call.url)).toEqual(['/api/v1/auth/me']);
  });

  it('blocks capability fallback while saved-session validation is unavailable', async () => {
    storeAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    const stub = installFetchStub({ status: 503 });

    renderStatusPage();

    expect(
      await screen.findByRole('heading', { name: 'Session validation is unavailable' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry validation' })).toBeEnabled();
    expect(stub.calls.map((call) => call.url)).toEqual(['/api/v1/auth/me']);
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBe(TOKEN);
  });

  it('invalidates an authenticated 401 without retrying as a guest', async () => {
    storeAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    const stub = installFetchStub({ json: CURRENT_USER }, { status: 401 });

    renderStatusPage();

    expect(
      await screen.findByRole('heading', { name: 'Your session expired' }),
    ).toBeVisible();
    expect(
      stub.calls.filter((call) => call.url.includes(PUBLIC_ORDER_NUMBER)),
    ).toHaveLength(1);
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBe(TOKEN);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/orders/${PUBLIC_ORDER_NUMBER}/status`)}`,
    );
  });

  it.each([
    ['created', 'Order received'],
    ['accepted', 'Accepted'],
    ['preparing', 'Preparing'],
    ['ready', 'Ready'],
    ['completed', 'Completed'],
    ['cancelled', 'Cancelled'],
  ] as const)('maps %s to the customer label %s', async (status, label) => {
    installFetchStub({ json: responseFor(status) });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);

    renderStatusPage();

    expect(await screen.findByRole('heading', { level: 2, name: label })).toBeVisible();
  });

  it('marks prior, current, and future timeline steps with text semantics', async () => {
    installFetchStub({ json: responseFor('preparing') });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    renderStatusPage();
    await screen.findByRole('heading', { level: 2, name: 'Preparing' });

    const timeline = screen.getByRole('list', { name: '' });
    const receivedStep = screen.getByText('Order received').closest('li');
    const preparingStep = within(timeline).getByText('Preparing').closest('li');
    const readyStep = within(timeline).getByText('Ready').closest('li');

    expect(receivedStep).toHaveTextContent('Completed step');
    expect(preparingStep).toHaveAttribute('aria-current', 'step');
    expect(preparingStep).toHaveTextContent('Current status');
    expect(readyStep).toHaveTextContent('Upcoming step');
  });

  it('shows cancellation as a separate current state without future progression', async () => {
    installFetchStub({ json: responseFor('cancelled') });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    renderStatusPage();

    const cancelledHeading = await screen.findByRole('heading', {
      level: 2,
      name: 'Cancelled',
    });
    expect(cancelledHeading).toBeVisible();
    const cancelledTimelineStep = screen.getByText('Current status').closest('li');
    expect(cancelledTimelineStep).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByText('Upcoming step')).not.toBeInTheDocument();
  });

  it('renders only the guest-safe order summary and server snapshot values', async () => {
    const dineIn = { ...VALID_STATUS, order_type: 'dine_in' as const, table_number: 7 };
    installFetchStub({ json: dineIn });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    renderStatusPage();

    await screen.findByRole('heading', { level: 2, name: 'Order received' });
    expect(screen.getByText('Dine-in')).toBeVisible();
    expect(screen.getByText('Table number').nextElementSibling).toHaveTextContent('7');
    expect(screen.getByText('Historical Burger')).toBeVisible();
    expect(screen.getByText('Quantity: 2')).toBeVisible();
    expect(screen.getByText('Historical Spritz')).toBeVisible();
    expect(screen.getByText('Subtotal')).toBeVisible();
    expect(screen.getByText('Total')).toBeVisible();
    expect(document.body).not.toHaveTextContent(/stripe|payment status|administrator/i);
  });

  it('keeps the current UI visible during a background refresh', async () => {
    vi.useFakeTimers();
    let resolveRefresh: ((response: Response) => void) | undefined;
    const refreshPromise = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    installFetchStub({ json: VALID_STATUS }, { responsePromise: refreshPromise });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    renderStatusPage();
    await act(async () => undefined);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Order received' }),
    ).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(
      screen.getByRole('heading', { level: 2, name: 'Order received' }),
    ).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing status…');
    resolveRefresh?.(
      new Response(JSON.stringify(responseFor('accepted')), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );
  });

  it('shows the privacy-preserving 404 message and stops retry UI', async () => {
    installFetchStub({ status: 404 });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    renderStatusPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not access this order from this session.',
    );
    expect(
      screen.queryByRole('button', { name: 'Retry status' }),
    ).not.toBeInTheDocument();
  });

  it('shows a transient error and supports immediate manual retry', async () => {
    const stub = installFetchStub(
      { error: new TypeError('offline') },
      { json: responseFor('accepted') },
    );
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    renderStatusPage();

    const retryButton = await screen.findByRole('button', { name: 'Retry status' });
    fireEvent.click(retryButton);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Accepted' }),
    ).toBeVisible();
    expect(stub.calls).toHaveLength(2);
  });

  it.each(['completed', 'cancelled'] as const)(
    'does not poll again after terminal %s',
    async (status) => {
      vi.useFakeTimers();
      const stub = installFetchStub({ json: responseFor(status) });
      saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
      renderStatusPage();
      await act(async () => undefined);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(stub.calls).toHaveLength(1);
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    },
  );
});
