import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider } from './AuthContext';
import LoginPage from './LoginPage';
import {
  AUTH_STORAGE_KEY,
  LEGACY_AUTH_STORAGE_KEY,
  resetAuthMemoryForTests,
} from './authStorage';

const TOKEN = 'synthetic.canonical.token';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN_RESPONSE = {
  access_token: TOKEN,
  expires_in: 900,
  token_type: 'bearer',
};

function currentUser(role: 'admin' | 'customer' | 'super_admin' = 'customer') {
  return {
    email: `${role}@example.invalid`,
    id: USER_ID,
    is_active: true,
    role,
  };
}

function renderLogin(initialEntry = '/login') {
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [
          { path: '/login', element: <LoginPage /> },
          { path: '/register', element: <h1>Registration destination</h1> },
          { path: '/', element: <h1>Customer home</h1> },
          { path: '/account', element: <h1>Account destination</h1> },
          {
            path: '/account/orders/:publicOrderNumber',
            element: <h1>Account order destination</h1>,
          },
          { path: '/menu', element: <h1>Menu destination</h1> },
          { path: '/cart', element: <h1>Cart destination</h1> },
          { path: '/admin', element: <h1>Administrator destination</h1> },
          {
            path: '/admin/orders',
            element: <h1>Administrator orders destination</h1>,
          },
          {
            path: '/admin/users',
            element: <h1>User management destination</h1>,
          },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function submitCredentials(
  email = ' Customer@Example.Invalid ',
  password = ' exact password ',
) {
  const user = userEvent.setup();
  const emailInput = await screen.findByLabelText('Email');
  const passwordInput = screen.getByLabelText('Password');
  await user.type(emailInput, email);
  await user.type(passwordInput, password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return { emailInput, passwordInput };
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('shared login page', () => {
  it('renders one branded role-neutral form with a decorative mark', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderLogin();

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Nordic Hearth', { exact: true })).toBeVisible();
    expect(
      screen.queryByRole('img', { name: 'Nordic Hearth' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    expect(screen.queryByRole('combobox', { name: /role/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/register',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('carries a safe encoded continuation to registration without submitting', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const { router } = renderLogin('/login?next=%2Fcart');

    const registerLink = await screen.findByRole('link', {
      name: 'Create an account',
    });
    expect(registerLink).toHaveAttribute('href', '/register?next=%2Fcart');

    await user.click(registerLink);

    expect(
      await screen.findByRole('heading', { name: 'Registration destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/register');
    expect(router.state.location.search).toBe('?next=%2Fcart');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('toggles password visibility without changing its value or revealing after validation', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderLogin();
    const passwordInput = await screen.findByLabelText('Password');
    await user.type(passwordInput, ' exact password ');

    const showPassword = screen.getByRole('button', { name: 'Show password' });
    expect(showPassword).toHaveAttribute('aria-pressed', 'false');
    expect(passwordInput).toHaveAttribute('type', 'password');
    await user.click(showPassword);
    expect(passwordInput).toHaveAttribute('type', 'text');
    expect(passwordInput).toHaveValue(' exact password ');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Email is required.')).toBeVisible();
    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(passwordInput).toHaveValue(' exact password ');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('links back home without submitting the unauthenticated form', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const { router } = renderLogin();

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    const backLink = screen.getByRole('link', { name: '← Back to home' });
    expect(backLink).toHaveAttribute('href', '/');

    await user.click(backLink);

    expect(await screen.findByRole('heading', { name: 'Customer home' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validates required fields and focuses the first invalid control', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderLogin();

    await user.click(await screen.findByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Email is required.')).toBeVisible();
    expect(screen.getByLabelText('Email')).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires a password and focuses it after a valid email', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderLogin();
    await user.type(await screen.findByLabelText('Email'), 'customer@example.invalid');

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Password is required.')).toBeVisible();
    expect(screen.getByLabelText('Password')).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid email and a password over 128 Unicode code points', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderLogin();
    const emailInput = await screen.findByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    await user.type(emailInput, 'not-an-email');
    fireEvent.change(passwordInput, { target: { value: 'ą'.repeat(129) } });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Enter a valid email address.')).toBeVisible();
    expect(
      screen.getByText('Password must contain at most 128 characters.'),
    ).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('normalizes email, preserves password bytes, then validates canonical me', async () => {
    const stub = installFetchStub(
      { json: TOKEN_RESPONSE },
      { json: currentUser('customer') },
    );
    const { router } = renderLogin('/login?next=%2Fcart');

    await submitCredentials();

    expect(
      await screen.findByRole('heading', { name: 'Cart destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/cart');
    expect(stub.calls.map((call) => call.url)).toEqual([
      '/api/v1/auth/login',
      '/api/v1/auth/me',
    ]);
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({
      email: 'customer@example.invalid',
      password: ' exact password ',
    });
    expect(stub.calls[1]?.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(sessionStorage.getItem(AUTH_STORAGE_KEY) ?? '{}')).toEqual({
      accessToken: TOKEN,
      version: 1,
    });
    expect(localStorage).toHaveLength(0);
    expect(document.body).not.toHaveTextContent(TOKEN);
  });

  it.each([
    ['admin', '/admin/orders', 'Administrator orders destination', '/admin/orders'],
    ['super_admin', '/admin', 'Administrator destination', '/admin'],
    ['customer', '/admin', 'Account destination', '/account'],
    ['super_admin', '/admin/users', 'User management destination', '/admin/users'],
    ['admin', '/admin/users', 'Administrator destination', '/admin'],
    ['customer', '/admin/users', 'Account destination', '/account'],
  ] as const)(
    'routes a %s through the role-authoritative safe continuation policy',
    async (role, next, heading, destination) => {
      installFetchStub({ json: TOKEN_RESPONSE }, { json: currentUser(role) });
      const { router } = renderLogin(`/login?next=${encodeURIComponent(next)}`);

      await submitCredentials(`${role}@example.invalid`, 'password');

      expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
      expect(router.state.location.pathname).toBe(destination);
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    },
  );

  it.each([
    'https://example.invalid/admin',
    '//example.invalid/admin',
    '/admin?unexpected=true',
    '/login',
    '/register',
    '/account/orders/not-an-order',
  ])(
    'falls back to account for an unsafe or unsupported next value %s',
    async (next) => {
      installFetchStub({ json: TOKEN_RESPONSE }, { json: currentUser('admin') });
      const { router } = renderLogin(`/login?next=${encodeURIComponent(next)}`);

      await submitCredentials('admin@example.invalid', 'password');

      expect(
        await screen.findByRole('heading', { name: 'Account destination' }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe('/account');
    },
  );

  it.each(['customer', 'admin', 'super_admin'] as const)(
    'routes %s to the account after login without a continuation',
    async (role) => {
      installFetchStub({ json: TOKEN_RESPONSE }, { json: currentUser(role) });
      const { router } = renderLogin();

      await submitCredentials(`${role}@example.invalid`, 'password');

      expect(
        await screen.findByRole('heading', { name: 'Account destination' }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe('/account');
    },
  );

  it('accepts the new menu continuation explicitly', async () => {
    installFetchStub({ json: TOKEN_RESPONSE }, { json: currentUser('customer') });
    const { router } = renderLogin('/login?next=%2Fmenu');

    await submitCredentials();

    expect(
      await screen.findByRole('heading', { name: 'Menu destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/menu');
  });

  it.each(['customer', 'admin', 'super_admin'] as const)(
    'accepts a safe account-detail continuation for %s',
    async (role) => {
      installFetchStub({ json: TOKEN_RESPONSE }, { json: currentUser(role) });
      const destination = '/account/orders/ROA-23456789ABCD';
      const { router } = renderLogin(`/login?next=${encodeURIComponent(destination)}`);

      await submitCredentials(`${role}@example.invalid`, 'password');

      expect(
        await screen.findByRole('heading', { name: 'Account order destination' }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe(destination);
    },
  );

  it('redirects an already-authenticated user to the account default', async () => {
    sessionStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: TOKEN, version: 1 }),
    );
    installFetchStub({ json: currentUser('customer') });
    const { router } = renderLogin();

    expect(
      await screen.findByRole('heading', { name: 'Account destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/account');
  });

  it('shows a generic 401 without persisting submitted credentials', async () => {
    installFetchStub({ status: 401 });
    renderLogin();

    await submitCredentials();

    expect(
      await screen.findByText('The email or password is incorrect.'),
    ).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(JSON.stringify(sessionStorage)).not.toMatch(/password/i);
  });

  it('recovers from a request error without rendering the issued token', async () => {
    const user = userEvent.setup();
    const stub = installFetchStub(
      { json: { detail: 'private authentication context' }, status: 401 },
      { json: TOKEN_RESPONSE },
      { json: currentUser('customer') },
    );
    const { router } = renderLogin('/login?next=%2Fcart');

    const fields = await submitCredentials();
    expect(
      await screen.findByText('The email or password is incorrect.'),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent('private authentication context');
    expect(fields.passwordInput).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', { name: 'Cart destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/cart');
    expect(stub.calls.map((call) => call.url)).toEqual([
      '/api/v1/auth/login',
      '/api/v1/auth/login',
      '/api/v1/auth/me',
    ]);
    expect(document.body).not.toHaveTextContent(TOKEN);
  });

  it('prevents a second submission while login is in flight', async () => {
    const pending = deferredResponse();
    const stub = installFetchStub({ responsePromise: pending.promise });
    renderLogin();

    const fields = await submitCredentials();

    const loadingButton = screen.getByRole('button', { name: 'Signing in' });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveAttribute('aria-busy', 'true');
    const form = loadingButton.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    expect(stub.calls).toHaveLength(1);
    await act(async () => {
      pending.resolve(new Response(null, { status: 401 }));
      await pending.promise;
    });
    expect(
      await screen.findByText('The email or password is incorrect.'),
    ).toBeVisible();
    expect(fields.passwordInput).toHaveValue(' exact password ');
  });

  it('honors Retry-After with a visible disabled cooldown', async () => {
    installFetchStub({ status: 429, headers: { 'Retry-After': '2' } });
    renderLogin();
    const emailInput = await screen.findByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    fireEvent.change(emailInput, { target: { value: 'customer@example.invalid' } });
    fireEvent.change(passwordInput, { target: { value: 'password' } });
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByRole('button', { name: 'Try again in 2 seconds' }),
    ).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows generic rate-limit guidance without inventing a cooldown', async () => {
    installFetchStub({ status: 429 });
    renderLogin();

    await submitCredentials();

    expect(
      await screen.findByText('Too many sign-in attempts. Try again later.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it.each([
    [503, 'Sign-in is temporarily unavailable. Try again.'],
    [500, 'We could not sign you in. Check your connection and try again.'],
  ])('maps HTTP %i to a safe page error', async (status, message) => {
    installFetchStub({
      json: { detail: 'private backend context' },
      status,
    });
    renderLogin();

    await submitCredentials();

    expect(await screen.findByText(message)).toBeVisible();
    expect(document.body).not.toHaveTextContent('private backend context');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('shows a safe network error without persisting credentials', async () => {
    installFetchStub({ error: new TypeError('private offline detail') });
    renderLogin();

    await submitCredentials();

    expect(
      await screen.findByText(
        'We could not sign you in. Check your connection and try again.',
      ),
    ).toBeVisible();
    expect(sessionStorage).toHaveLength(0);
  });

  it('shows a safe timeout error without persisting credentials', async () => {
    installFetchStub({ waitForAbort: true });
    renderLogin();
    const emailInput = await screen.findByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    fireEvent.change(emailInput, { target: { value: 'customer@example.invalid' } });
    fireEvent.change(passwordInput, { target: { value: 'password' } });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(
      screen.getByText(
        'The sign-in request timed out. Check your connection and try again.',
      ),
    ).toBeVisible();
    expect(sessionStorage).toHaveLength(0);
  });

  it('shows a safe error for a malformed successful login response', async () => {
    installFetchStub({
      json: { ...TOKEN_RESPONSE, token_type: 'Basic' },
    });
    renderLogin();

    await submitCredentials();

    expect(
      await screen.findByText('We could not complete sign-in. Try again later.'),
    ).toBeVisible();
    expect(sessionStorage).toHaveLength(0);
  });

  it('retains the token but blocks navigation for a malformed me response', async () => {
    installFetchStub(
      { json: TOKEN_RESPONSE },
      { json: { ...currentUser('admin'), is_active: false } },
    );
    renderLogin('/login?next=%2Fadmin');

    await submitCredentials('admin@example.invalid', 'password');

    expect(
      await screen.findByRole('heading', {
        name: 'Session validation is unavailable',
      }),
    ).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    expect(screen.queryByText('Administrator destination')).not.toBeInTheDocument();
  });

  it('retains an issued token and blocks navigation when me is unavailable', async () => {
    installFetchStub({ json: TOKEN_RESPONSE }, { status: 503 });
    renderLogin('/login?next=%2Fadmin');

    await submitCredentials('admin@example.invalid', 'password');

    expect(
      await screen.findByRole('heading', {
        name: 'Session validation is unavailable',
      }),
    ).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    expect(screen.queryByText('Administrator destination')).not.toBeInTheDocument();
  });

  it('blocks the form while checking a stored session', async () => {
    sessionStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: TOKEN, version: 1 }),
    );
    installFetchStub({ responsePromise: new Promise<Response>(() => undefined) });
    renderLogin();

    expect(
      await screen.findByRole('heading', { name: 'Checking your session' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('clears both auth keys from a temporary state without touching cart data', async () => {
    sessionStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: TOKEN, version: 1 }),
    );
    sessionStorage.setItem(
      LEGACY_AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'legacy.synthetic.token', version: 1 }),
    );
    sessionStorage.setItem('restaurant-ordering:cart:v1', 'preserved-cart');
    installFetchStub({ status: 503 });
    const user = userEvent.setup();
    renderLogin();
    await screen.findByRole('heading', {
      name: 'Session validation is unavailable',
    });

    await user.click(screen.getByRole('button', { name: 'Clear session' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('restaurant-ordering:cart:v1')).toBe(
      'preserved-cart',
    );
  });
});
