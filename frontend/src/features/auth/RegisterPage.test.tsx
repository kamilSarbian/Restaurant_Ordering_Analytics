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
  it('renders accessible customer fields without a role control', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderRegister();

    expect(
      await screen.findByRole('heading', { name: 'Create account' }),
    ).toBeVisible();
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
    [503, 'The authentication service is temporarily unavailable. Try again.'],
  ])('maps HTTP %i to a safe registration error', async (status, message) => {
    installFetchStub({ json: { detail: 'private backend detail' }, status });
    renderRegister();

    await submitRegistration();

    expect(await screen.findByText(message)).toBeVisible();
    expect(document.body).not.toHaveTextContent('private backend detail');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
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
        'Registration could not reach the authentication service. Try again.',
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
