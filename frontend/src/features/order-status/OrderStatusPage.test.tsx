import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import type { OrderStatus, OrderStatusResponse } from '../../api/types';
import { installFetchStub } from '../../test/fetchStub';
import { saveOrderAccess } from '../checkout/orderAccessStorage';
import OrderStatusPage from './OrderStatusPage';

const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const TOKEN = 'private-guest-token-that-must-not-render';

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
      <Routes>
        <Route path="/orders/:publicOrderNumber/status" element={<OrderStatusPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
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
      '/',
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
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
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
