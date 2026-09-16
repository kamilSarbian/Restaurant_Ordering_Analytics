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
const MAX_PUBLIC_ORDER_NUMBER = 'ROA-FFFFFFFFFFFF';
const LONG_ITEM_NAME =
  'NordicForestMushroomBarleyFeastWithPickledShallotsAndRoastedJuniper'.repeat(2);
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

function renderStatusPage(publicOrderNumber = PUBLIC_ORDER_NUMBER, search = '') {
  return render(
    <MemoryRouter initialEntries={[`/orders/${publicOrderNumber}/status${search}`]}>
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
  Reflect.deleteProperty(navigator, 'onLine');
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
    expect(screen.queryByText(PUBLIC_ORDER_NUMBER)).not.toBeInTheDocument();
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
    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeVisible();
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
    ['created', 'Order received', 'neutral'],
    ['accepted', 'Accepted', 'info'],
    ['preparing', 'Preparing', 'info'],
    ['ready', 'Ready', 'info'],
    ['completed', 'Completed', 'success'],
    ['cancelled', 'Cancelled', 'danger'],
  ] as const)(
    'maps server state %s to exact label %s and %s semantics',
    async (status, label, variant) => {
      installFetchStub({ json: responseFor(status) });
      saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);

      renderStatusPage(
        PUBLIC_ORDER_NUMBER,
        '?payment_status=succeeded&redirect_status=failed&charged=true',
      );

      expect(
        await screen.findByRole('heading', { level: 2, name: label }),
      ).toBeVisible();
      const currentState = screen.getByRole('list', {
        name: 'Current order status',
      });
      const steps = within(currentState).getAllByRole('listitem');
      expect(steps).toHaveLength(1);
      expect(steps[0]).toHaveAttribute('aria-current', 'step');
      expect(steps[0]).toHaveAttribute('data-order-status', status);
      expect(
        within(steps[0]!).getByText('Current status').closest('[data-variant]'),
      ).toHaveAttribute('data-variant', variant);
      expect(document.body).not.toHaveTextContent(
        /stripe|payment status|paid|charged|succeeded|failed/i,
      );
    },
  );

  it('renders only the authoritative current state without projected history', async () => {
    installFetchStub({ json: responseFor('preparing') });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    renderStatusPage();
    await screen.findByRole('heading', { level: 2, name: 'Preparing' });

    const currentState = screen.getByRole('list', {
      name: 'Current order status',
    });
    const steps = within(currentState).getAllByRole('listitem');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
    expect(steps[0]).toHaveTextContent('Preparing');
    expect(steps[0]).toHaveTextContent('Current status');
    expect(
      screen.queryByRole('heading', { name: 'Order timeline' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Completed step')).not.toBeInTheDocument();
    expect(screen.queryByText('Upcoming step')).not.toBeInTheDocument();
    for (const projectedStatus of [
      'Order received',
      'Accepted',
      'Ready',
      'Completed',
    ]) {
      expect(within(currentState).queryByText(projectedStatus)).not.toBeInTheDocument();
    }
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
    const cancelledPanel = cancelledHeading.closest('section');
    const cancelledTimelineStep = screen.getByText('Current status').closest('li');
    expect(cancelledPanel).toHaveAttribute('data-order-status', 'cancelled');
    expect(cancelledTimelineStep).toHaveAttribute('aria-current', 'step');
    expect(cancelledTimelineStep).toHaveAttribute('data-order-status', 'cancelled');
    expect(
      within(cancelledTimelineStep!)
        .getByText('Current status')
        .closest('[data-variant]'),
    ).toHaveAttribute('data-variant', 'danger');
    expect(cancelledPanel?.querySelector('[data-variant="success"]')).toBeNull();
    expect(screen.queryByText('Upcoming step')).not.toBeInTheDocument();
  });

  it('keeps one decorative brand mark, one H1, one primary CTA, and long content', async () => {
    const longOrder = {
      ...VALID_STATUS,
      items: VALID_STATUS.items.map((item, index) =>
        index === 0 ? { ...item, name: LONG_ITEM_NAME } : item,
      ),
      public_order_number: MAX_PUBLIC_ORDER_NUMBER,
    };
    installFetchStub({ json: longOrder });
    saveOrderAccess(MAX_PUBLIC_ORDER_NUMBER, TOKEN);

    const view = renderStatusPage(MAX_PUBLIC_ORDER_NUMBER);

    const currentStatusHeading = await screen.findByRole('heading', {
      level: 2,
      name: 'Order received',
    });
    const brandName = screen.getByText('Nordic Hearth');
    expect(screen.getAllByText('Nordic Hearth')).toHaveLength(1);
    expect(brandName.parentElement?.querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const orderNumber = screen.getByText(MAX_PUBLIC_ORDER_NUMBER);
    expect(orderNumber).toBeVisible();
    expect(
      currentStatusHeading.compareDocumentPosition(orderNumber) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(LONG_ITEM_NAME)).toBeVisible();
    const primaryAction = view.container.querySelector(
      '[data-action-priority="primary"]',
    );
    expect(primaryAction).toBe(screen.getByRole('link', { name: 'Browse the menu' }));
    expect(primaryAction).toHaveAttribute('href', '/menu');
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
    const primaryAction = screen.getByRole('link', { name: 'Browse the menu' });
    const liveRegion = screen.getByRole('status');
    primaryAction.focus();
    expect(primaryAction).toHaveFocus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(
      screen.getByRole('heading', { level: 2, name: 'Order received' }),
    ).toBeVisible();
    expect(screen.getByText('Checking for the latest update…')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(screen.getAllByRole('status')).toEqual([liveRegion]);
    expect(primaryAction).toHaveFocus();
    await act(async () => {
      resolveRefresh?.(
        new Response(JSON.stringify(responseFor('accepted')), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      );
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toBe(liveRegion);
    expect(liveRegion).toHaveTextContent('Current status: Accepted');
    expect(primaryAction).toHaveFocus();
  });

  it('does not mutate or duplicate the status live region on a same-state poll', async () => {
    vi.useFakeTimers();
    let resolveRefresh: ((response: Response) => void) | undefined;
    const refreshPromise = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    installFetchStub({ json: VALID_STATUS }, { responsePromise: refreshPromise });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    renderStatusPage();
    await act(async () => undefined);

    const liveRegion = screen.getByRole('status');
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(liveRegion, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    await act(async () => {
      resolveRefresh?.(
        new Response(JSON.stringify(VALID_STATUS), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      );
      await Promise.resolve();
    });
    observer.disconnect();

    expect(screen.getAllByRole('status')).toEqual([liveRegion]);
    expect(liveRegion).toHaveTextContent('Current status: Order received');
    expect(mutations).toHaveLength(0);
  });

  it('keeps automatic-update copy truthful when valid data becomes paused', async () => {
    installFetchStub({ json: VALID_STATUS });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, TOKEN);
    renderStatusPage();
    await screen.findByRole('heading', { level: 2, name: 'Order received' });

    expect(
      screen.getByText('This page checks automatically while it is open and online.', {
        exact: true,
      }),
    ).toBeVisible();
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    act(() => window.dispatchEvent(new Event('offline')));

    expect(
      screen.getByText('Updates paused').closest('[role="status"]'),
    ).toHaveTextContent(
      'Status updates are paused while this tab is hidden or the browser is offline.',
    );
    expect(document.body).not.toHaveTextContent('Automatic updates are on.');
    Reflect.deleteProperty(navigator, 'onLine');
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
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: false,
      });
      act(() => window.dispatchEvent(new Event('offline')));
      expect(screen.queryByText('Updates paused')).not.toBeInTheDocument();
    },
  );
});
