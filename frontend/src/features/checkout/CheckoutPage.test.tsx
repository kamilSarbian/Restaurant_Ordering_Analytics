import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
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
const ACCESS_TOKEN = 'guest-access-token-that-must-stay-private';
const FIRST_KEY = '00000000-0000-4000-8000-000000000004';
const SECOND_KEY = '00000000-0000-4000-8000-000000000014';
const VALID_CHECKOUT = {
  checkout_url: 'https://checkout.example.test/session/hosted',
  expires_at: '2026-08-11T15:30:00Z',
  payment_status: 'pending',
  public_order_number: PUBLIC_ORDER_NUMBER,
};

function renderCheckout(
  publicOrderNumber = PUBLIC_ORDER_NUMBER,
  state: unknown = null,
  redirectToCheckout: (checkoutUrl: string) => void = vi.fn(),
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
      <CartProvider>
        <Routes>
          <Route
            path="/orders/:publicOrderNumber/checkout"
            element={<CheckoutPage redirectToCheckout={redirectToCheckout} />}
          />
        </Routes>
      </CartProvider>
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
    vi.spyOn(window.crypto, 'randomUUID').mockReturnValue(FIRST_KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('shows the exact checkout CTA without calling the API on mount', () => {
    const stub = installFetchStub();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, ACCESS_TOKEN);

    renderCheckout();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order created' }),
    ).toBeVisible();
    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeEnabled();
    expect(screen.queryByText(ACCESS_TOKEN)).not.toBeInTheDocument();
    expect(screen.queryByText(FIRST_KEY)).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
    expect(window.crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('uses transient navigation access and never renders the token', () => {
    renderCheckout(PUBLIC_ORDER_NUMBER, {
      orderAccessToken: ACCESS_TOKEN,
      publicOrderNumber: PUBLIC_ORDER_NUMBER,
    });

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order created' }),
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

  it('keeps an in-memory attempt when sessionStorage raises SecurityError', () => {
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

    renderCheckout(PUBLIC_ORDER_NUMBER, {
      orderAccessToken: ACCESS_TOKEN,
      publicOrderNumber: PUBLIC_ORDER_NUMBER,
    });

    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeEnabled();
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
      '/',
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
    expect(screen.getByRole('status')).toHaveTextContent('Creating secure checkout…');
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

    expect(await screen.findByRole('alert')).toHaveTextContent(/unsafe or invalid/i);
    expect(redirect).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('restaurant-ordering:cart:v1')).toBe(cartValue);
    expect(loadCheckoutAttempt(PUBLIC_ORDER_NUMBER)?.idempotencyKey).toBe(FIRST_KEY);
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

    expect(screen.getByRole('alert')).toHaveTextContent(/wait 2 seconds/i);
    expect(button).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
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
    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeEnabled();
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
