import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../test/fetchStub';
import { AdminApiRequestError, adminRequestBlob, adminRequestJson } from './adminApi';

const SYNTHETIC_TOKEN = 'test-admin-token';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('administrator HTTP transport', () => {
  it('adds the exact Bearer header only to a canonical admin path', async () => {
    const stub = installFetchStub({ json: { ok: true } });

    await adminRequestJson('/api/v1/admin/orders', {
      accessToken: SYNTHETIC_TOKEN,
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
    expect(stub.calls[0]?.headers.get('Content-Type')).toBeNull();
    expect(stub.calls[0]?.method).toBe('GET');
  });

  it.each([
    '/api/v1/menu',
    '/api/v1/orders/quote',
    '/api/v1/admin/../menu',
    '//example.invalid/api/v1/admin/orders',
    '/api/v1/admin/orders#fragment',
  ])('rejects the non-canonical admin path %s before fetch', async (path) => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      adminRequestJson(path, { accessToken: SYNTHETIC_TOKEN }),
    ).rejects.toMatchObject({ kind: 'invalid-response', status: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends JSON content type and the exact POST body only when supplied', async () => {
    const stub = installFetchStub({ json: { ok: true } });

    await adminRequestJson('/api/v1/admin/menu/categories', {
      body: { display_order: 10, name: 'Synthetic category' },
      method: 'POST',
    });

    expect(stub.calls[0]?.headers.get('Authorization')).toBeNull();
    expect(stub.calls[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(stub.calls[0]?.body).toBe(
      JSON.stringify({
        display_order: 10,
        name: 'Synthetic category',
      }),
    );
  });

  it('preserves HTTP status and a positive Retry-After value', async () => {
    installFetchStub({ headers: { 'Retry-After': '17' }, status: 429 });

    const error = await adminRequestJson('/api/v1/admin/orders').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AdminApiRequestError);
    expect(error).toMatchObject({
      kind: 'http',
      retryAfterSeconds: 17,
      status: 429,
    });
  });

  it.each(['0', '-1', 'later', '1.5'])(
    'ignores a malformed Retry-After value %s',
    async (retryAfter) => {
      installFetchStub({ headers: { 'Retry-After': retryAfter }, status: 429 });

      await expect(adminRequestJson('/api/v1/admin/orders')).rejects.toMatchObject({
        retryAfterSeconds: null,
        status: 429,
      });
    },
  );

  it('maps a rejected fetch to a network error', async () => {
    installFetchStub({ error: new TypeError('offline') });

    await expect(adminRequestJson('/api/v1/admin/orders')).rejects.toMatchObject({
      kind: 'network',
      status: null,
    });
  });

  it('aborts on timeout and preserves the timeout category', async () => {
    vi.useFakeTimers();
    installFetchStub({ waitForAbort: true });
    const request = adminRequestJson('/api/v1/admin/orders', { timeoutMs: 25 });
    const expectation = expect(request).rejects.toMatchObject({
      kind: 'timeout',
      status: null,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expectation;
  });

  it('forwards an external abort without classifying it as a timeout', async () => {
    installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = adminRequestJson('/api/v1/admin/orders', {
      signal: controller.signal,
    });

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted', status: null });
  });

  it('rejects malformed JSON as an invalid response', async () => {
    installFetchStub({ body: '{broken', status: 200 });

    await expect(adminRequestJson('/api/v1/admin/orders')).rejects.toMatchObject({
      kind: 'invalid-response',
      status: null,
    });
  });

  it('rejects an empty access token before issuing a request', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      adminRequestJson('/api/v1/admin/orders', { accessToken: '   ' }),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves a Blob and its response metadata for an authenticated admin GET', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    const stub = installFetchStub({
      body: bytes as unknown as string,
      headers: {
        'Content-Disposition': 'attachment; filename="orders.csv"',
        'Content-Type': 'text/csv; charset=utf-8',
      },
    });

    const result = await adminRequestBlob('/api/v1/admin/exports/orders.csv', {
      accessToken: SYNTHETIC_TOKEN,
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.body).toBeNull();
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
    expect(stub.calls[0]?.headers.get('Content-Type')).toBeNull();
    expect(stub.calls[0]?.headers.get('Accept')).toBe('text/csv');
    expect(stub.calls[0]?.method).toBe('GET');
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/csv; charset=utf-8');
    expect(result.contentDisposition).toBe('attachment; filename="orders.csv"');
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
  });

  it('represents missing Blob response headers as null', async () => {
    installFetchStub({});

    const result = await adminRequestBlob('/api/v1/admin/exports/orders.csv', {
      accessToken: SYNTHETIC_TOKEN,
    });

    expect(result.contentType).toBeNull();
    expect(result.contentDisposition).toBeNull();
  });

  it.each([
    '/api/v1/menu',
    '/api/v1/orders/ROA-TEST',
    'https://example.invalid/api/v1/admin/exports/orders.csv',
    '//example.invalid/api/v1/admin/exports/orders.csv',
    'not-an-admin-path',
  ])('rejects the Blob request path %s locally', async (path) => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      adminRequestBlob(path, { accessToken: SYNTHETIC_TOKEN }),
    ).rejects.toMatchObject({ kind: 'invalid-response', status: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([401, 422, 503])(
    'preserves HTTP %s and positive Retry-After metadata for a Blob request',
    async (status) => {
      installFetchStub({ headers: { 'Retry-After': '11' }, status });

      const error = await adminRequestBlob('/api/v1/admin/exports/orders.csv', {
        accessToken: SYNTHETIC_TOKEN,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AdminApiRequestError);
      expect(error).toMatchObject({
        kind: 'http',
        retryAfterSeconds: 11,
        status,
      });
    },
  );

  it('maps a rejected Blob fetch to a network error', async () => {
    installFetchStub({ error: new TypeError('offline') });

    await expect(
      adminRequestBlob('/api/v1/admin/exports/orders.csv', {
        accessToken: SYNTHETIC_TOKEN,
      }),
    ).rejects.toMatchObject({ kind: 'network', status: null });
  });

  it('uses the 30-second Blob timeout and issues no duplicate request', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ waitForAbort: true });
    const request = adminRequestBlob('/api/v1/admin/exports/orders.csv', {
      accessToken: SYNTHETIC_TOKEN,
    });
    const expectation = expect(request).rejects.toMatchObject({
      kind: 'timeout',
      status: null,
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(stub.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    await expectation;
    expect(stub.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards a caller abort for a Blob request without reporting a timeout', async () => {
    installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = adminRequestBlob('/api/v1/admin/exports/orders.csv', {
      accessToken: SYNTHETIC_TOKEN,
      signal: controller.signal,
    });

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted', status: null });
  });

  it('clears the Blob timeout after a successful response', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ body: 'csv-bytes' });

    await adminRequestBlob('/api/v1/admin/exports/orders.csv', {
      accessToken: SYNTHETIC_TOKEN,
    });

    expect(stub.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stub.calls).toHaveLength(1);
  });
});
