import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider } from '../auth/AuthContext';
import {
  AUTH_STORAGE_KEY,
  LEGACY_AUTH_STORAGE_KEY,
  resetAuthMemoryForTests,
} from '../auth/authStorage';
import LandingPage from './LandingPage';

const TOKEN = 'synthetic-landing-token';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function currentUser(role: 'admin' | 'customer' | 'super_admin') {
  return {
    email: `${role}@example.invalid`,
    id: USER_ID,
    is_active: true,
    role,
  };
}

function storeToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: TOKEN, version: 1 }),
  );
}

function renderLanding() {
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [
          { path: '/', element: <LandingPage /> },
          { path: '/menu', element: <h1>Menu destination</h1> },
          { path: '/login', element: <h1>Login destination</h1> },
          { path: '/register', element: <h1>Register destination</h1> },
          { path: '/admin', element: <h1>Admin destination</h1> },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LandingPage', () => {
  it('offers the exact public entry points without claiming an identity', () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    renderLanding();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Fresh food, ordered your way' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Order as guest' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute(
      'href',
      '/register',
    );
    expect(screen.queryByText(/my account/i)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows customer ordering and logout without anonymous or administrator actions', async () => {
    storeToken();
    installFetchStub({ json: currentUser('customer') });

    renderLanding();

    expect(await screen.findByText('customer@example.invalid')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Continue ordering' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(screen.getByRole('button', { name: 'Log out' })).toBeEnabled();
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Create account' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.queryByText(/my account/i)).not.toBeInTheDocument();
  });

  it.each(['admin', 'super_admin'] as const)(
    'offers the administrator destination to %s',
    async (role) => {
      storeToken();
      installFetchStub({ json: currentUser(role) });

      renderLanding();

      expect(await screen.findByRole('link', { name: 'Admin' })).toHaveAttribute(
        'href',
        '/admin',
      );
    },
  );

  it('does not flash definitive account actions while a session check is pending', async () => {
    storeToken();
    installFetchStub({ responsePromise: new Promise<Response>(() => undefined) });

    renderLanding();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Checking your saved session',
    );
    expect(
      screen.queryByRole('link', { name: 'Order as guest' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Continue ordering' }),
    ).not.toBeInTheDocument();
  });

  it('keeps an unavailable saved session retryable and clearable', async () => {
    storeToken();
    const stub = installFetchStub({ status: 503 }, { json: currentUser('customer') });
    const user = userEvent.setup();

    renderLanding();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Session validation is unavailable',
    );
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    expect(
      screen.queryByRole('link', { name: 'Order as guest' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry validation' }));

    expect(await screen.findByText('customer@example.invalid')).toBeVisible();
    expect(stub.calls).toHaveLength(2);
  });

  it('logs out locally while preserving unrelated browser-session state', async () => {
    storeToken();
    sessionStorage.setItem(
      LEGACY_AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'synthetic-legacy-token', version: 1 }),
    );
    sessionStorage.setItem('restaurant-ordering:cart:v1', 'preserved-cart');
    installFetchStub({ json: currentUser('customer') });
    const user = userEvent.setup();

    renderLanding();
    await screen.findByText('customer@example.invalid');
    await user.click(screen.getByRole('button', { name: 'Log out' }));

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Order as guest' })).toBeVisible(),
    );
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('restaurant-ordering:cart:v1')).toBe(
      'preserved-cart',
    );
  });
});
