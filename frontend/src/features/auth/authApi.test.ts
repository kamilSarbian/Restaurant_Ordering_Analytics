import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import {
  AuthApiRequestError,
  fetchCurrentUser,
  loginUser,
  parseAuthTokenResponse,
  parseAuthUser,
  registerUser,
  startCustomerDemoSession,
  startDemoSession,
} from './authApi';

const SYNTHETIC_TOKEN = 'synthetic-canonical-token';
const VALID_TOKEN_RESPONSE = {
  access_token: SYNTHETIC_TOKEN,
  expires_in: 3_600,
  token_type: 'bearer',
};
const VALID_USER_RESPONSE = {
  email: 'user@example.test',
  id: '123e4567-e89b-12d3-a456-426614174000',
  is_active: true,
  role: 'customer',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('canonical authentication API', () => {
  it('sends normalized email and an unmodified password to canonical login', async () => {
    const stub = installFetchStub({ json: VALID_TOKEN_RESPONSE });

    const result = await loginUser('  USER@Example.Test  ', '  synthetic password  ');

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/auth/login',
    });
    expect(stub.calls[0]?.headers.get('Authorization')).toBeNull();
    expect(stub.calls[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(stub.calls[0]?.body ?? '')).toEqual({
      email: 'user@example.test',
      password: '  synthetic password  ',
    });
    expect(result).toEqual({
      accessToken: SYNTHETIC_TOKEN,
      expiresIn: 3_600,
      tokenType: 'bearer',
    });
  });

  it('sends only email and password to canonical registration', async () => {
    const stub = installFetchStub({ json: VALID_TOKEN_RESPONSE, status: 201 });

    await registerUser('new@example.test', 'synthetic password');

    expect(stub.calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/auth/register',
    });
    expect(JSON.parse(stub.calls[0]?.body ?? '')).toEqual({
      email: 'new@example.test',
      password: 'synthetic password',
    });
    expect(stub.calls[0]?.body).not.toMatch(/role|is_active|confirmPassword/);
  });

  it('sends one bodyless credential-free demo-session request', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(VALID_TOKEN_RESPONSE), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(startDemoSession()).resolves.toEqual({
      accessToken: SYNTHETIC_TOKEN,
      expiresIn: 3_600,
      tokenType: 'bearer',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(input).toBe('/api/v1/auth/demo-session');
    expect(init).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      method: 'POST',
    });
    expect(init?.body).toBeUndefined();
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Content-Type')).toBeNull();
    expect(headers.get('Cookie')).toBeNull();
  });

  it('sends one bodyless credential-free customer demo request', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(VALID_TOKEN_RESPONSE), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(startCustomerDemoSession()).resolves.toMatchObject({
      accessToken: SYNTHETIC_TOKEN,
      tokenType: 'bearer',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(input).toBe('/api/v1/auth/customer-demo-session');
    expect(init).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      method: 'POST',
    });
    expect(init?.body).toBeUndefined();
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Content-Type')).toBeNull();
    expect(headers.get('Cookie')).toBeNull();
  });

  it.each([404, 503])(
    'preserves safe demo-session HTTP %i without retry',
    async (status) => {
      const stub = installFetchStub({
        json: { detail: 'private backend context' },
        status,
      });

      const request = startDemoSession();
      await expect(request).rejects.toMatchObject({
        kind: 'http',
        retryAfterSeconds: null,
        status,
      });
      await expect(request).rejects.not.toThrow('private backend context');
      expect(stub.calls).toHaveLength(1);
    },
  );

  it('preserves a valid demo-session Retry-After without retrying', async () => {
    const stub = installFetchStub({
      headers: { 'Retry-After': '23' },
      status: 429,
    });

    await expect(startDemoSession()).rejects.toMatchObject({
      kind: 'http',
      retryAfterSeconds: 23,
      status: 429,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('classifies a rejected demo-session fetch as a one-shot network failure', async () => {
    const stub = installFetchStub({ error: new TypeError('offline detail') });

    await expect(startDemoSession()).rejects.toMatchObject({
      kind: 'network',
      status: null,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('rejects an invalid demo-session token response', async () => {
    const stub = installFetchStub({
      json: { ...VALID_TOKEN_RESPONSE, access_token: 'invalid token' },
    });

    await expect(startDemoSession()).rejects.toMatchObject({
      kind: 'invalid-response',
      status: null,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('forwards an external demo-session abort', async () => {
    const stub = installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = startDemoSession(controller.signal);

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted', status: null });
    expect(stub.calls).toHaveLength(1);
  });

  it('applies the configured timeout to one demo-session request', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ waitForAbort: true });
    const request = startDemoSession();
    const rejection = expect(request).rejects.toMatchObject({
      kind: 'timeout',
      status: null,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(stub.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fetches current User only from canonical /auth/me with explicit Bearer', async () => {
    const stub = installFetchStub({ json: VALID_USER_RESPONSE });

    const user = await fetchCurrentUser(SYNTHETIC_TOKEN);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe('/api/v1/auth/me');
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
    expect(user).toEqual({
      email: 'user@example.test',
      id: VALID_USER_RESPONSE.id,
      isActive: true,
      role: 'customer',
    });
  });

  it.each(['customer', 'admin', 'super_admin'])(
    'accepts canonical role %s from /me',
    async (role) => {
      installFetchStub({ json: { ...VALID_USER_RESPONSE, role } });

      await expect(fetchCurrentUser(SYNTHETIC_TOKEN)).resolves.toMatchObject({ role });
    },
  );

  it.each([
    ['extra token field', { ...VALID_TOKEN_RESPONSE, role: 'admin' }],
    ['missing token', { expires_in: 3_600, token_type: 'bearer' }],
    ['blank token', { ...VALID_TOKEN_RESPONSE, access_token: '   ' }],
    ['padded token', { ...VALID_TOKEN_RESPONSE, access_token: ' token ' }],
    ['wrong token type', { ...VALID_TOKEN_RESPONSE, token_type: 'Bearer' }],
    ['floating expiry', { ...VALID_TOKEN_RESPONSE, expires_in: 3_600.5 }],
    ['zero expiry', { ...VALID_TOKEN_RESPONSE, expires_in: 0 }],
  ])('rejects malformed token contract: %s', (_label, response) => {
    expect(() => parseAuthTokenResponse(response)).toThrow(AuthApiRequestError);
  });

  it.each([
    ['extra user field', { ...VALID_USER_RESPONSE, internal: true }],
    ['invalid id', { ...VALID_USER_RESPONSE, id: 'not-a-uuid' }],
    ['padded email', { ...VALID_USER_RESPONSE, email: ' user@example.test ' }],
    ['invalid role', { ...VALID_USER_RESPONSE, role: 'owner' }],
    ['invalid active flag', { ...VALID_USER_RESPONSE, is_active: 1 }],
    ['inactive user', { ...VALID_USER_RESPONSE, is_active: false }],
    ['missing active flag', { ...VALID_USER_RESPONSE, is_active: undefined }],
  ])('rejects malformed current-user contract: %s', (_label, response) => {
    expect(() => parseAuthUser(response)).toThrow(AuthApiRequestError);
  });

  it.each([
    ['login', () => loginUser('user@example.test', 'synthetic password'), 401],
    ['login', () => loginUser('user@example.test', 'synthetic password'), 429],
    ['login', () => loginUser('user@example.test', 'synthetic password'), 503],
    ['register', () => registerUser('user@example.test', 'synthetic password'), 409],
    ['register', () => registerUser('user@example.test', 'synthetic password'), 422],
    ['register', () => registerUser('user@example.test', 'synthetic password'), 429],
    ['register', () => registerUser('user@example.test', 'synthetic password'), 503],
    ['me', () => fetchCurrentUser(SYNTHETIC_TOKEN), 401],
    ['me', () => fetchCurrentUser(SYNTHETIC_TOKEN), 503],
  ])('preserves safe HTTP metadata for %s', async (_label, request, status) => {
    installFetchStub({
      headers: { 'Retry-After': '19' },
      json: { detail: 'private backend context' },
      status,
    });

    const promise = request();
    await expect(promise).rejects.toMatchObject({
      kind: 'http',
      retryAfterSeconds: 19,
      status,
    });
    await expect(promise).rejects.not.toThrow('private backend context');
  });

  it.each([
    ['login', () => loginUser('user@example.test', 'synthetic password')],
    ['register', () => registerUser('user@example.test', 'synthetic password')],
  ])('classifies malformed %s success JSON safely', async (_label, request) => {
    installFetchStub({ body: '{broken' });

    await expect(request()).rejects.toMatchObject({
      kind: 'invalid-response',
      status: null,
    });
  });

  it('classifies a rejected login fetch as network failure', async () => {
    installFetchStub({ error: new TypeError('offline detail') });

    await expect(
      loginUser('user@example.test', 'synthetic password'),
    ).rejects.toMatchObject({ kind: 'network', status: null });
  });

  it.each([
    [
      'login',
      (signal: AbortSignal) =>
        loginUser('user@example.test', 'synthetic password', signal),
    ],
    [
      'registration',
      (signal: AbortSignal) =>
        registerUser('user@example.test', 'synthetic password', signal),
    ],
  ])('forwards an external %s abort', async (_label, requestWithSignal) => {
    installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = requestWithSignal(controller.signal);

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted', status: null });
  });

  it('forwards an external current-user abort', async () => {
    installFetchStub({ waitForAbort: true });
    const controller = new AbortController();
    const request = fetchCurrentUser(SYNTHETIC_TOKEN, controller.signal);

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: 'aborted', status: null });
  });

  it('classifies a rejected current-user fetch as network failure', async () => {
    installFetchStub({ error: new TypeError('offline detail') });

    await expect(fetchCurrentUser(SYNTHETIC_TOKEN)).rejects.toMatchObject({
      kind: 'network',
      status: null,
    });
  });

  it('applies the ten-second current-user timeout', async () => {
    vi.useFakeTimers();
    installFetchStub({ waitForAbort: true });
    const request = fetchCurrentUser(SYNTHETIC_TOKEN);
    const rejection = expect(request).rejects.toMatchObject({
      kind: 'timeout',
      status: null,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies the ten-second login timeout', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ waitForAbort: true });
    const request = loginUser('user@example.test', 'synthetic password');
    const rejection = expect(request).rejects.toMatchObject({
      kind: 'timeout',
      status: null,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(stub.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
