import { afterEach, vi } from 'vitest';

import { requestJson } from './client';
import {
  CheckoutRequestError,
  createCheckoutSession,
  createOrder,
  fetchMenu,
  fetchOrderStatus,
  quoteOrder,
} from './customerApi';
import { installFetchStub } from '../test/fetchStub';

const VALID_MENU = {
  categories: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Second category',
      description: null,
      display_order: 20,
      items: [
        {
          id: '00000000-0000-4000-8000-000000000011',
          name: 'Second item',
          description: null,
          image_url: null,
          price_amount: 15900,
          currency: 'NOK',
          allergens: [],
          display_order: 20,
          is_available: false,
        },
        {
          id: '00000000-0000-4000-8000-000000000010',
          name: 'First item',
          description: 'Kept in backend order.',
          image_url: 'https://images.example.test/first-item.jpg',
          price_amount: 12900,
          currency: 'NOK',
          allergens: ['milk'],
          display_order: 10,
          is_available: true,
        },
      ],
    },
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'First category',
      description: 'Also kept in backend order.',
      display_order: 10,
      items: [
        {
          id: '00000000-0000-4000-8000-000000000012',
          name: 'Only item',
          description: null,
          image_url: null,
          price_amount: 9900,
          currency: 'NOK',
          allergens: ['egg'],
          display_order: 0,
          is_available: true,
        },
      ],
    },
  ],
};

const QUOTE_ITEMS = [
  {
    menu_item_id: '00000000-0000-4000-8000-000000000010',
    quantity: 2,
  },
];

const VALID_QUOTE = {
  currency: 'NOK',
  items: [
    {
      line_total_amount: 25800,
      menu_item_id: '00000000-0000-4000-8000-000000000010',
      name: 'First item',
      quantity: 2,
      unit_price_amount: 12900,
    },
  ],
  subtotal_amount: 25800,
  total_amount: 25800,
};

const VALID_ORDER = {
  currency: 'NOK',
  items: VALID_QUOTE.items,
  order_access_token: 'one-time-guest-access-token',
  order_type: 'takeaway',
  public_order_number: 'ROA-23456789ABCD',
  status: 'created',
  subtotal_amount: 25800,
  table_number: null,
  total_amount: 25800,
};

const CHECKOUT_KEY = '00000000-0000-4000-8000-000000000004';
const CANONICAL_ACCESS_TOKEN = 'canonical-customer-access-token';
const VALID_CHECKOUT = {
  checkout_url: 'https://checkout.example.test/session/hosted',
  expires_at: '2026-08-11T15:30:00Z',
  payment_status: 'pending',
  public_order_number: VALID_ORDER.public_order_number,
};

function guestCheckoutOptions(signal?: AbortSignal) {
  return {
    guestAccessToken: VALID_ORDER.order_access_token,
    idempotencyKey: CHECKOUT_KEY,
    signal,
  };
}

function guestStatusOptions(signal?: AbortSignal) {
  return {
    guestAccessToken: VALID_ORDER.order_access_token,
    signal,
  };
}

