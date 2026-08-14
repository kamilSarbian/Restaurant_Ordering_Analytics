import { afterEach, vi } from 'vitest';

import { AuthenticatedApiRequestError } from '../../api/authenticatedApi';
import { installFetchStub } from '../../test/fetchStub';
import { fetchAccountOrder, fetchAccountOrders } from './accountApi';

const ACCESS_TOKEN = 'synthetic-account-access-token';
const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const LIST_ITEM = {
  created_at: '2026-08-12T08:00:00+02:00',
  currency: 'NOK',
  order_type: 'takeaway',
  public_order_number: PUBLIC_ORDER_NUMBER,
  status: 'preparing',
  total_amount: 53700,
  updated_at: '2026-08-12T08:05:00+02:00',
};
const LIST_RESPONSE = {
  items: [LIST_ITEM],
  limit: 50,
  offset: 0,
  total: 1,
};
const DETAIL_RESPONSE = {
  created_at: '2026-08-12T08:00:00+02:00',
  currency: 'NOK',
  items: [
    {
      line_total_amount: 53700,
      menu_item_id: '00000000-0000-4000-8000-000000000011',
      name: 'Synthetic order item',
      quantity: 1,
      unit_price_amount: 53700,
    },
  ],
  order_type: 'takeaway',
  public_order_number: PUBLIC_ORDER_NUMBER,
  status: 'preparing',
  subtotal_amount: 53700,
  table_number: null,
  total_amount: 53700,
  updated_at: '2026-08-12T08:05:00+02:00',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('canonical customer account API', () => {
  it('maps the strict list DTO while preserving minor units and safe metadata', async () => {
    const stub = installFetchStub({ json: LIST_RESPONSE });

    const response = await fetchAccountOrders({ accessToken: ACCESS_TOKEN });

    expect(response).toEqual({
      items: [
        {
          createdAt: '2026-08-12T08:00:00+02:00',
          currency: 'NOK',
          orderType: 'takeaway',
          publicOrderNumber: PUBLIC_ORDER_NUMBER,
          status: 'preparing',
          totalAmount: 53700,
          updatedAt: '2026-08-12T08:05:00+02:00',
        },
      ],
      limit: 50,
      offset: 0,
      total: 1,
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      body: null,
      method: 'GET',
      url: '/api/v1/account/orders?limit=50&offset=0',
    });
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(stub.calls[0]?.headers.get('Accept')).toBe('application/json');
    expect(stub.calls[0]?.headers.has('X-Order-Access-Token')).toBe(false);
    expect(stub.calls[0]?.url).not.toContain(ACCESS_TOKEN);
  });

  it('uses exact bounded pagination parameters', async () => {
    const stub = installFetchStub({
      json: { items: [], limit: 25, offset: 75, total: 75 },
    });

    await fetchAccountOrders({
      accessToken: ACCESS_TOKEN,
      limit: 25,
      offset: 75,
    });

    expect(stub.calls[0]?.url).toBe('/api/v1/account/orders?limit=25&offset=75');
  });

  it('reuses the strict customer-safe order-status parser for detail', async () => {
    const stub = installFetchStub({ json: DETAIL_RESPONSE });

    await expect(
      fetchAccountOrder(PUBLIC_ORDER_NUMBER, { accessToken: ACCESS_TOKEN }),
    ).resolves.toEqual(DETAIL_RESPONSE);
    expect(stub.calls[0]?.url).toBe(`/api/v1/account/orders/${PUBLIC_ORDER_NUMBER}`);
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(stub.calls[0]?.headers.has('X-Order-Access-Token')).toBe(false);
    expect(stub.calls[0]?.url).not.toContain(ACCESS_TOKEN);
  });

  it.each([401, 404, 422, 503])(
    'preserves typed HTTP status %s without exposing a response body',
    async (status) => {
      installFetchStub({ json: { detail: 'private backend detail' }, status });

      const request =
        status === 404
          ? fetchAccountOrder(PUBLIC_ORDER_NUMBER, { accessToken: ACCESS_TOKEN })
          : fetchAccountOrders({ accessToken: ACCESS_TOKEN });
      const error = await request.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AuthenticatedApiRequestError);
      expect(error).toMatchObject({ kind: 'http', status });
      expect(String(error)).not.toContain('private backend detail');
    },
  );

  it('preserves a typed network failure', async () => {
    installFetchStub({ error: new TypeError('offline detail') });

    await expect(
      fetchAccountOrders({ accessToken: ACCESS_TOKEN }),
    ).rejects.toMatchObject({ kind: 'network', status: null });
  });

  it('forwards an external abort without retrying', async () => {
    const stub = installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = fetchAccountOrder(PUBLIC_ORDER_NUMBER, {
      accessToken: ACCESS_TOKEN,
      signal: controller.signal,
    });

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted', status: null });
    expect(stub.calls).toHaveLength(1);
  });

  it('uses the authenticated transport timeout without retrying', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ waitForAbort: true });
    const request = fetchAccountOrders({ accessToken: ACCESS_TOKEN });
    const rejection = expect(request).rejects.toMatchObject({
      kind: 'timeout',
      status: null,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(stub.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { ...LIST_RESPONSE, unexpected: true },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEM, owner_id: 'private' }] },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEM, status: 'paid' }] },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEM, order_type: 'delivery' }] },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEM, total_amount: 537.5 }] },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEM, currency: 'nok' }] },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEM, created_at: '2026-08-12' }] },
    { ...LIST_RESPONSE, total: '1' },
    { ...LIST_RESPONSE, limit: 25 },
  ])('rejects a malformed or expanded list DTO %#', async (payload) => {
    installFetchStub({ json: payload });

    const error = await fetchAccountOrders({ accessToken: ACCESS_TOKEN }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AuthenticatedApiRequestError);
    expect(error).toMatchObject({ kind: 'invalid-response', status: null });
  });

  it('wraps an invalid detail DTO as a safe authenticated response error', async () => {
    installFetchStub({ json: { ...DETAIL_RESPONSE, payment_status: 'succeeded' } });

    const error = await fetchAccountOrder(PUBLIC_ORDER_NUMBER, {
      accessToken: ACCESS_TOKEN,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthenticatedApiRequestError);
    expect(error).toMatchObject({ kind: 'invalid-response', status: null });
  });

  it.each([
    { limit: 0, offset: 0 },
    { limit: 101, offset: 0 },
    { limit: 50.5, offset: 0 },
    { limit: 50, offset: -1 },
    { limit: 50, offset: Number.NaN },
  ])('rejects invalid pagination before fetch: %#', async ({ limit, offset }) => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      fetchAccountOrders({ accessToken: ACCESS_TOKEN, limit, offset }),
    ).rejects.toMatchObject({ kind: 'invalid-response', status: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed detail number before fetch', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      fetchAccountOrder('../admin/orders', { accessToken: ACCESS_TOKEN }),
    ).rejects.toMatchObject({ kind: 'invalid-response', status: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
