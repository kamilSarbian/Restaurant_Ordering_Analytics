import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../test/fetchStub';
import {
  AuthenticatedApiRequestError,
  authenticatedRequestJson,
} from './authenticatedApi';

const SYNTHETIC_TOKEN = 'synthetic-user-token';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('canonical authenticated HTTP transport', () => {
  it('sends the exact Bearer header to canonical /auth/me', async () => {
    const stub = installFetchStub({ json: { ok: true } });

    await authenticatedRequestJson('/api/v1/auth/me', {
      accessToken: SYNTHETIC_TOKEN,
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      body: null,
      method: 'GET',
      url: '/api/v1/auth/me',
    });
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
    expect(stub.calls[0]?.headers.get('Accept')).toBe('application/json');
    expect(stub.calls[0]?.url).not.toContain(SYNTHETIC_TOKEN);
  });

  it.each([
    '/api/v1/account/orders',
    '/api/v1/account/orders?limit=50&offset=0',
    '/api/v1/account/orders?offset=5&limit=10',
    '/api/v1/account/orders/ROA-23456789ABCD',
  ])('accepts the known canonical account path %s', async (path) => {
    const stub = installFetchStub({ json: { ok: true } });

    await authenticatedRequestJson(path, { accessToken: SYNTHETIC_TOKEN });

    expect(stub.calls[0]?.url).toBe(path);
  });

  it.each([
    'https://example.invalid/api/v1/auth/me',
    '//example.invalid/api/v1/auth/me',
    '/api/v1/admin/orders',
    '/api/v1/menu',
    '/api/v1/auth/login',
    '/api/v1/auth/me?unexpected=1',
    '/api/v1/auth/me#fragment',
    '/api/v1/account/../admin/orders',
    '/api/v1/account/%2e%2e/admin/orders',
    '/api/v1/account/orders?limit=101',
    '/api/v1/account/orders?limit=10&limit=20',
    '/api/v1/account/orders?unknown=1',
    '/api/v1/account/orders/roa-23456789abcd',
  ])('rejects non-allowlisted path %s before fetch', async (path) => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      authenticatedRequestJson(path, { accessToken: SYNTHETIC_TOKEN }),
    ).rejects.toMatchObject({ kind: 'invalid-response', status: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['', '   ', ' token-with-padding ', 'token with-space', 'token\nline'])(
    'rejects the invalid token %j before fetch',
    async (accessToken) => {
      const fetchSpy = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchSpy);

      await expect(
        authenticatedRequestJson('/api/v1/auth/me', { accessToken }),
      ).rejects.toMatchObject({ kind: 'invalid-response' });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('preserves an HTTP status and positive Retry-After value', async () => {
    installFetchStub({ headers: { 'Retry-After': '17' }, status: 503 });

    const error = await authenticatedRequestJson('/api/v1/auth/me', {
      accessToken: SYNTHETIC_TOKEN,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthenticatedApiRequestError);
    expect(error).toMatchObject({
      kind: 'http',
      retryAfterSeconds: 17,
      status: 503,
    });
  });

  it.each(['0', '-1', 'later', '1.5'])(
    'ignores malformed Retry-After %s',
    async (retryAfter) => {
      installFetchStub({ headers: { 'Retry-After': retryAfter }, status: 429 });

      await expect(
        authenticatedRequestJson('/api/v1/auth/me', {
          accessToken: SYNTHETIC_TOKEN,
        }),
      ).rejects.toMatchObject({ retryAfterSeconds: null, status: 429 });
    },
  );

  it('does not expose an HTTP response body in the safe error', async () => {
    installFetchStub({ json: { detail: 'private backend detail' }, status: 401 });

    const request = authenticatedRequestJson('/api/v1/auth/me', {
      accessToken: SYNTHETIC_TOKEN,
    });

    await expect(request).rejects.toMatchObject({ kind: 'http', status: 401 });
    await expect(request).rejects.not.toThrow('private backend detail');
  });

  it('maps a rejected fetch to a network error', async () => {
    installFetchStub({ error: new TypeError('offline detail') });

    await expect(
      authenticatedRequestJson('/api/v1/auth/me', {
        accessToken: SYNTHETIC_TOKEN,
      }),
    ).rejects.toMatchObject({ kind: 'network', status: null });
  });

  it('maps invalid success JSON to an invalid-response error', async () => {
    installFetchStub({ body: '{broken' });

    await expect(
      authenticatedRequestJson('/api/v1/auth/me', {
        accessToken: SYNTHETIC_TOKEN,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-response', status: null });
  });

  it('forwards an external abort without reporting a timeout', async () => {
    installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = authenticatedRequestJson('/api/v1/auth/me', {
      accessToken: SYNTHETIC_TOKEN,
      signal: controller.signal,
    });

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted', status: null });
  });

  it('aborts once at the configured timeout', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ waitForAbort: true });
    const request = authenticatedRequestJson('/api/v1/auth/me', {
      accessToken: SYNTHETIC_TOKEN,
      timeoutMs: 25,
    });
    const rejection = expect(request).rejects.toMatchObject({
      kind: 'timeout',
      status: null,
    });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(stub.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps an invalid configured API base URL without issuing fetch', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'not-a-url');
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      authenticatedRequestJson('/api/v1/auth/me', {
        accessToken: SYNTHETIC_TOKEN,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-response', status: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