const VALID_ORDER_STATUS = {
  created_at: '2026-08-11T15:00:00Z',
  currency: VALID_ORDER.currency,
  items: VALID_ORDER.items,
  order_type: VALID_ORDER.order_type,
  public_order_number: VALID_ORDER.public_order_number,
  status: VALID_ORDER.status,
  subtotal_amount: VALID_ORDER.subtotal_amount,
  table_number: VALID_ORDER.table_number,
  total_amount: VALID_ORDER.total_amount,
  updated_at: '2026-08-11T15:05:00+00:00',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('quoteOrder', () => {
  it('uses the exact POST endpoint, JSON content type, and minimal body', async () => {
    const stub = installFetchStub({ json: VALID_QUOTE });

    await quoteOrder(QUOTE_ITEMS);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      body: JSON.stringify({ items: QUOTE_ITEMS }),
      method: 'POST',
      url: '/api/v1/orders/quote',
    });
    expect(stub.calls[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(stub.calls[0]?.headers.has('Authorization')).toBe(false);
    expect(stub.calls[0]?.headers.has('X-Order-Access-Token')).toBe(false);
    expect(JSON.parse(stub.calls[0]?.body ?? '')).toEqual({ items: QUOTE_ITEMS });
  });

  it('parses the complete server-authoritative quote', async () => {
    installFetchStub({ json: VALID_QUOTE });

    await expect(quoteOrder(QUOTE_ITEMS)).resolves.toEqual(VALID_QUOTE);
  });

  it('rejects duplicate request lines before fetch', async () => {
    const stub = installFetchStub();

    await expect(quoteOrder([...QUOTE_ITEMS, ...QUOTE_ITEMS])).rejects.toMatchObject({
      kind: 'invalid-response',
    });
    expect(stub.calls).toHaveLength(0);
  });

  it.each([
    ['floating money', { ...VALID_QUOTE, total_amount: 25800.5 }],
    ['zero money', { ...VALID_QUOTE, subtotal_amount: 0 }],
    ['malformed currency', { ...VALID_QUOTE, currency: 'nok' }],
    ['missing field', { currency: 'NOK', items: VALID_QUOTE.items }],
  ])('rejects %s as an invalid response', async (_label, response) => {
    installFetchStub({ json: response });

    await expect(quoteOrder(QUOTE_ITEMS)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('rejects a response that does not correspond to the request', async () => {
    const mismatchedQuote = structuredClone(VALID_QUOTE);
    mismatchedQuote.items[0]!.quantity = 1;
    installFetchStub({ json: mismatchedQuote });

    await expect(quoteOrder(QUOTE_ITEMS)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it.each([422, 409])('preserves the safe HTTP status %s', async (status) => {
    installFetchStub({ json: { detail: 'not exposed' }, status });

    const request = quoteOrder(QUOTE_ITEMS);
    await expect(request).rejects.toMatchObject({ kind: 'http', status });
    await expect(request).rejects.not.toThrow('not exposed');
  });

  it('classifies a network failure', async () => {
    installFetchStub({ error: new TypeError('offline details') });

    await expect(quoteOrder(QUOTE_ITEMS)).rejects.toMatchObject({ kind: 'network' });
  });

  it('classifies an externally aborted quote', async () => {
    installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = quoteOrder(QUOTE_ITEMS, controller.signal);

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('classifies the bounded quote timeout', async () => {
    vi.useFakeTimers();
    installFetchStub({ waitForAbort: true });
    const request = quoteOrder(QUOTE_ITEMS);
    const rejection = expect(request).rejects.toMatchObject({ kind: 'timeout' });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
  });
});

describe('createOrder', () => {
  it('posts the exact minimal takeaway body without authentication or idempotency', async () => {
    const stub = installFetchStub({ json: VALID_ORDER, status: 201 });

    await createOrder({ items: QUOTE_ITEMS, order_type: 'takeaway' });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      body: JSON.stringify({ items: QUOTE_ITEMS, order_type: 'takeaway' }),
      method: 'POST',
      url: '/api/v1/orders',
    });
    expect(stub.calls[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(stub.calls[0]?.headers.has('Authorization')).toBe(false);
    expect(stub.calls[0]?.headers.has('Idempotency-Key')).toBe(false);
    expect(JSON.parse(stub.calls[0]?.body ?? '')).toEqual({
      items: QUOTE_ITEMS,
      order_type: 'takeaway',
    });
  });

  it('posts the exact dine-in body with a positive table number', async () => {
    const dineInOrder = {
      ...VALID_ORDER,
      order_type: 'dine_in',
      table_number: 7,
    };
    const stub = installFetchStub({ json: dineInOrder, status: 201 });

    await createOrder({
      items: QUOTE_ITEMS,
      order_type: 'dine_in',
      table_number: 7,
    });

    expect(JSON.parse(stub.calls[0]?.body ?? '')).toEqual({
      items: QUOTE_ITEMS,
      order_type: 'dine_in',
      table_number: 7,
    });
  });

  it('attaches only the explicit canonical Bearer for authenticated creation', async () => {
    const stub = installFetchStub({ json: VALID_ORDER, status: 201 });

    await createOrder(
      { items: QUOTE_ITEMS, order_type: 'takeaway' },
      { accessToken: CANONICAL_ACCESS_TOKEN },
    );

    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${CANONICAL_ACCESS_TOKEN}`,
    );
    expect(stub.calls[0]?.headers.has('X-Order-Access-Token')).toBe(false);
    expect(stub.calls[0]?.url).toBe('/api/v1/orders');
    expect(stub.calls[0]?.url).not.toContain(CANONICAL_ACCESS_TOKEN);
  });

  it.each(['', '   ', 'token with whitespace'])(
    'rejects invalid explicit create Bearer %# before fetch',
    async (accessToken) => {
      const stub = installFetchStub();

      await expect(
        createOrder({ items: QUOTE_ITEMS, order_type: 'takeaway' }, { accessToken }),
      ).rejects.toMatchObject({ kind: 'invalid-response' });
      expect(stub.calls).toHaveLength(0);
    },
  );

  it('keeps a create 401 typed and never retries as a guest', async () => {
    const stub = installFetchStub({ status: 401 });

    await expect(
      createOrder(
        { items: QUOTE_ITEMS, order_type: 'takeaway' },
        { accessToken: CANONICAL_ACCESS_TOKEN },
      ),
    ).rejects.toMatchObject({ kind: 'http', status: 401 });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${CANONICAL_ACCESS_TOKEN}`,
    );
  });

  it('sends only identifiers and quantities without prices, totals, currency, or PII', async () => {
    const stub = installFetchStub({ json: VALID_ORDER, status: 201 });

    await createOrder({ items: QUOTE_ITEMS, order_type: 'takeaway' });

    const serializedBody = stub.calls[0]?.body ?? '';
    expect(serializedBody).not.toMatch(
      /price|amount|currency|name|customer|email|phone|address|token/i,
    );
  });

  it('parses the exact valid 201 public order response', async () => {
    installFetchStub({ json: VALID_ORDER, status: 201 });

    await expect(
      createOrder({ items: QUOTE_ITEMS, order_type: 'takeaway' }),
    ).resolves.toEqual(VALID_ORDER);
  });

  it.each([
    ['public number', { ...VALID_ORDER, public_order_number: 'internal-uuid' }],
    ['empty token', { ...VALID_ORDER, order_access_token: '' }],
    ['blank token', { ...VALID_ORDER, order_access_token: '   ' }],
    ['floating money', { ...VALID_ORDER, total_amount: 25800.5 }],
    ['zero money', { ...VALID_ORDER, subtotal_amount: 0 }],
    ['currency', { ...VALID_ORDER, currency: 'nok' }],
    ['status', { ...VALID_ORDER, status: 'paid' }],
    ['takeaway table', { ...VALID_ORDER, table_number: 4 }],
  ])('rejects malformed order response field: %s', async (_field, response) => {
    installFetchStub({ json: response, status: 201 });

    await expect(
      createOrder({ items: QUOTE_ITEMS, order_type: 'takeaway' }),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('rejects internal or extra response fields', async () => {
    installFetchStub({
      json: { ...VALID_ORDER, id: '00000000-0000-4000-8000-000000000099' },
      status: 201,
    });

    await expect(
      createOrder({ items: QUOTE_ITEMS, order_type: 'takeaway' }),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it.each([422, 429])('preserves definitive order HTTP status %s', async (status) => {
    installFetchStub({ json: { detail: 'private backend context' }, status });

    const request = createOrder({ items: QUOTE_ITEMS, order_type: 'takeaway' });
    await expect(request).rejects.toMatchObject({ kind: 'http', status });
    await expect(request).rejects.not.toThrow('private backend context');
  });

  it('classifies an ambiguous network outcome', async () => {
    installFetchStub({ error: new TypeError('connection closed') });

    await expect(
      createOrder({ items: QUOTE_ITEMS, order_type: 'takeaway' }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('classifies an externally aborted order request', async () => {
    installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = createOrder(
      { items: QUOTE_ITEMS, order_type: 'takeaway' },
      { signal: controller.signal },
    );

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('classifies an ambiguous order timeout without retrying', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ waitForAbort: true });
    const request = createOrder({ items: QUOTE_ITEMS, order_type: 'takeaway' });
    const rejection = expect(request).rejects.toMatchObject({ kind: 'timeout' });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(stub.calls).toHaveLength(1);
  });
});

describe('createCheckoutSession', () => {
  it('posts to the exact endpoint with only guest access and idempotency headers', async () => {
    const stub = installFetchStub({ json: VALID_CHECKOUT, status: 201 });

    await createCheckoutSession(
      VALID_ORDER.public_order_number,
      guestCheckoutOptions(),
    );

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      body: null,
      method: 'POST',
      url: `/api/v1/orders/${VALID_ORDER.public_order_number}/checkout-session`,
    });
    expect([...stub.calls[0]!.headers.keys()].sort()).toEqual([
      'idempotency-key',
      'x-order-access-token',
    ]);
    expect(stub.calls[0]?.headers.get('X-Order-Access-Token')).toBe(
      VALID_ORDER.order_access_token,
    );
    expect(stub.calls[0]?.headers.get('Idempotency-Key')).toBe(CHECKOUT_KEY);
    expect(stub.calls[0]?.headers.has('Authorization')).toBe(false);
    expect(stub.calls[0]?.headers.has('Content-Type')).toBe(false);
    expect(stub.calls.map((call) => call.url)).not.toContain(
      VALID_CHECKOUT.checkout_url,
    );
  });

  it('supports authenticated owner checkout without a guest capability', async () => {
    const stub = installFetchStub({ json: VALID_CHECKOUT, status: 201 });

    await createCheckoutSession(VALID_ORDER.public_order_number, {
      accessToken: CANONICAL_ACCESS_TOKEN,
      idempotencyKey: CHECKOUT_KEY,
    });

    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${CANONICAL_ACCESS_TOKEN}`,
    );
    expect(stub.calls[0]?.headers.has('X-Order-Access-Token')).toBe(false);
    expect(stub.calls[0]?.headers.get('Idempotency-Key')).toBe(CHECKOUT_KEY);
    expect(stub.calls[0]?.url).not.toContain(CANONICAL_ACCESS_TOKEN);
  });

  it('sends Bearer, capability, and idempotency together when supplied', async () => {
    const stub = installFetchStub({ json: VALID_CHECKOUT, status: 200 });

    await createCheckoutSession(VALID_ORDER.public_order_number, {
      accessToken: CANONICAL_ACCESS_TOKEN,
      guestAccessToken: VALID_ORDER.order_access_token,
      idempotencyKey: CHECKOUT_KEY,
    });

    expect([...stub.calls[0]!.headers.keys()].sort()).toEqual([
      'authorization',
      'idempotency-key',
      'x-order-access-token',
    ]);
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${CANONICAL_ACCESS_TOKEN}`,
    );
    expect(stub.calls[0]?.headers.get('X-Order-Access-Token')).toBe(
      VALID_ORDER.order_access_token,
    );
  });

  it('rejects checkout without either supported credential before fetch', async () => {
    const stub = installFetchStub();

    await expect(
      createCheckoutSession(VALID_ORDER.public_order_number, {
        idempotencyKey: CHECKOUT_KEY,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(stub.calls).toHaveLength(0);
  });

  it.each([
    ['Bearer', { accessToken: 'bad token', idempotencyKey: CHECKOUT_KEY }],
    ['capability', { guestAccessToken: '   ', idempotencyKey: CHECKOUT_KEY }],
  ])('rejects invalid checkout %s before fetch', async (_label, options) => {
    const stub = installFetchStub();

    await expect(
      createCheckoutSession(VALID_ORDER.public_order_number, options),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(stub.calls).toHaveLength(0);
  });

  it('keeps a 401 typed and never retries without Bearer', async () => {
    const stub = installFetchStub({ status: 401 });

    await expect(
      createCheckoutSession(VALID_ORDER.public_order_number, {
        accessToken: CANONICAL_ACCESS_TOKEN,
        guestAccessToken: VALID_ORDER.order_access_token,
        idempotencyKey: CHECKOUT_KEY,
      }),
    ).rejects.toMatchObject({ kind: 'http', status: 401 });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${CANONICAL_ACCESS_TOKEN}`,
    );
  });

  it.each([200, 201])('accepts a valid %s checkout response', async (status) => {
    installFetchStub({ json: VALID_CHECKOUT, status });

    await expect(
      createCheckoutSession(VALID_ORDER.public_order_number, guestCheckoutOptions()),
    ).resolves.toEqual(VALID_CHECKOUT);
  });

  it.each([
    [
      'public number mismatch',
      { ...VALID_CHECKOUT, public_order_number: 'ROA-BCDEFGHJKLMN' },
    ],
    ['unknown status', { ...VALID_CHECKOUT, payment_status: 'processing' }],
    ['naive expiry', { ...VALID_CHECKOUT, expires_at: '2026-08-11T15:30:00' }],
    ['invalid expiry', { ...VALID_CHECKOUT, expires_at: 'not-a-date+01:00' }],
    ['extra internal field', { ...VALID_CHECKOUT, stripe_session_id: 'cs_private' }],
  ])('rejects malformed checkout response: %s', async (_label, response) => {
    installFetchStub({ json: response, status: 201 });

    await expect(
      createCheckoutSession(VALID_ORDER.public_order_number, guestCheckoutOptions()),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it.each([
    'javascript:alert(1)',
    'data:text/plain,checkout',
    'file:///tmp/checkout',
    '/relative-checkout',
    'http://checkout.example.test/session',
    'https://user:password@checkout.example.test/session',
  ])('rejects unsafe checkout URL %s', async (checkoutUrl) => {
    installFetchStub({
      json: { ...VALID_CHECKOUT, checkout_url: checkoutUrl },
      status: 201,
    });

    await expect(
      createCheckoutSession(VALID_ORDER.public_order_number, guestCheckoutOptions()),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it.each([
    'http://localhost:5173/payment-return',
    'http://127.0.0.1:5173/payment-return',
    'http://[::1]:5173/payment-return',
  ])('allows a local HTTP checkout URL %s', async (checkoutUrl) => {
    const response = { ...VALID_CHECKOUT, checkout_url: checkoutUrl };
    installFetchStub({ json: response, status: 200 });

    await expect(
      createCheckoutSession(VALID_ORDER.public_order_number, guestCheckoutOptions()),
    ).resolves.toEqual(response);
  });

  it.each([404, 409, 422, 429, 502, 503])(
    'preserves safe checkout HTTP status %s',
    async (status) => {
      installFetchStub({ json: { detail: 'private context' }, status });

      const request = createCheckoutSession(
        VALID_ORDER.public_order_number,
        guestCheckoutOptions(),
      );
      await expect(request).rejects.toMatchObject({ kind: 'http', status });
      await expect(request).rejects.not.toThrow('private context');
    },
  );

  it('exposes only a positive integer Retry-After value on a 429', async () => {
    installFetchStub({ headers: { 'Retry-After': '17' }, status: 429 });

    const error = await createCheckoutSession(
      VALID_ORDER.public_order_number,
      guestCheckoutOptions(),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CheckoutRequestError);
    expect(error).toMatchObject({ retryAfterSeconds: 17, status: 429 });
  });

  it.each(['0', '-2', '1.5', 'tomorrow'])(
    'ignores malformed Retry-After value %s',
    async (retryAfter) => {
      installFetchStub({ headers: { 'Retry-After': retryAfter }, status: 429 });

      const error = await createCheckoutSession(
        VALID_ORDER.public_order_number,
        guestCheckoutOptions(),
      ).catch((reason: unknown) => reason);

      expect(error).toMatchObject({ retryAfterSeconds: null, status: 429 });
    },
  );

  it('classifies a network failure without retrying', async () => {
    const stub = installFetchStub({ error: new TypeError('connection lost') });

    await expect(
      createCheckoutSession(VALID_ORDER.public_order_number, guestCheckoutOptions()),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(stub.calls).toHaveLength(1);
  });

  it('classifies an external abort', async () => {
    installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = createCheckoutSession(
      VALID_ORDER.public_order_number,
      guestCheckoutOptions(controller.signal),
    );

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('classifies the bounded checkout timeout', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ waitForAbort: true });
    const request = createCheckoutSession(
      VALID_ORDER.public_order_number,
      guestCheckoutOptions(),
    );
    const rejection = expect(request).rejects.toMatchObject({ kind: 'timeout' });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(stub.calls).toHaveLength(1);
  });
});

describe('fetchMenu', () => {
  it('uses the exact same-origin GET endpoint without availability filtering', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    const stub = installFetchStub({ json: VALID_MENU });

    await fetchMenu();

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({ method: 'GET', url: '/api/v1/menu' });
    expect(stub.calls[0]?.url).not.toContain('available_only');
    expect(stub.calls[0]?.headers.has('Authorization')).toBe(false);
    expect(stub.calls[0]?.headers.has('X-Order-Access-Token')).toBe(false);
  });

  it('normalizes a trailing slash on an explicit public base URL', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test///');
    const stub = installFetchStub({ json: VALID_MENU });

    await fetchMenu();

    expect(stub.calls[0]?.url).toBe('https://api.example.test/api/v1/menu');
  });

  it('parses a valid public menu response', async () => {
    const stub = installFetchStub({ json: VALID_MENU });

    const menu = await fetchMenu();

    expect(stub.calls).toHaveLength(1);
    expect(menu.categories).toHaveLength(2);
    expect(menu.categories[0]?.items[0]?.is_available).toBe(false);
  });

  it('preserves category and item order from the backend', async () => {
    installFetchStub({ json: VALID_MENU });

    const menu = await fetchMenu();

    expect(menu.categories.map((category) => category.name)).toEqual([
      'Second category',
      'First category',
    ]);
    expect(menu.categories[0]?.items.map((item) => item.name)).toEqual([
      'Second item',
      'First item',
    ]);
  });

  it('classifies invalid JSON as an invalid response', async () => {
    installFetchStub({ body: '{not-json' });

    await expect(fetchMenu()).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('rejects an invalid menu envelope without coercion', async () => {
    installFetchStub({ json: { categories: 'not-an-array' } });

    await expect(fetchMenu()).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('rejects invalid nested item fields', async () => {
    const invalidMenu = structuredClone(VALID_MENU);
    invalidMenu.categories[0]!.items[0]!.price_amount = 0;
    installFetchStub({ json: invalidMenu });

    await expect(fetchMenu()).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('returns a safe HTTP error for a server failure', async () => {
    installFetchStub({ json: { detail: 'private backend context' }, status: 500 });

    const request = fetchMenu();

    await expect(request).rejects.toMatchObject({ kind: 'http', status: 500 });
    await expect(request).rejects.not.toThrow('private backend context');
  });

  it('classifies a rejected fetch as a network failure', async () => {
    installFetchStub({ error: new TypeError('socket failure') });

    await expect(fetchMenu()).rejects.toMatchObject({ kind: 'network' });
  });

  it('distinguishes an externally aborted request', async () => {
    installFetchStub({ waitForAbort: true });
    const controller = new AbortController();

    const request = fetchMenu(controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('distinguishes an internal request timeout', async () => {
    installFetchStub({ waitForAbort: true });

    const request = requestJson('/api/v1/menu', { timeoutMs: 5 });

    await expect(request).rejects.toEqual(expect.objectContaining({ kind: 'timeout' }));
  });
});

describe('fetchOrderStatus', () => {
  it('uses the exact protected GET endpoint with only the guest token header', async () => {
    const stub = installFetchStub({ json: VALID_ORDER_STATUS });

    await fetchOrderStatus(VALID_ORDER.public_order_number, guestStatusOptions());

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      body: null,
      method: 'GET',
      url: `/api/v1/orders/${VALID_ORDER.public_order_number}`,
    });
    expect([...stub.calls[0]!.headers.keys()]).toEqual(['x-order-access-token']);
    expect(stub.calls[0]?.headers.get('X-Order-Access-Token')).toBe(
      VALID_ORDER.order_access_token,
    );
    expect(stub.calls[0]?.headers.has('Authorization')).toBe(false);
    expect(stub.calls[0]?.headers.has('Idempotency-Key')).toBe(false);
  });

  it('supports authenticated owner status with Bearer only', async () => {
    const stub = installFetchStub({ json: VALID_ORDER_STATUS });

    await fetchOrderStatus(VALID_ORDER.public_order_number, {
      accessToken: CANONICAL_ACCESS_TOKEN,
    });

    expect([...stub.calls[0]!.headers.keys()]).toEqual(['authorization']);
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${CANONICAL_ACCESS_TOKEN}`,
    );
    expect(stub.calls[0]?.url).not.toContain(CANONICAL_ACCESS_TOKEN);
  });

  it('forwards Bearer and guest capability together', async () => {
    const stub = installFetchStub({ json: VALID_ORDER_STATUS });

    await fetchOrderStatus(VALID_ORDER.public_order_number, {
      accessToken: CANONICAL_ACCESS_TOKEN,
      guestAccessToken: VALID_ORDER.order_access_token,
    });

    expect([...stub.calls[0]!.headers.keys()].sort()).toEqual([
      'authorization',
      'x-order-access-token',
    ]);
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${CANONICAL_ACCESS_TOKEN}`,
    );
    expect(stub.calls[0]?.headers.get('X-Order-Access-Token')).toBe(
      VALID_ORDER.order_access_token,
    );
  });

  it('allows the mixed route call shape with neither credential', async () => {
    const stub = installFetchStub({ json: VALID_ORDER_STATUS });

    await fetchOrderStatus(VALID_ORDER.public_order_number, {});

    expect([...stub.calls[0]!.headers.keys()]).toEqual([]);
  });

  it.each([
    ['Bearer', { accessToken: '' }],
    ['capability', { guestAccessToken: 'token with whitespace' }],
  ])('rejects invalid status %s before fetch', async (_label, options) => {
    const stub = installFetchStub();

    await expect(
      fetchOrderStatus(VALID_ORDER.public_order_number, options),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(stub.calls).toHaveLength(0);
  });

  it('keeps a status 401 typed and never retries anonymously', async () => {
    const stub = installFetchStub({ status: 401 });

    await expect(
      fetchOrderStatus(VALID_ORDER.public_order_number, {
        accessToken: CANONICAL_ACCESS_TOKEN,
        guestAccessToken: VALID_ORDER.order_access_token,
      }),
    ).rejects.toMatchObject({ kind: 'http', status: 401 });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${CANONICAL_ACCESS_TOKEN}`,
    );
  });

  it.each(['created', 'accepted', 'preparing', 'ready', 'completed', 'cancelled'])(
    'accepts fulfilment status %s',
    async (status) => {
      const response = { ...VALID_ORDER_STATUS, status };
      installFetchStub({ json: response });

      await expect(
        fetchOrderStatus(VALID_ORDER.public_order_number, guestStatusOptions()),
      ).resolves.toEqual(response);
    },
  );

  it.each([
    ['unknown status', { ...VALID_ORDER_STATUS, status: 'paid' }],
    [
      'public number mismatch',
      { ...VALID_ORDER_STATUS, public_order_number: 'ROA-BCDEFGHJKLMN' },
    ],
    ['floating total', { ...VALID_ORDER_STATUS, total_amount: 25800.5 }],
    ['zero subtotal', { ...VALID_ORDER_STATUS, subtotal_amount: 0 }],
    ['lowercase currency', { ...VALID_ORDER_STATUS, currency: 'nok' }],
    [
      'malformed item',
      {
        ...VALID_ORDER_STATUS,
        items: [{ ...VALID_ORDER_STATUS.items[0], quantity: 0 }],
      },
    ],
    ['naive timestamp', { ...VALID_ORDER_STATUS, created_at: '2026-08-11T15:00:00' }],
    ['invalid timestamp', { ...VALID_ORDER_STATUS, updated_at: 'not-a-date+01:00' }],
    ['takeaway table', { ...VALID_ORDER_STATUS, table_number: 7 }],
    ['internal field', { ...VALID_ORDER_STATUS, payment_status: 'succeeded' }],
  ])('rejects malformed status response: %s', async (_label, response) => {
    installFetchStub({ json: response });

    await expect(
      fetchOrderStatus(VALID_ORDER.public_order_number, guestStatusOptions()),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('accepts the exact dine-in table semantics', async () => {
    const response = {
      ...VALID_ORDER_STATUS,
      order_type: 'dine_in',
      table_number: 7,
    };
    installFetchStub({ json: response });

    await expect(
      fetchOrderStatus(VALID_ORDER.public_order_number, guestStatusOptions()),
    ).resolves.toEqual(response);
  });

  it('preserves the private 404 transport contract without exposing detail', async () => {
    installFetchStub({ json: { detail: 'Order not found' }, status: 404 });

    const request = fetchOrderStatus(
      VALID_ORDER.public_order_number,
      guestStatusOptions(),
    );
    await expect(request).rejects.toMatchObject({ kind: 'http', status: 404 });
    await expect(request).rejects.not.toThrow('Order not found');
  });

  it('classifies a status network failure', async () => {
    installFetchStub({ error: new TypeError('offline details') });

    await expect(
      fetchOrderStatus(VALID_ORDER.public_order_number, guestStatusOptions()),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('classifies an externally aborted status request', async () => {
    installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = fetchOrderStatus(
      VALID_ORDER.public_order_number,
      guestStatusOptions(controller.signal),
    );

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('preserves the ordinary 10-second status timeout', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ waitForAbort: true });
    const request = fetchOrderStatus(
      VALID_ORDER.public_order_number,
      guestStatusOptions(),
    );
    const rejection = expect(request).rejects.toMatchObject({ kind: 'timeout' });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(stub.calls).toHaveLength(1);
  });
});
