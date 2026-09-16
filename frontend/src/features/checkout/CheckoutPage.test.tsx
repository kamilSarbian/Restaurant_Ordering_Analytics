import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import type { OrderStatusOptions } from '../../api/customerApi';
import type { OrderStatusResponse } from '../../api/types';
import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider } from '../auth/AuthContext';
import {
  AUTH_STORAGE_KEY,
  loadAuthToken,
  resetAuthMemoryForTests,
} from '../auth/authStorage';
import { CartProvider } from '../cart/CartContext';
import CheckoutPage from './CheckoutPage';
import {
  CHECKOUT_ATTEMPT_STORAGE_VERSION,
  getCheckoutAttemptStorageKey,
  loadCheckoutAttempt,
  saveCheckoutAttempt,
} from './checkoutAttemptStorage';
import {
  getOrderAccessStorageKey,
  loadOrderAccess,
  ORDER_ACCESS_STORAGE_VERSION,
  saveOrderAccess,
} from './orderAccessStorage';

const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const SECOND_PUBLIC_ORDER_NUMBER = 'ROA-BCDEFGHJKLMN';
const ACCESS_TOKEN = 'guest-access-token-that-must-stay-private';
const SECOND_ACCESS_TOKEN = 'second-guest-access-token-that-must-stay-private';
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

function installAuthenticatedCheckoutFetch(
  options: {
    checkoutStatus?: number;
    meStatus?: number | 'pending';
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
    if (url.endsWith('/checkout-session')) {
      return new Response(
        options.checkoutStatus === undefined ? JSON.stringify(VALID_CHECKOUT) : null,
        {
          headers:
            options.checkoutStatus === undefined
              ? { 'Content-Type': 'application/json' }
              : undefined,
          status: options.checkoutStatus ?? 201,
        },
      );
    }
    throw new Error(`Unexpected test request: ${url}`);
  };
  vi.stubGlobal('fetch', vi.fn(fetchStub));
  return calls;
}
const FIRST_KEY = '00000000-0000-4000-8000-000000000004';
const SECOND_KEY = '00000000-0000-4000-8000-000000000014';
const VALID_CHECKOUT = {
  checkout_url: 'https://checkout.example.test/session/hosted',
  expires_at: '2026-08-11T15:30:00Z',
  payment_status: 'pending',
  public_order_number: PUBLIC_ORDER_NUMBER,
};
const VALID_ORDER_SUMMARY: OrderStatusResponse = {
  created_at: '2026-08-11T14:30:00Z',
  currency: 'NOK',
  items: [
    {
      line_total_amount: 25_800,
      menu_item_id: '00000000-0000-4000-8000-000000000010',
      name: 'Fjord cod',
      quantity: 2,
      unit_price_amount: 12_900,
    },
    {
      line_total_amount: 13_000,
      menu_item_id: '00000000-0000-4000-8000-000000000020',
      name: 'Cloudberry drink',
      quantity: 1,
      unit_price_amount: 13_000,
    },
  ],
  order_type: 'dine_in',
  public_order_number: PUBLIC_ORDER_NUMBER,
  status: 'created',
  subtotal_amount: 38_800,
  table_number: 12,
  total_amount: 38_800,
  updated_at: '2026-08-11T14:30:00Z',
};

type OrderSummaryLoader = (
  publicOrderNumber: string,
  options: OrderStatusOptions,
) => Promise<OrderStatusResponse>;

function renderCheckout(
  publicOrderNumber = PUBLIC_ORDER_NUMBER,
  state: unknown = null,
  redirectToCheckout: (checkoutUrl: string) => void = vi.fn(),
  loadOrderSummary: OrderSummaryLoader = vi
    .fn<OrderSummaryLoader>()
    .mockResolvedValue(VALID_ORDER_SUMMARY),
) {
  return render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: `/orders/${publicOrderNumber}/checkout`,
          state,
        },
      ]}
    >
      <AuthProvider>
        <CartProvider>
          <Routes>
            <Route
              path="/orders/:publicOrderNumber/checkout"
              element={
                <CheckoutPage
                  loadOrderSummary={loadOrderSummary}
                  redirectToCheckout={redirectToCheckout}
                />
              }
            />
          </Routes>
        </CartProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function seedAttempt(idempotencyKey = FIRST_KEY): void {
  saveCheckoutAttempt({
    idempotencyKey,
    publicOrderNumber: PUBLIC_ORDER_NUMBER,
    version: CHECKOUT_ATTEMPT_STORAGE_VERSION,
  });
}

