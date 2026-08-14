import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';

import { installFetchStub } from '../../test/fetchStub';
import type { AuthUser } from './authApi';
import { AuthProvider, type AuthActionOutcome, useAuth } from './AuthContext';
import {
  AUTH_STORAGE_KEY,
  LEGACY_AUTH_STORAGE_KEY,
  resetAuthMemoryForTests,
  saveAuthToken,
} from './authStorage';

const TOKEN = 'synthetic.canonical.token';
const SECOND_TOKEN = 'synthetic.second.token';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const USER = {
  email: 'admin@example.invalid',
  id: USER_ID,
  is_active: true,
  role: 'admin',
};

type AuthValue = ReturnType<typeof useAuth>;
let currentAuth: AuthValue | null = null;

function Probe() {
  const value = useAuth();
  useEffect(() => {
    currentAuth = value;
  }, [value]);
  return <div data-testid="phase">{value.phase}</div>;
}

function renderAuth() {
  currentAuth = null;
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

function auth(): AuthValue {
  if (currentAuth === null) {
    throw new Error('Auth probe has not rendered');
  }
  return currentAuth;
}

function store(key: string, accessToken: string): void {
  sessionStorage.setItem(key, JSON.stringify({ accessToken, version: 1 }));
}

function tokenResponse(accessToken = TOKEN) {
  return { access_token: accessToken, expires_in: 900, token_type: 'bearer' };
}

afterEach(() => {
  sessionStorage.clear();
  resetAuthMemoryForTests();
  currentAuth = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AuthProvider bootstrap', () => {
  it('becomes unauthenticated without a stored token and sends no request', () => {
    const stub = installFetchStub();
    renderAuth();
    expect(auth().phase).toBe('unauthenticated');
    expect(stub.calls).toHaveLength(0);
  });

  it('validates one canonical token exactly once', async () => {
    store(AUTH_STORAGE_KEY, TOKEN);
    const stub = installFetchStub({ json: USER });
    renderAuth();
    await waitFor(() => expect(auth().phase).toBe('authenticated'));
    expect(auth().user).toEqual({
      email: USER.email,
      id: USER.id,
      isActive: true,
      role: 'admin',
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe('/api/v1/auth/me');
  });

  it('authenticates from module memory when sessionStorage reads are unavailable', async () => {
    saveAuthToken(TOKEN);
    const storageRead = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new DOMException('Blocked', 'SecurityError');
      });
    installFetchStub({ json: USER });

    renderAuth();

    await waitFor(() => expect(auth().phase).toBe('authenticated'));
    expect(auth().getAuthenticatedSession()?.accessToken).toBe(TOKEN);
    storageRead.mockRestore();
  });

  it('clears canonical and legacy records after canonical 401 without resurrection', async () => {
    store(AUTH_STORAGE_KEY, TOKEN);
    store(LEGACY_AUTH_STORAGE_KEY, SECOND_TOKEN);
    const stub = installFetchStub({ status: 401 });
    const view = renderAuth();
    await waitFor(() => expect(auth().phase).toBe('unauthenticated'));
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
    view.unmount();
    renderAuth();
    expect(auth().phase).toBe('unauthenticated');
    expect(stub.calls).toHaveLength(1);
  });

  it.each([{ status: 503 }, { error: new TypeError('synthetic network') }])(
    'retains a canonical token when validation is temporarily unavailable',
    async (step) => {
      store(AUTH_STORAGE_KEY, TOKEN);
      installFetchStub(step);
      renderAuth();
      await waitFor(() => expect(auth().phase).toBe('temporarily-unavailable'));
      expect(auth().accessToken).toBe(TOKEN);
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    },
  );

  it('migrates a canonical legacy candidate after strict me succeeds', async () => {
    store(LEGACY_AUTH_STORAGE_KEY, TOKEN);
    installFetchStub({ json: USER });
    renderAuth();
    await waitFor(() => expect(auth().phase).toBe('authenticated'));
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('removes only a rejected legacy candidate after canonical me returns 401', async () => {
    store(LEGACY_AUTH_STORAGE_KEY, TOKEN);
    installFetchStub({ status: 401 });
    renderAuth();
    await waitFor(() => expect(auth().phase).toBe('unauthenticated'));
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
  });

  it.each([{ status: 503 }, { error: new TypeError('synthetic network') }])(
    'preserves a legacy candidate for retry after a temporary failure',
    async (step) => {
      store(LEGACY_AUTH_STORAGE_KEY, TOKEN);
      installFetchStub(step);
      renderAuth();
      await waitFor(() => expect(auth().phase).toBe('temporarily-unavailable'));
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toContain(TOKEN);
    },
  );

  it('gives a canonical record priority over a different legacy identity', async () => {
    store(AUTH_STORAGE_KEY, TOKEN);
    store(LEGACY_AUTH_STORAGE_KEY, SECOND_TOKEN);
    const stub = installFetchStub({ json: USER });
    renderAuth();
    await waitFor(() => expect(auth().phase).toBe('authenticated'));
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('clears corrupt records without issuing a request', () => {
    sessionStorage.setItem(AUTH_STORAGE_KEY, '{not-json');
    sessionStorage.setItem(LEGACY_AUTH_STORAGE_KEY, JSON.stringify({ version: 2 }));
    const stub = installFetchStub();
    renderAuth();
    expect(auth().phase).toBe('unauthenticated');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });
});

describe('AuthProvider credential flows', () => {
  it('logs in through canonical token issuance followed by me', async () => {
    const stub = installFetchStub({ json: tokenResponse() }, { json: USER });
    renderAuth();
    let outcome: AuthActionOutcome | undefined;
    await act(async () => {
      outcome = await auth().login(' Admin@Example.Invalid ', '  exact password  ');
    });
    expect(outcome).toEqual({ kind: 'authenticated' });
    expect(auth().phase).toBe('authenticated');
    expect(stub.calls.map((call) => call.url)).toEqual([
      '/api/v1/auth/login',
      '/api/v1/auth/me',
    ]);
    expect(stub.calls[0]?.body).toBe(
      JSON.stringify({
        email: 'admin@example.invalid',
        password: '  exact password  ',
      }),
    );
  });

  it('clears a login token rejected by me', async () => {
    installFetchStub({ json: tokenResponse() }, { status: 401 });
    renderAuth();
    await act(async () => {
      expect(await auth().login('a@example.invalid', 'password')).toEqual({
        kind: 'invalid-credentials',
      });
    });
    expect(auth().phase).toBe('unauthenticated');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('retains a newly issued token when me is unavailable', async () => {
    installFetchStub({ json: tokenResponse() }, { status: 503 });
    renderAuth();
    await act(async () => {
      expect(await auth().login('a@example.invalid', 'password')).toEqual({
        kind: 'session-unavailable',
      });
    });
    expect(auth().phase).toBe('temporarily-unavailable');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
  });

  it('clears legacy storage after a canonical login succeeds', async () => {
    store(LEGACY_AUTH_STORAGE_KEY, SECOND_TOKEN);
    installFetchStub({ json: tokenResponse() }, { json: USER });
    renderAuth();
    await act(async () => {
      await auth().login('a@example.invalid', 'password');
    });
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('registers without role and validates the resulting session', async () => {
    const stub = installFetchStub({ json: tokenResponse() }, { json: USER });
    renderAuth();
    await act(async () => {
      expect(
        await auth().register('New@Example.Invalid', 'registration password'),
      ).toEqual({ kind: 'authenticated' });
    });
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({
      email: 'new@example.invalid',
      password: 'registration password',
    });
    expect(stub.calls[0]?.body).not.toMatch(/role|is_active/i);
  });

  it('keeps registration token retryable after me network failure', async () => {
    installFetchStub(
      { json: tokenResponse() },
      { error: new TypeError('synthetic network') },
    );
    renderAuth();
    await act(async () => {
      expect(await auth().register('new@example.invalid', 'password')).toEqual({
        kind: 'session-unavailable',
      });
    });
    expect(auth().phase).toBe('temporarily-unavailable');
    expect(auth().accessToken).toBe(TOKEN);
  });

  it.each([
    [401, 'unauthenticated', false],
    [503, 'temporarily-unavailable', true],
  ] as const)(
    'applies register me HTTP %i session semantics',
    async (status, expectedPhase, tokenRetained) => {
      installFetchStub({ json: tokenResponse() }, { status });
      renderAuth();

      await act(async () => {
        await auth().register('new@example.invalid', 'password');
      });

      expect(auth().phase).toBe(expectedPhase);
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)?.includes(TOKEN) ?? false).toBe(
        tokenRetained,
      );
    },
  );
});

describe('AuthProvider session safety', () => {
  it('logout clears both auth stores but preserves unrelated browser state', async () => {
    saveAuthToken(TOKEN);
    store(LEGACY_AUTH_STORAGE_KEY, SECOND_TOKEN);
    sessionStorage.setItem('restaurant-ordering:cart:v1', 'synthetic-cart');
    installFetchStub({ json: USER });
    renderAuth();
    await waitFor(() => expect(auth().phase).toBe('authenticated'));
    act(() => auth().logout());
    expect(auth().phase).toBe('unauthenticated');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('restaurant-ordering:cart:v1')).toBe(
      'synthetic-cart',
    );
  });

  it('ignores a stale bootstrap result after logout', async () => {
    store(AUTH_STORAGE_KEY, TOKEN);
    let resolveResponse!: (response: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    installFetchStub({ responsePromise });
    renderAuth();
    await waitFor(() => expect(auth().phase).toBe('checking-session'));
    act(() => auth().logout());
    await act(async () => {
      resolveResponse(new Response(JSON.stringify(USER), { status: 200 }));
      await responsePromise;
    });
    expect(auth().phase).toBe('unauthenticated');
  });

  it('prevents an older login result from overwriting a newer login', async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondUser = {
      ...USER,
      email: 'second@example.invalid',
      role: 'super_admin',
    };
    installFetchStub(
      { responsePromise: first },
      { json: tokenResponse(SECOND_TOKEN) },
      { json: secondUser },
    );
    renderAuth();
    let firstOutcome!: Promise<AuthActionOutcome>;
    await act(async () => {
      firstOutcome = auth().login('first@example.invalid', 'first-password');
      await Promise.resolve();
      expect(await auth().login('second@example.invalid', 'second-password')).toEqual({
        kind: 'authenticated',
      });
    });
    await act(async () => {
      resolveFirst(new Response(JSON.stringify(tokenResponse()), { status: 200 }));
      expect(await firstOutcome).toEqual({ kind: 'aborted' });
    });
    expect(auth().user?.email).toBe('second@example.invalid');
    expect(auth().accessToken).toBe(SECOND_TOKEN);
  });

  it('invalidates only the captured current session', async () => {
    installFetchStub({ json: tokenResponse() }, { json: USER });
    renderAuth();
    await act(async () => {
      await auth().login('a@example.invalid', 'password');
    });
    const current = auth().getAuthenticatedSession();
    expect(current).not.toBeNull();
    act(() =>
      auth().invalidateSessionIfCurrent({
        accessToken: SECOND_TOKEN,
        generation: current!.generation,
      }),
    );
    expect(auth().phase).toBe('authenticated');
    act(() => auth().invalidateSessionIfCurrent(current!));
    expect(auth().phase).toBe('unauthenticated');
  });

  it('ignores an old-generation 401 when a newer login returns the same token', async () => {
    installFetchStub(
      { json: tokenResponse() },
      { json: USER },
      { json: tokenResponse() },
      { json: USER },
    );
    renderAuth();
    await act(async () => {
      await auth().login('a@example.invalid', 'password');
    });
    const oldSession = auth().getAuthenticatedSession();
    expect(oldSession).not.toBeNull();
    await act(async () => {
      await auth().login('a@example.invalid', 'password');
    });
    const newSession = auth().getAuthenticatedSession();
    expect(newSession?.accessToken).toBe(oldSession?.accessToken);
    expect(newSession?.generation).not.toBe(oldSession?.generation);

    act(() => auth().invalidateSessionIfCurrent(oldSession!));

    expect(auth().phase).toBe('authenticated');
    expect(auth().getAuthenticatedSession()).toEqual(newSession);
  });

  it('refreshes the database-authoritative role without logging out on 403', async () => {
    const refreshed = { ...USER, role: 'customer' };
    store(AUTH_STORAGE_KEY, TOKEN);
    installFetchStub({ json: USER }, { json: refreshed });
    renderAuth();
    await waitFor(() => expect(auth().phase).toBe('authenticated'));
    await act(async () => {
      expect(await auth().refreshCurrentUser()).toMatchObject({ role: 'customer' });
    });
    expect(auth().phase).toBe('authenticated');
    expect(auth().user?.role).toBe('customer');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
  });

  it('keeps authenticated content mounted while an explicit role refresh is pending', async () => {
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    store(AUTH_STORAGE_KEY, TOKEN);
    installFetchStub({ json: USER }, { responsePromise: refreshResponse });
    renderAuth();
    await waitFor(() => expect(auth().phase).toBe('authenticated'));

    let refresh!: Promise<AuthUser | null>;
    act(() => {
      refresh = auth().refreshCurrentUser();
    });
    expect(auth().phase).toBe('authenticated');
    expect(auth().user?.role).toBe('admin');

    await act(async () => {
      resolveRefresh(
        new Response(JSON.stringify(USER), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await refresh;
    });
    expect(auth().phase).toBe('authenticated');
  });

  it('retries the same retained legacy candidate', async () => {
    store(LEGACY_AUTH_STORAGE_KEY, TOKEN);
    const stub = installFetchStub({ status: 503 }, { json: USER });
    renderAuth();
    await waitFor(() => expect(auth().phase).toBe('temporarily-unavailable'));
    await act(async () => {
      await auth().retrySession();
    });
    expect(auth().phase).toBe('authenticated');
    expect(stub.calls.map((call) => call.headers.get('Authorization'))).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ]);
  });
});
