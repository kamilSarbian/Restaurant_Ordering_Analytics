import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider } from './AuthContext';
import RegisterPage from './RegisterPage';
import {
  AUTH_STORAGE_KEY,
  LEGACY_AUTH_STORAGE_KEY,
  resetAuthMemoryForTests,
} from './authStorage';

const TOKEN = 'synthetic.registration.token';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN_RESPONSE = {
  access_token: TOKEN,
  expires_in: 900,
  token_type: 'bearer',
};
const VALID_PASSWORD = ' exact password '; // 16 code points; spaces are intentional.

function currentUser(role: 'admin' | 'customer' | 'super_admin' = 'customer') {
  return {
    email: `${role}@example.invalid`,
    id: USER_ID,
    is_active: true,
    role,
  };
}

function renderRegister(initialEntry = '/register') {
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [
          { path: '/register', element: <RegisterPage /> },
          { path: '/login', element: <h1>Login destination</h1> },
          { path: '/', element: <h1>Landing destination</h1> },
          { path: '/account', element: <h1>Account destination</h1> },
          {
            path: '/account/orders/:publicOrderNumber',
            element: <h1>Account order destination</h1>,
          },
          { path: '/menu', element: <h1>Menu destination</h1> },
          { path: '/cart', element: <h1>Cart destination</h1> },
          { path: '/admin', element: <h1>Administrator destination</h1> },
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

async function submitRegistration(
  email = ' Customer@Example.Invalid ',
  password = VALID_PASSWORD,
  confirmPassword = password,
) {
  const user = userEvent.setup();
  const emailInput = await screen.findByLabelText('Email');
  const passwordInput = screen.getByLabelText('Password');
  const confirmInput = screen.getByLabelText('Confirm password');
  await user.type(emailInput, email);
  await user.type(passwordInput, password);
  await user.type(confirmInput, confirmPassword);
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  return { confirmInput, emailInput, passwordInput };
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('shared registration page', () => {
  it('renders one branded customer form with a decorative mark', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderRegister();

    expect(
      await screen.findByRole('heading', { name: 'Create account' }),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Nordic Hearth', { exact: true })).toBeVisible();
    expect(
      screen.queryByRole('img', { name: 'Nordic Hearth' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    expect(screen.getByText(/15 to 128 characters/i)).toBeVisible();
    expect(screen.queryByRole('combobox', { name: /role/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('carries a safe encoded continuation to login without submitting', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const { router } = renderRegister('/register?next=%2Fcart');

    const loginLink = await screen.findByRole('link', { name: 'Sign in' });
    expect(loginLink).toHaveAttribute('href', '/login?next=%2Fcart');

    await user.click(loginLink);

    expect(
      await screen.findByRole('heading', { name: 'Login destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?next=%2Fcart');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('toggles password visibility without changing its value or revealing after validation', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderRegister();
    const passwordInput = await screen.findByLabelText('Password');
    const confirmInput = screen.getByLabelText('Confirm password');
    await user.type(passwordInput, VALID_PASSWORD);
    await user.type(confirmInput, VALID_PASSWORD);

    const showPassword = screen.getByRole('button', { name: 'Show password' });
    expect(showPassword).toHaveAttribute('aria-pressed', 'false');
    expect(passwordInput).toHaveAttribute('type', 'password');
    await user.click(showPassword);
    expect(passwordInput).toHaveAttribute('type', 'text');
    expect(passwordInput).toHaveValue(VALID_PASSWORD);
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    const showConfirmation = screen.getByRole('button', {
      name: 'Show password confirmation',
    });
    expect(showConfirmation).toHaveAttribute('aria-pressed', 'false');
    await user.click(showConfirmation);
    expect(confirmInput).toHaveAttribute('type', 'text');
    expect(confirmInput).toHaveValue(VALID_PASSWORD);
    expect(
      screen.getByRole('button', { name: 'Hide password confirmation' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await user.click(
      screen.getByRole('button', { name: 'Hide password confirmation' }),
    );
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.getByText('Email is required.')).toBeVisible();
    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(passwordInput).toHaveValue(VALID_PASSWORD);
    expect(confirmInput).toHaveAttribute('type', 'password');
    expect(confirmInput).toHaveValue(VALID_PASSWORD);
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns home without submitting or validating confirmPassword', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const user = userEvent.setup();
    const { router } = renderRegister();

    const backLink = await screen.findByRole('link', { name: '← Back to home' });
    expect(backLink).toHaveAttribute('href', '/');

    await user.click(backLink);

    expect(
      await screen.findByRole('heading', { name: 'Landing destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('Confirm your password.')).not.toBeInTheDocument();
    expect(screen.queryByText('Passwords must match exactly.')).not.toBeInTheDocument();
  });

  it('blocks short passwords and focuses the password field', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderRegister();

    await submitRegistration('customer@example.invalid', 'short', 'short');

    expect(
      screen.getByText('Password must contain 15 to 128 characters.'),
    ).toBeVisible();
    expect(screen.getByLabelText('Password')).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('counts Unicode code points and rejects more than 128 characters', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderRegister();
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'customer@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'ą'.repeat(129) },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'ą'.repeat(129) },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      screen.getByText('Password must contain 15 to 128 characters.'),
    ).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps confirmPassword client-only and blocks a mismatch', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderRegister();

    await submitRegistration(
      'customer@example.invalid',
      VALID_PASSWORD,
      'different password',
    );

    expect(screen.getByText('Passwords must match exactly.')).toBeVisible();
    expect(screen.getByLabelText('Confirm password')).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends only normalized email and the exact untrimmed password', async () => {
    const stub = installFetchStub(
      { json: TOKEN_RESPONSE, status: 201 },
      { json: currentUser() },
    );
    sessionStorage.setItem('restaurant-ordering:cart:v1', 'preserved-cart');
    const { router } = renderRegister('/register?next=%2Fcart');

    await submitRegistration();

    expect(
      await screen.findByRole('heading', { name: 'Cart destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/cart');
    expect(stub.calls.map((call) => call.url)).toEqual([
      '/api/v1/auth/register',
      '/api/v1/auth/me',
    ]);
    const body = JSON.parse(stub.calls[0]?.body ?? '{}');
    expect(body).toEqual({
      email: 'customer@example.invalid',
      password: VALID_PASSWORD,
    });
    expect(Object.keys(body).sort()).toEqual(['email', 'password']);
    expect(stub.calls[0]?.body).not.toMatch(/confirm|role|is_active|\bid\b/i);
    expect(sessionStorage.getItem('restaurant-ordering:cart:v1')).toBe(
      'preserved-cart',
    );
    expect(document.body).not.toHaveTextContent(TOKEN);
  });

  it('uses /account after successful registration without a continuation', async () => {
    installFetchStub({ json: TOKEN_RESPONSE, status: 201 }, { json: currentUser() });
    const { router } = renderRegister();

    await submitRegistration();

    expect(
      await screen.findByRole('heading', { name: 'Account destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/account');
  });

  it('uses a safe ordinary continuation after registration', async () => {
    installFetchStub({ json: TOKEN_RESPONSE, status: 201 }, { json: currentUser() });
    const { router } = renderRegister('/register?next=%2Fcart');

    await submitRegistration();

    expect(
      await screen.findByRole('heading', { name: 'Cart destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/cart');
  });

  it.each(['/admin', '/admin/users'])(
    'sends a newly registered customer away from %s to /account',
    async (next) => {
      installFetchStub({ json: TOKEN_RESPONSE, status: 201 }, { json: currentUser() });
      const { router } = renderRegister(`/register?next=${encodeURIComponent(next)}`);

      await submitRegistration();

      expect(
        await screen.findByRole('heading', { name: 'Account destination' }),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe('/account');
    },
  );

  it('uses a safe account-detail continuation after registration', async () => {
    installFetchStub({ json: TOKEN_RESPONSE, status: 201 }, { json: currentUser() });
    const destination = '/account/orders/ROA-23456789ABCD';
    const { router } = renderRegister(
      `/register?next=${encodeURIComponent(destination)}`,
    );

    await submitRegistration();

    expect(
      await screen.findByRole('heading', { name: 'Account order destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe(destination);
  });

  it.each([
    [409, 'An account with this email already exists. Sign in instead.'],
    [422, 'The registration details were not accepted. Review them and try again.'],
    [503, 'Account creation is temporarily unavailable. Try again.'],
  ])('maps HTTP %i to a safe registration error', async (status, message) => {
    installFetchStub({ json: { detail: 'private backend detail' }, status });
    renderRegister();

    await submitRegistration();

    expect(await screen.findByText(message)).toBeVisible();
    expect(document.body).not.toHaveTextContent('private backend detail');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('blocks duplicate registration while exposing the real loading state', async () => {
    const pending = deferredResponse();
    const stub = installFetchStub({ responsePromise: pending.promise });
    renderRegister();

    const fields = await submitRegistration();

    const loadingButton = screen.getByRole('button', {
      name: /Creating account/u,
    });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveAttribute('aria-busy', 'true');
    const form = loadingButton.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    expect(stub.calls).toHaveLength(1);

    await act(async () => {
      pending.resolve(new Response(null, { status: 503 }));
      await pending.promise;
    });
    expect(
      await screen.findByText(
        'Account creation is temporarily unavailable. Try again.',
      ),
    ).toBeVisible();
    expect(fields.passwordInput).toHaveValue(VALID_PASSWORD);
    expect(fields.confirmInput).toHaveValue(VALID_PASSWORD);
  });

  it('recovers from a request error without rendering private detail or token', async () => {
    const user = userEvent.setup();
    const stub = installFetchStub(
      { json: { detail: 'private registration context' }, status: 503 },
      { json: TOKEN_RESPONSE, status: 201 },
      { json: currentUser() },
    );
    const { router } = renderRegister('/register?next=%2Fcart');

    const fields = await submitRegistration();
    expect(
      await screen.findByText(
        'Account creation is temporarily unavailable. Try again.',
      ),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent('private registration context');
    expect(fields.passwordInput).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByRole('heading', { name: 'Cart destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/cart');
    expect(stub.calls.map((call) => call.url)).toEqual([
      '/api/v1/auth/register',
      '/api/v1/auth/register',
      '/api/v1/auth/me',
    ]);
    expect(document.body).not.toHaveTextContent(TOKEN);
  });

  it('honors registration Retry-After without sending a second request', async () => {
    installFetchStub({ headers: { 'Retry-After': '2' }, status: 429 });
    renderRegister();
    const email = await screen.findByLabelText('Email');
    fireEvent.change(email, { target: { value: 'customer@example.invalid' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: VALID_PASSWORD },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: VALID_PASSWORD },
    });
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByRole('button', { name: 'Try again in 2 seconds' }),
    ).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });

  it('reports a safe network failure without persisting credentials', async () => {
    installFetchStub({ error: new TypeError('private offline detail') });
    renderRegister();

    await submitRegistration();

    expect(
      await screen.findByText(
        'We could not create your account. Check your connection and try again.',
      ),
    ).toBeVisible();
    expect(sessionStorage).toHaveLength(0);
  });

  it('blocks the form while checking a stored session', async () => {
    sessionStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: TOKEN, version: 1 }),
    );
    installFetchStub({ responsePromise: new Promise<Response>(() => undefined) });
    renderRegister();

    expect(
      await screen.findByRole('heading', { name: 'Checking your session' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Create account' }),
    ).not.toBeInTheDocument();
  });

  it('retains unresolved auth and exposes retry/logout without touching cart', async () => {
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
    renderRegister();

    expect(
      await screen.findByRole('heading', {
        name: 'Session validation is unavailable',
      }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry validation' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Clear session' }));
    expect(
      await screen.findByRole('heading', { name: 'Create account' }),
    ).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('restaurant-ordering:cart:v1')).toBe(
      'preserved-cart',
    );
  });

  it.each([
    ['customer', '/register', 'Account destination', '/account'],
    ['admin', '/register?next=%2Fadmin', 'Administrator destination', '/admin'],
    ['super_admin', '/register', 'Account destination', '/account'],
    ['admin', '/register?next=%2Fadmin%2Fusers', 'Administrator destination', '/admin'],
    [
      'super_admin',
      '/register?next=%2Fadmin%2Fusers',
      'User management destination',
      '/admin/users',
    ],
  ] as const)(
    'redirects an already-authenticated %s through the role policy',
    async (role, entry, heading, destination) => {
      sessionStorage.setItem(
        AUTH_STORAGE_KEY,
        JSON.stringify({ accessToken: TOKEN, version: 1 }),
      );
      installFetchStub({ json: currentUser(role) });
      const { router } = renderRegister(entry);

      expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
      expect(router.state.location.pathname).toBe(destination);
    },
  );

  it.each([
    'https://example.invalid/admin',
    '//example.invalid/admin',
    '/register',
    '/account/orders/not-an-order',
  ])('rejects an unsafe, looping, or unsupported next %s', async (next) => {
    installFetchStub({ json: TOKEN_RESPONSE, status: 201 }, { json: currentUser() });
    const { router } = renderRegister(`/register?next=${encodeURIComponent(next)}`);

    await submitRegistration();

    expect(
      await screen.findByRole('heading', { name: 'Account destination' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/account');
  });
});