describe('orderAccessStorage', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('round-trips a versioned token under the public-order-scoped key', () => {
    expect(saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN)).toBe(true);

    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBe(ACCESS_TOKEN);
    expect(
      JSON.parse(
        sessionStorage.getItem(getOrderAccessStorageKey(PUBLIC_ORDER_NUMBER)) ?? '',
      ),
    ).toEqual({
      publicOrderNumber: PUBLIC_ORDER_NUMBER,
      token: ACCESS_TOKEN,
      version: ORDER_ACCESS_STORAGE_VERSION,
    });
  });

  it('rejects malformed JSON', () => {
    sessionStorage.setItem(getOrderAccessStorageKey(PUBLIC_ORDER_NUMBER), '{broken');
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBeNull();
  });

  it('rejects a wrong storage version', () => {
    sessionStorage.setItem(
      getOrderAccessStorageKey(PUBLIC_ORDER_NUMBER),
      JSON.stringify({
        publicOrderNumber: PUBLIC_ORDER_NUMBER,
        token: ACCESS_TOKEN,
        version: 2,
      }),
    );
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBeNull();
  });

  it('rejects a public-number mismatch', () => {
    sessionStorage.setItem(
      getOrderAccessStorageKey(PUBLIC_ORDER_NUMBER),
      JSON.stringify({
        publicOrderNumber: 'ROA-BCDEFGHJKLMN',
        token: ACCESS_TOKEN,
        version: 1,
      }),
    );
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBeNull();
  });

  it.each(['', '   '])('rejects an empty token value %#', (token) => {
    sessionStorage.setItem(
      getOrderAccessStorageKey(PUBLIC_ORDER_NUMBER),
      JSON.stringify({
        publicOrderNumber: PUBLIC_ORDER_NUMBER,
        token,
        version: 1,
      }),
    );
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBeNull();
  });

  it('continues safely when sessionStorage raises SecurityError', () => {
    const unavailableStorage = {
      getItem: vi.fn(() => {
        throw new DOMException('Blocked', 'SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new DOMException('Blocked', 'SecurityError');
      }),
    } as unknown as Storage;

    expect(saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN, unavailableStorage)).toBe(
      false,
    );
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER, unavailableStorage)).toBeNull();
  });

  it('never uses localStorage', () => {
    const localGet = vi.spyOn(window.localStorage, 'getItem');
    const localSet = vi.spyOn(window.localStorage, 'setItem');

    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN, window.sessionStorage);
    loadOrderAccess(PUBLIC_ORDER_NUMBER, window.sessionStorage);

    expect(localGet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
  });
});

describe('checkoutAttemptStorage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('stores only the versioned public number and idempotency key', () => {
    seedAttempt();

    expect(
      JSON.parse(
        sessionStorage.getItem(getCheckoutAttemptStorageKey(PUBLIC_ORDER_NUMBER)) ?? '',
      ),
    ).toEqual({
      idempotencyKey: FIRST_KEY,
      publicOrderNumber: PUBLIC_ORDER_NUMBER,
      version: CHECKOUT_ATTEMPT_STORAGE_VERSION,
    });
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
    expect(
      sessionStorage.getItem(getCheckoutAttemptStorageKey(PUBLIC_ORDER_NUMBER)),
    ).not.toMatch(/token|checkout_url|stripe|payment_id/i);
  });

  it.each([
    ['malformed JSON', '{broken'],
    [
      'wrong version',
      JSON.stringify({
        idempotencyKey: FIRST_KEY,
        publicOrderNumber: PUBLIC_ORDER_NUMBER,
        version: 2,
      }),
    ],
    [
      'order mismatch',
      JSON.stringify({
        idempotencyKey: FIRST_KEY,
        publicOrderNumber: 'ROA-BCDEFGHJKLMN',
        version: CHECKOUT_ATTEMPT_STORAGE_VERSION,
      }),
    ],
    [
      'non-v4 key',
      JSON.stringify({
        idempotencyKey: '00000000-0000-1000-8000-000000000004',
        publicOrderNumber: PUBLIC_ORDER_NUMBER,
        version: CHECKOUT_ATTEMPT_STORAGE_VERSION,
      }),
    ],
  ])('rejects %s', (_label, serialized) => {
    sessionStorage.setItem(
      getCheckoutAttemptStorageKey(PUBLIC_ORDER_NUMBER),
      serialized,
    );

    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)).toBeNull();
  });

  it('handles unavailable storage and never falls back to localStorage', () => {
    const unavailableStorage = {
      getItem: vi.fn(() => {
        throw new DOMException('Blocked', 'SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new DOMException('Blocked', 'SecurityError');
      }),
    } as unknown as Storage;

    expect(
      saveCheckoutAttempt(
        {
          idempotencyKey: FIRST_KEY,
          publicOrderNumber: PUBLIC_ORDER_NUMBER,
          version: CHECKOUT_ATTEMPT_STORAGE_VERSION,
        },
        unavailableStorage,
      ),
    ).toBe(false);
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER, unavailableStorage)).toBeNull();
    expect(localStorage).toHaveLength(0);
  });
});

