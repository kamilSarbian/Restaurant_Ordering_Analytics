import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import {
  getOrderAccessStorageKey,
  loadOrderAccess,
} from '../checkout/orderAccessStorage';
import { CartProvider } from './CartContext';
import { useCart } from './CartContext';
import CartPage from './CartPage';
import { CART_STORAGE_KEY } from './cartStorage';

const ITEM_ID = '00000000-0000-4000-8000-000000000011';
const SECOND_ITEM_ID = '00000000-0000-4000-8000-000000000012';
const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const ACCESS_TOKEN = 'guest-access-token-private-value';
const AUTH_TOKEN = 'canonical-customer-token';
const AUTH_USER = {
  email: 'customer@example.invalid',
  id: '11111111-1111-4111-8111-111111111111',
  is_active: true,
  role: 'customer',
};

interface CapturedRequest {
  headers: Headers;
  method: string;
  url: string;
}

function seedAuthToken(accessToken = AUTH_TOKEN): void {
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ accessToken, version: 1 }));
  resetAuthMemoryForTests();
}

function installAuthenticatedCartFetch(
  options: {
    meStatus?: number | 'pending';
    orderStatus?: number;
  } = {},
): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({
      headers: new Headers(init?.headers),
      method: init?.method ?? 'GET',
      url,
    });
    if (url.endsWith('/api/v1/auth/me')) {
      if (options.meStatus === 'pending') {
        return new Promise<Response>(() => undefined);
      }
      return new Response(
        options.meStatus === undefined ? JSON.stringify(AUTH_USER) : null,
        {
          headers:
            options.meStatus === undefined
              ? { 'Content-Type': 'application/json' }
              : undefined,
          status: options.meStatus ?? 200,
        },
      );
    }
    if (url.endsWith('/api/v1/menu')) {
      return Response.json(MENU);
    }
    if (url.endsWith('/api/v1/orders/quote')) {
      return Response.json(quoteFor(1));
    }
    if (url.endsWith('/api/v1/orders')) {
      return new Response(
        options.orderStatus === undefined ? JSON.stringify(orderFor(1)) : null,
        {
          headers:
            options.orderStatus === undefined
              ? { 'Content-Type': 'application/json' }
              : undefined,
          status: options.orderStatus ?? 201,
        },
      );
    }
    throw new Error(`Unexpected test request: ${url}`);
  };
  vi.stubGlobal('fetch', vi.fn(fetchStub));
  return calls;
}

const MENU = {
  categories: [
    {
      description: null,
      display_order: 10,
      id: '00000000-0000-4000-8000-000000000001',
      items: [
        {
          allergens: [],
          currency: 'NOK',
          description: null,
          display_order: 10,
          id: ITEM_ID,
          image_url: null,
          is_available: true,
          name: 'Seasonal bowl',
          price_amount: 12900,
        },
        {
          allergens: [],
          currency: 'NOK',
          description: null,
          display_order: 20,
          id: SECOND_ITEM_ID,
          image_url: null,
          is_available: false,
          name: 'Evening special',
          price_amount: 15900,
        },
      ],
      name: 'Main dishes',
    },
  ],
};

function quoteFor(quantity: number, totalAmount = quantity * 12_900) {
  return {
    currency: 'NOK',
    items: [
      {
        line_total_amount: totalAmount,
        menu_item_id: ITEM_ID,
        name: 'Seasonal bowl snapshot',
        quantity,
        unit_price_amount: 12_900,
      },
    ],
    subtotal_amount: totalAmount,
    total_amount: totalAmount,
  };
}

function orderFor(quantity: number, totalAmount = quantity * 12_900) {
  return {
    currency: 'NOK',
    items: [
      {
        line_total_amount: totalAmount,
        menu_item_id: ITEM_ID,
        name: 'Seasonal bowl order snapshot',
        quantity,
        unit_price_amount: 12_900,
      },
    ],
    order_access_token: ACCESS_TOKEN,
    order_type: 'takeaway',
    public_order_number: PUBLIC_ORDER_NUMBER,
    status: 'created',
    subtotal_amount: totalAmount,
    table_number: null,
    total_amount: totalAmount,
  };
}