describe('CheckoutPage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetAuthMemoryForTests();
    vi.spyOn(window.crypto, 'randomUUID').mockReturnValue(FIRST_KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    resetAuthMemoryForTests();
  });

  it('renders the branded authoritative summary without starting checkout', async () => {
    const stub = installFetchStub();
    const loadOrderSummary = vi
      .fn<OrderSummaryLoader>()
      .mockResolvedValue(VALID_ORDER_SUMMARY);
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);

    renderCheckout(PUBLIC_ORDER_NUMBER, null, vi.fn(), loadOrderSummary);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order created' }),
    ).toBeVisible();
    expect(screen.getByText('Nordic Hearth')).toBeVisible();
    expect(screen.getAllByText('Nordic Hearth')).toHaveLength(1);
    const brandMark = screen
      .getByText('Nordic Hearth')
      .parentElement?.querySelector('svg');
    expect(brandMark).toHaveAttribute('aria-hidden', 'true');
    expect(
      screen.queryByRole('img', { name: 'Nordic Hearth' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Payment is still required.')).toBeVisible();
    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Return to cart' })).toHaveAttribute(
      'href',
      '/cart',
    );
    expect(screen.queryByText(ACCESS_TOKEN)).not.toBeInTheDocument();
    expect(screen.queryByText(FIRST_KEY)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse the menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    const summary = await screen.findByRole('region', { name: 'Order summary' });
    expect(within(summary).getByText('Fjord cod')).toBeVisible();
    expect(within(summary).getByText('Qty 2')).toBeVisible();
    expect(within(summary).getByText('Cloudberry drink')).toBeVisible();
    expect(within(summary).getByText('Dine-in')).toBeVisible();
    expect(within(summary).getByText('12')).toBeVisible();
    expect(within(summary).getByText('Subtotal').parentElement).toHaveTextContent(
      /38[\s,.]?800|388[,.]00/,
    );
    expect(within(summary).getByText('Total').parentElement).toHaveTextContent(
      /38[\s,.]?800|388[,.]00/,
    );
    expect(within(summary).getByText('Fjord cod').closest('li')).toHaveTextContent(
      /25[\s,.]?800|258[,.]00/,
    );
    expect(screen.queryByText(/payment (?:complete|succeeded|successful)/i)).toBeNull();
    expect(loadOrderSummary).toHaveBeenCalledWith(PUBLIC_ORDER_NUMBER, {
      guestAccessToken: ACCESS_TOKEN,
      signal: expect.any(AbortSignal),
    });
    expect(stub.calls).toHaveLength(0);
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
    expect(window.crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('keeps payment available and retries a focused summary error independently', async () => {
    const user = userEvent.setup();
    const stub = installFetchStub();
    const loadOrderSummary = vi
      .fn<OrderSummaryLoader>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(VALID_ORDER_SUMMARY);
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();

    renderCheckout(PUBLIC_ORDER_NUMBER, null, vi.fn(), loadOrderSummary);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Order summary unavailable');
    await waitFor(() => expect(alert.parentElement).toHaveFocus());
    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeEnabled();
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
    expect(stub.calls).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Retry order summary' }));

    const summary = await screen.findByRole('region', { name: 'Order summary' });
    expect(within(summary).getByText('Fjord cod')).toBeVisible();
    expect(summary).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(summary).toHaveFocus());
    expect(loadOrderSummary).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
  });

  it('aborts the independent order-summary request on unmount', async () => {
    const loadOrderSummary = vi.fn<OrderSummaryLoader>(
      () => new Promise<OrderStatusResponse>(() => undefined),
    );
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);

    const view = renderCheckout(PUBLIC_ORDER_NUMBER, null, vi.fn(), loadOrderSummary);

    await waitFor(() => expect(loadOrderSummary).toHaveBeenCalledTimes(1));
    const summarySignal = loadOrderSummary.mock.calls[0]?.[1].signal;
    expect(summarySignal).toBeInstanceOf(AbortSignal);
    expect(summarySignal?.aborted).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeEnabled();
    expect(screen.getByRole('region', { name: 'Order summary' })).toHaveAttribute(
      'aria-busy',
      'true',
    );

    view.unmount();

    expect(summarySignal?.aborted).toBe(true);
  });

  it('ignores a capability supplied through navigation state and never renders it', () => {
    renderCheckout(PUBLIC_ORDER_NUMBER, {
      orderAccessToken: ACCESS_TOKEN,
      publicOrderNumber: PUBLIC_ORDER_NUMBER,
    });

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order access unavailable' }),
    ).toBeVisible();
    expect(screen.queryByText(ACCESS_TOKEN)).not.toBeInTheDocument();
  });

  it('loads the same persisted attempt on a remount without generating a key', () => {
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();

    const firstRender = renderCheckout();
    firstRender.unmount();
    renderCheckout();

    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
    expect(window.crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('aborts and ignores an in-flight order A checkout after navigating in place to order B', async () => {
    let resolveFirstResponse: ((response: Response) => void) | undefined;
    const firstResponsePromise = new Promise<Response>((resolve) => {
      resolveFirstResponse = resolve;
    });
    const secondCheckout = {
      ...VALID_CHECKOUT,
      checkout_url: 'https://checkout.example.test/session/second-hosted',
      public_order_number: SECOND_PUBLIC_ORDER_NUMBER,
    };
    const stub = installFetchStub(
      { responsePromise: firstResponsePromise },
      { json: secondCheckout, status: 201 },
    );
    const redirect = vi.fn();
    const loadOrderSummary = vi.fn<OrderSummaryLoader>(async (publicOrderNumber) => ({
      ...VALID_ORDER_SUMMARY,
      public_order_number: publicOrderNumber,
    }));
    const cartValue = JSON.stringify({
      items: [{ menuItemId: '00000000-0000-4000-8000-000000000010', quantity: 2 }],
      version: 1,
    });
    sessionStorage.setItem('restaurant-ordering:cart:v1', cartValue);
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    saveOrderAccess(SECOND_PUBLIC_ORDER_NUMBER, SECOND_ACCESS_TOKEN);
    seedAttempt();
    saveCheckoutAttempt({
      idempotencyKey: SECOND_KEY,
      publicOrderNumber: SECOND_PUBLIC_ORDER_NUMBER,
      version: CHECKOUT_ATTEMPT_STORAGE_VERSION,
    });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={[`/orders/${PUBLIC_ORDER_NUMBER}/checkout`]}>
        <AuthProvider>
          <CartProvider>
            <Link to={`/orders/${SECOND_PUBLIC_ORDER_NUMBER}/checkout`}>
              Open second order
            </Link>
            <Routes>
              <Route
                path="/orders/:publicOrderNumber/checkout"
                element={
                  <CheckoutPage
                    loadOrderSummary={loadOrderSummary}
                    redirectToCheckout={redirect}
                  />
                }
              />
            </Routes>
          </CartProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    const firstSignal = stub.calls[0]?.signal;
    expect(firstSignal?.aborted).toBe(false);

    await user.click(screen.getByRole('link', { name: 'Open second order' }));

    expect(await screen.findByText(SECOND_PUBLIC_ORDER_NUMBER)).toBeVisible();
    expect(firstSignal?.aborted).toBe(true);
    expect(loadOrderSummary).toHaveBeenLastCalledWith(SECOND_PUBLIC_ORDER_NUMBER, {
      guestAccessToken: SECOND_ACCESS_TOKEN,
      signal: expect.any(AbortSignal),
    });

    let lateResponseParsed = false;
    const lateResponse = new Response(JSON.stringify(VALID_CHECKOUT), {
      headers: { 'Content-Type': 'application/json' },
      status: 201,
    });
    vi.spyOn(lateResponse, 'json').mockImplementation(async () => {
      lateResponseParsed = true;
      return VALID_CHECKOUT;
    });
    await act(async () => {
      resolveFirstResponse?.(lateResponse);
      await Promise.resolve();
    });
    await waitFor(() => expect(lateResponseParsed).toBe(true));

    expect(redirect).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('restaurant-ordering:cart:v1')).toBe(cartValue);
    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeEnabled();

    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(secondCheckout.checkout_url),
    );
    expect(stub.calls.map((call) => call.headers.get('Idempotency-Key'))).toEqual([
      FIRST_KEY,
      SECOND_KEY,
    ]);
    expect(stub.calls[1]?.headers.get('X-Order-Access-Token')).toBe(
      SECOND_ACCESS_TOKEN,
    );
  });

  it('ignores invalid attempt storage and replaces it with one valid UUIDv4', () => {
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    sessionStorage.setItem(
      getCheckoutAttemptStorageKey(PUBLIC_ORDER_NUMBER),
      JSON.stringify({
        idempotencyKey: 'not-a-v4-key',
        publicOrderNumber: PUBLIC_ORDER_NUMBER,
        version: CHECKOUT_ATTEMPT_STORAGE_VERSION,
      }),
    );

    renderCheckout();

    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
    expect(window.crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-memory attempt when sessionStorage raises SecurityError', async () => {
    seedAuthToken();
    expect(loadAuthToken()).toBe(AUTH_TOKEN);
    const calls = installAuthenticatedCheckoutFetch();
    const user = userEvent.setup();
    const getItem = vi
      .spyOn(window.Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new DOMException('Blocked', 'SecurityError');
      });
    const setItem = vi
      .spyOn(window.Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Blocked', 'SecurityError');
      });

    renderCheckout();

    await screen.findByRole('heading', { level: 1, name: 'Order created' });
    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    await waitFor(() =>
      expect(
        calls.filter((call) => call.url.endsWith('/checkout-session')),
      ).toHaveLength(1),
    );
    expect(window.crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(getItem).toHaveBeenCalled();
    expect(setItem).toHaveBeenCalled();
  });

  it('does not accept transient state for another public order', () => {
    renderCheckout(PUBLIC_ORDER_NUMBER, {
      orderAccessToken: ACCESS_TOKEN,
      publicOrderNumber: 'ROA-BCDEFGHJKLMN',
    });

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order access unavailable' }),
    ).toBeVisible();
  });

  it.each(['ROA-invalid', 'not-an-order'])(
    'shows safe recovery for malformed route number %s',
    (publicOrderNumber) => {
      renderCheckout(publicOrderNumber);
      expect(
        screen.getByRole('heading', {
          level: 1,
          name: 'Order access unavailable',
        }),
      ).toBeVisible();
    },
  );

  it('shows safe recovery links when access is missing', () => {
    const stub = installFetchStub();
    renderCheckout();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order access unavailable' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Return to cart' })).toHaveAttribute(
      'href',
      '/cart',
    );
    expect(screen.getByRole('link', { name: 'Browse the menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
    expect(window.crypto.randomUUID).not.toHaveBeenCalled();
    expect(stub.calls).toHaveLength(0);
  });

  it('creates one session, clears the cart, and redirects in the same tab', async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const stub = installFetchStub({ json: VALID_CHECKOUT, status: 201 });
    sessionStorage.setItem(
      'restaurant-ordering:cart:v1',
      JSON.stringify({
        items: [{ menuItemId: '00000000-0000-4000-8000-000000000010', quantity: 2 }],
        version: 1,
      }),
    );
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout(PUBLIC_ORDER_NUMBER, null, redirect);

    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(VALID_CHECKOUT.checkout_url),
    );
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.headers.get('Idempotency-Key')).toBe(FIRST_KEY);
    expect(stub.calls[0]?.headers.get('X-Order-Access-Token')).toBe(ACCESS_TOKEN);
    await waitFor(() =>
      expect(
        JSON.parse(sessionStorage.getItem('restaurant-ordering:cart:v1') ?? ''),
      ).toEqual({ items: [], version: 1 }),
    );
  });

  it('sends Bearer and the stored capability for authenticated checkout', async () => {
    seedAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    const calls = installAuthenticatedCheckoutFetch();
    const loadOrderSummary = vi
      .fn<OrderSummaryLoader>()
      .mockResolvedValue(VALID_ORDER_SUMMARY);
    const redirect = vi.fn();
    const user = userEvent.setup();
    renderCheckout(PUBLIC_ORDER_NUMBER, null, redirect, loadOrderSummary);

    await screen.findByRole('heading', { name: 'Order created' });
    await waitFor(() => expect(loadOrderSummary).toHaveBeenCalledTimes(1));
    expect(loadOrderSummary).toHaveBeenCalledWith(PUBLIC_ORDER_NUMBER, {
      accessToken: AUTH_TOKEN,
      guestAccessToken: ACCESS_TOKEN,
      signal: expect.any(AbortSignal),
    });
    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
    const checkoutCalls = calls.filter((call) =>
      call.url.endsWith('/checkout-session'),
    );
    expect(checkoutCalls).toHaveLength(1);
    expect(checkoutCalls[0]?.headers.get('Authorization')).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(checkoutCalls[0]?.headers.get('X-Order-Access-Token')).toBe(ACCESS_TOKEN);
    expect(checkoutCalls[0]?.headers.get('Idempotency-Key')).toBe(FIRST_KEY);
  });

  it('allows an authenticated owner to checkout without a guest capability', async () => {
    seedAuthToken();
    const calls = installAuthenticatedCheckoutFetch();
    const loadOrderSummary = vi
      .fn<OrderSummaryLoader>()
      .mockResolvedValue(VALID_ORDER_SUMMARY);
    const redirect = vi.fn();
    const user = userEvent.setup();
    renderCheckout(PUBLIC_ORDER_NUMBER, null, redirect, loadOrderSummary);

    await screen.findByRole('heading', { name: 'Order created' });
    await waitFor(() => expect(loadOrderSummary).toHaveBeenCalledTimes(1));
    expect(loadOrderSummary).toHaveBeenCalledWith(PUBLIC_ORDER_NUMBER, {
      accessToken: AUTH_TOKEN,
      signal: expect.any(AbortSignal),
    });
    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
    const checkoutCall = calls.find((call) => call.url.endsWith('/checkout-session'));
    expect(checkoutCall?.headers.get('Authorization')).toBe(`Bearer ${AUTH_TOKEN}`);
    expect(checkoutCall?.headers.has('X-Order-Access-Token')).toBe(false);
    expect(checkoutCall?.headers.get('Idempotency-Key')).toBe(FIRST_KEY);
  });

  it('does not start guest checkout while a stored session is being checked', async () => {
    seedAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    const calls = installAuthenticatedCheckoutFetch({ meStatus: 'pending' });
    renderCheckout();

    expect(
      await screen.findByRole('heading', { name: 'Checking your session' }),
    ).toBeVisible();
    expect(calls.filter((call) => call.url.endsWith('/checkout-session'))).toHaveLength(
      0,
    );
    expect(window.crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('does not downgrade to capability checkout when session validation is unavailable', async () => {
    seedAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    const calls = installAuthenticatedCheckoutFetch({ meStatus: 503 });
    renderCheckout();

    expect(
      await screen.findByRole('heading', { name: 'Session validation unavailable' }),
    ).toBeVisible();
    expect(calls.filter((call) => call.url.endsWith('/checkout-session'))).toHaveLength(
      0,
    );
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBe(ACCESS_TOKEN);
  });

  it('does not retry an authenticated summary 401 with the guest capability', async () => {
    seedAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    const calls = installAuthenticatedCheckoutFetch();
    const loadOrderSummary = vi
      .fn<OrderSummaryLoader>()
      .mockRejectedValue(
        new ApiRequestError('http', 'The session expired.', { status: 401 }),
      );

    renderCheckout(PUBLIC_ORDER_NUMBER, null, vi.fn(), loadOrderSummary);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Order details were not retried as a guest');
    await waitFor(() => expect(alert.parentElement).toHaveFocus());
    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Retry order summary' }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull());
    expect(loadOrderSummary).toHaveBeenCalledTimes(1);
    expect(loadOrderSummary).toHaveBeenCalledWith(PUBLIC_ORDER_NUMBER, {
      accessToken: AUTH_TOKEN,
      guestAccessToken: ACCESS_TOKEN,
      signal: expect.any(AbortSignal),
    });
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBe(ACCESS_TOKEN);
    expect(calls.filter((call) => call.url.endsWith('/checkout-session'))).toHaveLength(
      0,
    );
  });

  it('keeps capability and idempotency after authenticated 401 without retrying', async () => {
    seedAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    const calls = installAuthenticatedCheckoutFetch({ checkoutStatus: 401 });
    const redirect = vi.fn();
    const user = userEvent.setup();
    renderCheckout(PUBLIC_ORDER_NUMBER, null, redirect);

    await screen.findByRole('heading', { name: 'Order created' });
    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Checkout was not retried as a guest',
    );
    expect(calls.filter((call) => call.url.endsWith('/checkout-session'))).toHaveLength(
      1,
    );
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(loadOrderAccess(PUBLIC_ORDER_NUMBER)).toBe(ACCESS_TOKEN);
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('treats a 200 replay as the same successful customer flow', async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    installFetchStub({ json: VALID_CHECKOUT, status: 200 });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout(PUBLIC_ORDER_NUMBER, null, redirect);

    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(VALID_CHECKOUT.checkout_url),
    );
  });

  it('allows only one in-flight checkout request on repeated clicks', async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const redirect = vi.fn();
    const stub = installFetchStub({ responsePromise });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout(PUBLIC_ORDER_NUMBER, null, redirect);
    const button = screen.getByRole('button', { name: 'Continue to secure payment' });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAccessibleName('Continue to secure payment');
    expect(screen.getByText('Creating secure checkout…')).toBeVisible();
    expect(stub.calls).toHaveLength(1);
    resolveResponse?.(
      new Response(JSON.stringify(VALID_CHECKOUT), {
        headers: { 'Content-Type': 'application/json' },
        status: 201,
      }),
    );
    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
  });

  it('preserves cart and attempt after an invalid response', async () => {
    const user = userEvent.setup();
    const redirect = vi.fn();
    const cartValue = JSON.stringify({
      items: [{ menuItemId: '00000000-0000-4000-8000-000000000010', quantity: 1 }],
      version: 1,
    });
    sessionStorage.setItem('restaurant-ordering:cart:v1', cartValue);
    installFetchStub({
      json: { ...VALID_CHECKOUT, checkout_url: 'javascript:alert(1)' },
      status: 201,
    });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout(PUBLIC_ORDER_NUMBER, null, redirect);

    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/unsafe or invalid/i);
    await waitFor(() => expect(alert.parentElement).toHaveFocus());
    expect(redirect).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('restaurant-ordering:cart:v1')).toBe(cartValue);
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
  });

  it('preserves focus moved elsewhere while checkout feedback is pending', async () => {
    let resolveResponse!: (response: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const user = userEvent.setup();
    installFetchStub({ responsePromise });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout();

    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );
    expect(screen.getByText(/Creating secure checkout/u)).toBeVisible();
    const returnToCart = screen.getByRole('link', { name: 'Return to cart' });
    returnToCart.focus();
    expect(returnToCart).toHaveFocus();

    resolveResponse(new Response(null, { status: 503 }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not safely confirm the checkout result',
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(returnToCart).toHaveFocus();
  });

  it('preserves focus moved elsewhere while the order summary is pending', async () => {
    let rejectSummary!: (reason: unknown) => void;
    const pendingSummary = new Promise<OrderStatusResponse>((_resolve, reject) => {
      rejectSummary = reject;
    });
    const loadOrderSummary = vi
      .fn<OrderSummaryLoader>()
      .mockReturnValue(pendingSummary);
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout(PUBLIC_ORDER_NUMBER, null, vi.fn(), loadOrderSummary);
    await waitFor(() => expect(loadOrderSummary).toHaveBeenCalledTimes(1));

    const browseMenu = screen.getByRole('link', { name: 'Browse the menu' });
    browseMenu.focus();
    expect(browseMenu).toHaveFocus();
    rejectSummary(new TypeError('offline'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Order summary unavailable',
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(browseMenu).toHaveFocus();
  });

  it('honors positive Retry-After without automatic retry or a new key', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ headers: { 'Retry-After': '2' }, status: 429 });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout();
    const button = screen.getByRole('button', { name: 'Continue to secure payment' });

    fireEvent.click(button);
    await act(async () => undefined);

    const visibleCountdown = screen.getByText(/wait 2 seconds/i);
    expect(visibleCountdown).toBeVisible();
    expect(visibleCountdown).toHaveAttribute('aria-hidden', 'true');
    expect(
      screen.getByText(
        'Payment retry is temporarily unavailable. The same payment attempt will be reused.',
      ),
    ).toBeInTheDocument();
    expect(button).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const updatedCountdown = screen.getByText(/wait 1 second/i);
    expect(updatedCountdown).toBeVisible();
    expect(updatedCountdown).toHaveAttribute('aria-hidden', 'true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText('Payment retry ready')).toBeVisible();
    expect(
      screen.getByText('You can now retry this same payment attempt.'),
    ).toBeVisible();
    expect(
      screen.queryByText(
        'Payment retry is temporarily unavailable. The same payment attempt will be reused.',
      ),
    ).not.toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(stub.calls).toHaveLength(1);
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
  });

  it('creates a new key only after explicit action following definitive 502', async () => {
    const user = userEvent.setup();
    vi.mocked(window.crypto.randomUUID).mockReturnValueOnce(SECOND_KEY);
    const stub = installFetchStub({ status: 502 });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout();

    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    const newAttemptButton = await screen.findByRole('button', {
      name: 'Start a new payment attempt',
    });
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
    expect(stub.calls).toHaveLength(1);
    await user.click(newAttemptButton);
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(SECOND_KEY);
    expect(stub.calls).toHaveLength(1);
    const checkoutButton = screen.getByRole('button', {
      name: 'Continue to secure payment',
    });
    expect(checkoutButton).toBeEnabled();
    await waitFor(() => expect(checkoutButton).toHaveFocus());
  });

  it.each([503, 404, 409, 422])(
    'retries HTTP %s with the same stored key',
    async (status) => {
      const user = userEvent.setup();
      const stub = installFetchStub({ status }, { json: VALID_CHECKOUT, status: 200 });
      saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
      seedAttempt();
      renderCheckout();

      await user.click(
        screen.getByRole('button', { name: 'Continue to secure payment' }),
      );
      await screen.findByRole('alert');
      await user.click(
        screen.getByRole('button', { name: 'Continue to secure payment' }),
      );

      await waitFor(() => expect(stub.calls).toHaveLength(2));
      expect(stub.calls.map((call) => call.headers.get('Idempotency-Key'))).toEqual([
        FIRST_KEY,
        FIRST_KEY,
      ]);
    },
  );

  it('preserves the same attempt after an uncertain network failure', async () => {
    const user = userEvent.setup();
    const stub = installFetchStub(
      { error: new TypeError('offline') },
      { json: VALID_CHECKOUT, status: 200 },
    );
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout();

    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection ended/i);
    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    await waitFor(() => expect(stub.calls).toHaveLength(2));
    expect(stub.calls[0]?.headers.get('Idempotency-Key')).toBe(FIRST_KEY);
    expect(stub.calls[1]?.headers.get('Idempotency-Key')).toBe(FIRST_KEY);
  });

  it('preserves the same attempt after a checkout timeout', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub(
      { waitForAbort: true },
      { json: VALID_CHECKOUT, status: 200 },
    );
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout();

    fireEvent.click(screen.getByRole('button', { name: 'Continue to secure payment' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/connection ended/i);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to secure payment' }));
    await act(async () => undefined);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls.map((call) => call.headers.get('Idempotency-Key'))).toEqual([
      FIRST_KEY,
      FIRST_KEY,
    ]);
  });

  it('retries a failed redirect from memory without another API request', async () => {
    const user = userEvent.setup();
    const redirect = vi
      .fn<(checkoutUrl: string) => void>()
      .mockImplementationOnce(() => {
        throw new Error('navigation blocked');
      });
    const stub = installFetchStub({ json: VALID_CHECKOUT, status: 201 });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    renderCheckout(PUBLIC_ORDER_NUMBER, null, redirect);

    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Try payment redirect again' }),
    );

    expect(redirect).toHaveBeenCalledTimes(2);
    expect(stub.calls).toHaveLength(1);
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
    expect(
      sessionStorage.getItem(getCheckoutAttemptStorageKey(PUBLIC_ORDER_NUMBER)),
    ).not.toContain(VALID_CHECKOUT.checkout_url);
  });

  it('replays the API with the persisted key after reload from redirect failure', async () => {
    const user = userEvent.setup();
    const firstRedirect = vi.fn(() => {
      throw new Error('blocked');
    });
    const secondRedirect = vi.fn();
    const stub = installFetchStub(
      { json: VALID_CHECKOUT, status: 201 },
      { json: VALID_CHECKOUT, status: 200 },
    );
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);
    seedAttempt();
    const firstRender = renderCheckout(PUBLIC_ORDER_NUMBER, null, firstRedirect);
    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );
    await screen.findByRole('button', { name: 'Try payment redirect again' });
    firstRender.unmount();

    renderCheckout(PUBLIC_ORDER_NUMBER, null, secondRedirect);
    await user.click(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    );

    await waitFor(() => expect(secondRedirect).toHaveBeenCalledTimes(1));
    expect(stub.calls.map((call) => call.headers.get('Idempotency-Key'))).toEqual([
      FIRST_KEY,
      FIRST_KEY,
    ]);
  });

  it('shows a capability error when secure UUID generation is unavailable', () => {
    vi.mocked(window.crypto.randomUUID).mockImplementation(() => {
      throw new DOMException('Unavailable', 'NotSupportedError');
    });
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);

    renderCheckout();

    expect(screen.getByRole('alert')).toHaveTextContent(/cannot securely create/i);
    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeDisabled();
  });
});