function seedCart(
  items: Array<{ menuItemId: string; quantity: number }> = [
    { menuItemId: ITEM_ID, quantity: 1 },
  ],
) {
  sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify({ items, version: 1 }));
}

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <span data-testid="current-path">
        {location.pathname}
        {location.search}
        {location.hash}
      </span>
      <span data-testid="current-state">{JSON.stringify(location.state ?? null)}</span>
    </>
  );
}

function ExternalCartMutation() {
  const { incrementItem } = useCart();
  return (
    <button type="button" onClick={() => incrementItem(ITEM_ID)}>
      External cart mutation
    </button>
  );
}

function renderCart(options: { externalMutation?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={['/cart']}>
      <AuthProvider>
        <CartProvider>
          <CartPage />
          {options.externalMutation === true && <ExternalCartMutation />}
          <LocationProbe />
        </CartProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceQuoteDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

async function renderReadyCart(
  ...additionalSteps: Parameters<typeof installFetchStub>
) {
  seedCart();
  const stub = installFetchStub(
    { json: MENU },
    { json: quoteFor(1) },
    ...additionalSteps,
  );
  renderCart();
  await flushAsyncWork();
  await advanceQuoteDebounce();
  return stub;
}

describe('CartPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    resetAuthMemoryForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    resetAuthMemoryForTests();
  });

  it('renders the empty state and never requests menu or quote', () => {
    const stub = installFetchStub();

    renderCart();

    expect(screen.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible();
    expect(screen.getByText('Your cart is empty.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse the menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(stub.calls).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /place order|checkout/i })).toBeNull();
  });

  it('hydrates persisted cart state and resolves current menu labels', async () => {
    seedCart([{ menuItemId: ITEM_ID, quantity: 2 }]);
    installFetchStub({ json: MENU });

    renderCart();
    await flushAsyncWork();

    expect(
      screen.getByRole('heading', { level: 3, name: 'Seasonal bowl' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Seasonal bowl quantity')).toHaveTextContent('2');
    expect(screen.queryByText(ITEM_ID)).not.toBeInTheDocument();
  });

  it('sends one exact quote request after the debounce and renders server values', async () => {
    seedCart([{ menuItemId: ITEM_ID, quantity: 2 }]);
    const stub = installFetchStub({ json: MENU }, { json: quoteFor(2) });
    renderCart();
    await flushAsyncWork();

    expect(stub.calls).toHaveLength(1);
    const summary = screen.getByRole('complementary', { name: 'Server quote' });
    expect(within(summary).getByRole('status')).toHaveTextContent('Updating total…');

    await advanceQuoteDebounce();

    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]).toMatchObject({
      body: JSON.stringify({
        items: [{ menu_item_id: ITEM_ID, quantity: 2 }],
      }),
      method: 'POST',
      url: '/api/v1/orders/quote',
    });
    expect(screen.getByText('Seasonal bowl snapshot × 2')).toBeInTheDocument();
    expect(screen.getAllByText(/258[,.]00/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/129[,.]00/)).toBeInTheDocument();
  });

  it('debounces a quantity change and marks the previous quote as updating', async () => {
    seedCart();
    const stub = installFetchStub(
      { json: MENU },
      { json: quoteFor(1) },
      { json: quoteFor(2) },
    );
    renderCart();
    await flushAsyncWork();
    await advanceQuoteDebounce();

    fireEvent.click(
      screen.getByRole('button', { name: 'Increase quantity for Seasonal bowl' }),
    );

    expect(
      within(screen.getByRole('complementary', { name: 'Server quote' })).getByRole(
        'status',
      ),
    ).toHaveTextContent('Previous quote — updating');
    expect(stub.calls).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(stub.calls).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[2]?.body).toBe(
      JSON.stringify({ items: [{ menu_item_id: ITEM_ID, quantity: 2 }] }),
    );
    expect(screen.getByText('Seasonal bowl snapshot × 2')).toBeInTheDocument();
  });

  it('aborts and ignores a stale response after the cart changes', async () => {
    seedCart();
    let resolveStale!: (response: Response) => void;
    const staleResponse = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    const stub = installFetchStub(
      { json: MENU },
      { responsePromise: staleResponse },
      { json: quoteFor(2, 30_000) },
    );
    renderCart();
    await flushAsyncWork();
    await advanceQuoteDebounce();
    expect(stub.calls[1]?.signal?.aborted).toBe(false);

    fireEvent.click(
      screen.getByRole('button', { name: 'Increase quantity for Seasonal bowl' }),
    );
    expect(stub.calls[1]?.signal?.aborted).toBe(true);
    await advanceQuoteDebounce();
    expect(screen.getAllByText(/300[,.]00/).length).toBeGreaterThanOrEqual(2);

    resolveStale(
      new Response(JSON.stringify(quoteFor(1)), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await flushAsyncWork();

    expect(screen.queryByText('Seasonal bowl snapshot × 1')).not.toBeInTheDocument();
    expect(screen.getByText('Seasonal bowl snapshot × 2')).toBeInTheDocument();
  });

  it('preserves the cart on a business quote error and retries manually', async () => {
    seedCart();
    const stub = installFetchStub(
      { json: MENU },
      { json: { detail: 'private' }, status: 409 },
      { json: quoteFor(1) },
    );
    renderCart();
    await flushAsyncWork();
    await advanceQuoteDebounce();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'One or more items cannot currently be quoted',
    );
    expect(
      screen.getByRole('heading', { level: 3, name: 'Seasonal bowl' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review menu' })).toHaveAttribute(
      'href',
      '/menu',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry quote' }));
    await advanceQuoteDebounce();

    expect(stub.calls).toHaveLength(3);
    expect(screen.getByText('Seasonal bowl snapshot × 1')).toBeInTheDocument();
  });

  it('removes a line explicitly and reaches the empty state', async () => {
    seedCart();
    installFetchStub({ json: MENU });
    renderCart();
    await flushAsyncWork();

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Seasonal bowl from cart' }),
    );

    expect(screen.getByText('Your cart is empty.')).toBeInTheDocument();
  });

  it('clears all cart lines immediately', async () => {
    seedCart([
      { menuItemId: ITEM_ID, quantity: 1 },
      { menuItemId: SECOND_ITEM_ID, quantity: 2 },
    ]);
    installFetchStub({ json: MENU });
    renderCart();
    await flushAsyncWork();

    fireEvent.click(screen.getByRole('button', { name: 'Clear cart' }));

    expect(screen.getByText('Your cart is empty.')).toBeInTheDocument();
  });

  it('shows a safe placeholder when a persisted item is missing from the menu', async () => {
    seedCart();
    installFetchStub({ json: { categories: [] } });
    renderCart();
    await flushAsyncWork();

    expect(
      screen.getByRole('heading', { level: 3, name: 'Item no longer available' }),
    ).toBeVisible();
    expect(
      screen.getByText('Remove this stale item or review the menu.'),
    ).toBeVisible();
    expect(screen.queryByText(ITEM_ID)).not.toBeInTheDocument();
  });

  it('shows current unavailability without deleting the cart line', async () => {
    seedCart([{ menuItemId: SECOND_ITEM_ID, quantity: 1 }]);
    installFetchStub({ json: MENU });
    renderCart();
    await flushAsyncWork();

    expect(
      screen.getByRole('heading', { level: 3, name: 'Evening special' }),
    ).toBeVisible();
    expect(screen.getByText(/Currently unavailable/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Remove Evening special from cart' }),
    ).toBeVisible();
  });

  it('disables quantity controls at the minimum and maximum', async () => {
    seedCart([
      { menuItemId: ITEM_ID, quantity: 1 },
      { menuItemId: SECOND_ITEM_ID, quantity: 99 },
    ]);
    installFetchStub({ json: MENU });
    renderCart();
    await flushAsyncWork();

    expect(
      screen.getByRole('button', { name: 'Decrease quantity for Seasonal bowl' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Increase quantity for Seasonal bowl' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Increase quantity for Evening special' }),
    ).toBeDisabled();
  });

  it('uses semantic regions and exposes only the approved order-creation CTA', async () => {
    seedCart();
    installFetchStub({ json: MENU });
    renderCart();
    await flushAsyncWork();

    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(
      screen.getByRole('complementary', { name: 'Server quote' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    ).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Takeaway' })).toBeChecked();
    expect(screen.getByRole('link', { name: 'Continue browsing' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(screen.queryByLabelText('Table number')).not.toBeInTheDocument();
    expect(screen.queryByText(/checkout session|Stripe/i)).toBeNull();
  });

  it('defaults to takeaway and conditionally reveals the dine-in table field', async () => {
    await renderReadyCart();

    expect(screen.getByRole('radio', { name: 'Takeaway' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Dine in' })).not.toBeChecked();
    expect(screen.queryByLabelText('Table number')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Dine in' }));

    const tableInput = screen.getByLabelText('Table number');
    expect(tableInput).toHaveAttribute('min', '1');
    expect(tableInput).toHaveAttribute('step', '1');
    expect(tableInput).toHaveAttribute('inputmode', 'numeric');
    expect(tableInput).toHaveAttribute('aria-invalid', 'true');
  });

  it.each(['', '0', '-1', '1.5'])(
    'rejects invalid dine-in table input %#',
    async (value) => {
      await renderReadyCart();
      fireEvent.click(screen.getByRole('radio', { name: 'Dine in' }));
      fireEvent.change(screen.getByLabelText('Table number'), {
        target: { value },
      });

      expect(
        screen.getByRole('button', {
          name: 'Place order and continue to payment',
        }),
      ).toBeDisabled();
      expect(screen.getByLabelText('Table number')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    },
  );

  it('accepts a positive whole dine-in table number', async () => {
    await renderReadyCart();
    fireEvent.click(screen.getByRole('radio', { name: 'Dine in' }));
    fireEvent.change(screen.getByLabelText('Table number'), {
      target: { value: '7' },
    });

    expect(screen.getByLabelText('Table number')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
    expect(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    ).toBeEnabled();
  });

  it('clears a previous table and omits it from a takeaway request', async () => {
    const stub = await renderReadyCart(
      { json: quoteFor(1) },
      { json: orderFor(1), status: 201 },
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Dine in' }));
    fireEvent.change(screen.getByLabelText('Table number'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Takeaway' }));

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    );
    await flushAsyncWork();

    expect(JSON.parse(stub.calls[3]?.body ?? '')).toEqual({
      items: [{ menu_item_id: ITEM_ID, quantity: 1 }],
      order_type: 'takeaway',
    });
    expect(stub.calls.every((call) => !call.url.includes('/tables'))).toBe(true);
  });

  it('requires a fresh matching quote before one exact order POST', async () => {
    const stub = await renderReadyCart(
      { json: quoteFor(1, 13_500) },
      { json: orderFor(1, 13_500), status: 201 },
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    );
    await flushAsyncWork();

    expect(stub.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/v1/menu',
      'POST /api/v1/orders/quote',
      'POST /api/v1/orders/quote',
      'POST /api/v1/orders',
    ]);
    expect(JSON.parse(stub.calls[2]?.body ?? '')).toEqual({
      items: [{ menu_item_id: ITEM_ID, quantity: 1 }],
    });
    expect(JSON.parse(stub.calls[3]?.body ?? '')).toEqual({
      items: [{ menu_item_id: ITEM_ID, quantity: 1 }],
      order_type: 'takeaway',
    });
  });

  it('does not create an order when the pre-submit quote fails', async () => {
    const stub = await renderReadyCart({
      json: { detail: 'unavailable' },
      status: 409,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    );
    await flushAsyncWork();

    expect(stub.calls).toHaveLength(3);
    expect(screen.getByText(/No order request was sent/)).toBeVisible();
  });

  it('does not create from a stale pre-submit quote after the cart changes', async () => {
    seedCart();
    let resolveFreshQuote!: (response: Response) => void;
    const freshQuote = new Promise<Response>((resolve) => {
      resolveFreshQuote = resolve;
    });
    const stub = installFetchStub(
      { json: MENU },
      { json: quoteFor(1) },
      { responsePromise: freshQuote },
    );
    renderCart({ externalMutation: true });
    await flushAsyncWork();
    await advanceQuoteDebounce();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'External cart mutation' }));
    resolveFreshQuote(
      new Response(JSON.stringify(quoteFor(1)), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await flushAsyncWork();

    expect(stub.calls).toHaveLength(3);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your cart changed while prices were being confirmed',
    );
  });

  it('guards duplicate submission while the fresh quote is pending', async () => {
    seedCart();
    const pendingQuote = new Promise<Response>(() => undefined);
    const stub = installFetchStub(
      { json: MENU },
      { json: quoteFor(1) },
      { responsePromise: pendingQuote },
    );
    renderCart();
    await flushAsyncWork();
    await advanceQuoteDebounce();
    const placeOrder = screen.getByRole('button', {
      name: 'Place order and continue to payment',
    });

    fireEvent.click(placeOrder);
    fireEvent.click(placeOrder);

    expect(stub.calls).toHaveLength(3);
    expect(placeOrder).toBeDisabled();
    expect(screen.getByText('Confirming current prices…')).toBeVisible();
  });

  it('stores access, navigates once, retains the cart, and calls no checkout API', async () => {
    const stub = await renderReadyCart(
      { json: quoteFor(1) },
      { json: orderFor(1), status: 201 },
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    );
    await flushAsyncWork();

    expect(screen.getByTestId('current-path')).toHaveTextContent(
      `/orders/${PUBLIC_ORDER_NUMBER}/checkout`,
    );
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBe(ACCESS_TOKEN);
    expect(screen.queryByText(ACCESS_TOKEN)).not.toBeInTheDocument();
    expect(screen.getByTestId('current-path')).not.toHaveTextContent(ACCESS_TOKEN);
    expect(screen.getByTestId('current-state')).toHaveTextContent('null');
    expect(sessionStorage.getItem(CART_STORAGE_KEY)).toContain(ITEM_ID);
    expect(
      stub.calls.filter((call) => call.url.includes('checkout-session')),
    ).toHaveLength(0);
    expect(stub.calls.filter((call) => call.url === '/api/v1/orders')).toHaveLength(1);
    expect(
      stub.calls
        .find((call) => call.url === '/api/v1/orders')
        ?.headers.has('Authorization'),
    ).toBe(false);
  });

  it('creates an owned order with Bearer and still stores its guest capability', async () => {
    seedCart();
    seedAuthToken();
    const calls = installAuthenticatedCartFetch();
    renderCart();
    await flushAsyncWork();
    await advanceQuoteDebounce();

    fireEvent.click(
      screen.getByRole('button', { name: 'Place order and continue to payment' }),
    );
    await flushAsyncWork();

    const createCalls = calls.filter((call) => call.url.endsWith('/api/v1/orders'));
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.headers.get('Authorization')).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(createCalls[0]?.headers.has('X-Order-Access-Token')).toBe(false);
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBe(ACCESS_TOKEN);
    expect(sessionStorage.getItem(CART_STORAGE_KEY)).toContain(ITEM_ID);
  });

  it('blocks final creation while a stored session is still being checked', async () => {
    seedCart();
    seedAuthToken();
    const calls = installAuthenticatedCartFetch({ meStatus: 'pending' });
    renderCart();
    await flushAsyncWork();
    await advanceQuoteDebounce();

    expect(
      screen.getByText('Checking your session before order creation...'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Place order and continue to payment' }),
    ).toBeDisabled();
    expect(calls.filter((call) => call.url.endsWith('/api/v1/orders'))).toHaveLength(0);
  });

  it('blocks guest fallback while saved-session validation is unavailable', async () => {
    seedCart();
    seedAuthToken();
    const calls = installAuthenticatedCartFetch({ meStatus: 503 });
    renderCart();
    await flushAsyncWork();
    await advanceQuoteDebounce();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Session validation unavailable',
    );
    expect(
      screen.getByRole('button', { name: 'Place order and continue to payment' }),
    ).toBeDisabled();
    expect(calls.filter((call) => call.url.endsWith('/api/v1/orders'))).toHaveLength(0);
    expect(sessionStorage.getItem(CART_STORAGE_KEY)).toContain(ITEM_ID);
  });

  it('invalidates the request session on authenticated 401 without a guest retry', async () => {
    seedCart();
    seedAuthToken();
    const calls = installAuthenticatedCartFetch({ orderStatus: 401 });
    renderCart();
    await flushAsyncWork();
    await advanceQuoteDebounce();

    fireEvent.click(
      screen.getByRole('button', { name: 'Place order and continue to payment' }),
    );
    await flushAsyncWork();

    expect(screen.getByRole('alert')).toHaveTextContent('Session expired');
    expect(calls.filter((call) => call.url.endsWith('/api/v1/orders'))).toHaveLength(1);
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(CART_STORAGE_KEY)).toContain(ITEM_ID);
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBeNull();
  });

  it('warns about an ambiguous network result without automatic retry', async () => {
    const stub = await renderReadyCart(
      { json: quoteFor(1) },
      { error: new TypeError('connection lost') },
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    );
    await flushAsyncWork();

    expect(screen.getByRole('alert')).toHaveTextContent('may have been created');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Retrying can create a duplicate order',
    );
    expect(
      screen.getByRole('button', { name: 'Create another order attempt' }),
    ).toBeVisible();
    expect(screen.queryByText(/definitely failed/i)).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(stub.calls).toHaveLength(4);
  });

  it('requires an explicit deliberate click before a second non-idempotent attempt', async () => {
    const stub = await renderReadyCart(
      { json: quoteFor(1) },
      { error: new TypeError('connection lost') },
      { json: quoteFor(1) },
      { json: { detail: 'limited' }, status: 429 },
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    );
    await flushAsyncWork();
    expect(stub.calls).toHaveLength(4);

    fireEvent.click(
      screen.getByRole('button', { name: 'Create another order attempt' }),
    );
    await flushAsyncWork();

    expect(stub.calls).toHaveLength(6);
    expect(screen.getByRole('alert')).toHaveTextContent('Too many order attempts');
  });

  it('treats an order timeout as ambiguous and does not retry it', async () => {
    const stub = await renderReadyCart({ json: quoteFor(1) }, { waitForAbort: true });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByRole('alert')).toHaveTextContent('may have been created');
    expect(stub.calls).toHaveLength(4);
  });

  it.each([422, 429])(
    'preserves the cart and does not navigate or auto-retry after HTTP %s',
    async (status) => {
      const stub = await renderReadyCart(
        { json: quoteFor(1) },
        { json: { detail: 'not exposed' }, status },
      );
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Place order and continue to payment',
        }),
      );
      await flushAsyncWork();

      expect(
        screen.getByRole('heading', { level: 3, name: 'Seasonal bowl' }),
      ).toBeVisible();
      expect(screen.getByTestId('current-path')).toHaveTextContent('/cart');
      expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(stub.calls).toHaveLength(4);
    },
  );

  it('focuses the dine-in table after a 422 order response', async () => {
    const stub = await renderReadyCart(
      { json: quoteFor(1) },
      { json: { detail: 'Invalid table' }, status: 422 },
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Dine in' }));
    const tableInput = screen.getByLabelText('Table number');
    fireEvent.change(tableInput, { target: { value: '7' } });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    );
    await flushAsyncWork();

    expect(stub.calls).toHaveLength(4);
    expect(tableInput).toHaveFocus();
    expect(tableInput).toHaveAttribute('aria-invalid', 'true');
    expect(tableInput).toHaveAttribute(
      'aria-describedby',
      'table-number-help table-number-error',
    );
    expect(screen.getByText(/could not validate this table/)).toBeVisible();
  });

  it('preserves the cart and stores no token for an invalid creation response', async () => {
    const invalidOrder = { ...orderFor(1), order_access_token: '' };
    await renderReadyCart({ json: quoteFor(1) }, { json: invalidOrder, status: 201 });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Place order and continue to payment',
      }),
    );
    await flushAsyncWork();

    expect(screen.getByRole('alert')).toHaveTextContent('result uncertain');
    expect(screen.getByTestId('current-path')).toHaveTextContent('/cart');
    expect(
      sessionStorage.getItem(getOrderAccessStorageKey(PUBLIC_ORDER_NUMBER)),
    ).toBeNull();
    expect(sessionStorage.getItem(CART_STORAGE_KEY)).toContain(ITEM_ID);
  });
});
