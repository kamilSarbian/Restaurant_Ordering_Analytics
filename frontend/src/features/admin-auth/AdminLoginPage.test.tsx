import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { ADMIN_AUTH_STORAGE_KEY } from './adminAuthStorage';
import { installFetchStub } from '../../test/fetchStub';
import { adminRoutes } from '../../routes/adminRoutes';

const SYNTHETIC_TOKEN = 'test-admin-token';
const LOGIN_RESPONSE = {
  access_token: SYNTHETIC_TOKEN,
  expires_in: 1_800,
  token_type: 'bearer',
};
const ME_RESPONSE = { email: 'admin@example.test', is_active: true };

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderLogin(initialEntry = '/admin/login') {
  const router = createMemoryRouter([adminRoutes], { initialEntries: [initialEntry] });
  return { router, ...render(<RouterProvider router={router} />) };
}

async function getLoginFields() {
  return {
    email: await screen.findByLabelText('Email'),
    password: screen.getByLabelText('Password'),
    submit: screen.getByRole('button', { name: 'Sign in' }),
  };
}

async function submitCredentials(
  email = 'ADMIN@example.test',
  password = ' synthetic password ',
) {
  const user = userEvent.setup();
  const fields = await getLoginFields();
  await user.type(fields.email, email);
  await user.type(fields.password, password);
  await user.click(fields.submit);
  return fields;
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('administrator login page', () => {
  it('requires an email and focuses the first invalid field', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const fields = await (renderLogin(), getLoginFields());

    await user.type(fields.password, 'synthetic password');
    await user.click(fields.submit);

    expect(screen.getByText('Email is required.')).toBeInTheDocument();
    expect(fields.email).toHaveFocus();
    expect(fields.email).toHaveAttribute('aria-describedby', 'admin-email-error');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an implausible email before fetch', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderLogin();

    const fields = await getLoginFields();
    const user = userEvent.setup();
    await user.type(fields.email, 'not-an-email');
    await user.type(fields.password, 'synthetic password');
    await user.click(fields.submit);

    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires a password without trimming or transforming it', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderLogin();
    const fields = await getLoginFields();
    const user = userEvent.setup();
    await user.type(fields.email, 'admin@example.test');
    await user.click(fields.submit);

    expect(screen.getByText('Password is required.')).toBeInTheDocument();
    expect(fields.password).toHaveFocus();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects passwords longer than 128 Unicode code points', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    renderLogin();
    const fields = await getLoginFields();
    const user = userEvent.setup();
    await user.type(fields.email, 'admin@example.test');
    await user.click(fields.password);
    await user.paste('å'.repeat(129));
    await user.click(fields.submit);

    expect(
      screen.getByText('Password must contain at most 128 characters.'),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves password whitespace and validates /me before navigation', async () => {
    const meResponse = deferredResponse();
    const stub = installFetchStub(
      { json: LOGIN_RESPONSE },
      { responsePromise: meResponse.promise },
    );
    const { router } = renderLogin();

    await submitCredentials();

    expect(JSON.parse(stub.calls[0]?.body ?? '')).toEqual({
      email: 'admin@example.test',
      password: ' synthetic password ',
    });
    expect(stub.calls).toHaveLength(2);
    expect(router.state.location.pathname).toBe('/admin/login');
    expect(screen.queryByText('Administrator workspace')).not.toBeInTheDocument();
    meResponse.resolve(
      new Response(JSON.stringify(ME_RESPONSE), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Administrator workspace' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin');
    expect(stub.calls[1]?.headers.get('Authorization')).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
  });

  it('stores only the token and never renders it after successful login', async () => {
    installFetchStub({ json: LOGIN_RESPONSE }, { json: ME_RESPONSE });
    renderLogin();

    await submitCredentials();

    await screen.findByRole('heading', { name: 'Administrator workspace' });
    expect(JSON.parse(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY) ?? '')).toEqual({
      accessToken: SYNTHETIC_TOKEN,
      version: 1,
    });
    expect(screen.queryByText(SYNTHETIC_TOKEN)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).not.toMatch(/password/i);
    expect(localStorage).toHaveLength(0);
  });

  it('continues in memory when sessionStorage rejects the token write', async () => {
    const storageWrite = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Blocked', 'SecurityError');
      });
    installFetchStub({ json: LOGIN_RESPONSE }, { json: ME_RESPONSE });
    renderLogin();

    await submitCredentials();

    expect(
      await screen.findByRole('heading', { name: 'Administrator workspace' }),
    ).toBeInTheDocument();
    expect(screen.getByText('admin@example.test')).toBeVisible();
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toBeNull();
    expect(localStorage).toHaveLength(0);
    storageWrite.mockRestore();
  });

  it('shows one safe message for a 401 and stores no token', async () => {
    installFetchStub({ status: 401 });
    renderLogin();

    await submitCredentials();

    expect(
      await screen.findByText('The email or password is incorrect.'),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('disables double submit while a login request is in flight', async () => {
    const pending = deferredResponse();
    const stub = installFetchStub({ responsePromise: pending.promise });
    renderLogin();

    const fields = await submitCredentials();

    expect(fields.submit).toBeDisabled();
    expect(stub.calls).toHaveLength(1);
    pending.resolve(new Response(null, { status: 401 }));
    expect(
      await screen.findByText('The email or password is incorrect.'),
    ).toBeInTheDocument();
  });

  it('uses Retry-After for a visible countdown and disabled submit', async () => {
    installFetchStub({ headers: { 'Retry-After': '2' }, status: 429 });
    renderLogin();
    const fields = await getLoginFields();
    const user = userEvent.setup();
    await user.type(fields.email, 'admin@example.test');
    await user.type(fields.password, 'synthetic password');
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(fields.submit);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByRole('button', { name: 'Try again in 2 seconds' }),
    ).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(
      screen.getByRole('button', { name: 'Try again in 1 seconds' }),
    ).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows generic rate-limit guidance when Retry-After is absent', async () => {
    installFetchStub({ status: 429 });
    renderLogin();

    await submitCredentials();

    expect(
      await screen.findByText('Too many sign-in attempts. Try again later.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it.each([
    [503, 'The authentication service is temporarily unavailable. Try again.'],
    [500, 'Sign-in could not reach the authentication service. Try again.'],
  ])('maps HTTP %i to a safe login error', async (status, message) => {
    installFetchStub({ status });
    renderLogin();

    await submitCredentials();

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('reports a network failure without persisting the password', async () => {
    installFetchStub({ error: new TypeError('offline') });
    renderLogin();

    await submitCredentials();

    expect(
      await screen.findByText(
        'Sign-in could not reach the authentication service. Try again.',
      ),
    ).toBeInTheDocument();
    expect(sessionStorage).toHaveLength(0);
  });

  it('reports a login timeout without persisting credentials', async () => {
    installFetchStub({ waitForAbort: true });
    renderLogin();
    const fields = await getLoginFields();
    const user = userEvent.setup();
    await user.type(fields.email, 'admin@example.test');
    await user.type(fields.password, 'synthetic password');
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(fields.submit);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(
      screen.getByText(
        'The sign-in request timed out. Check your connection and try again.',
      ),
    ).toBeInTheDocument();
    expect(sessionStorage).toHaveLength(0);
    expect(localStorage).toHaveLength(0);
  });

  it('rejects a malformed successful login response', async () => {
    installFetchStub({
      json: { access_token: SYNTHETIC_TOKEN, expires_in: 1_800, token_type: 'Basic' },
    });
    renderLogin();

    await submitCredentials();

    expect(
      await screen.findByText(
        'The authentication service returned an invalid response. Try again later.',
      ),
    ).toBeInTheDocument();
    expect(sessionStorage).toHaveLength(0);
  });

  it('keeps the token but blocks protected UI for malformed /me success', async () => {
    installFetchStub(
      { json: LOGIN_RESPONSE },
      { json: { email: 'admin@example.test', is_active: false } },
    );
    renderLogin();

    await submitCredentials();

    expect(
      await screen.findByRole('heading', { name: 'Session validation is unavailable' }),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toContain(SYNTHETIC_TOKEN);
    expect(screen.queryByText(SYNTHETIC_TOKEN)).not.toBeInTheDocument();
  });
});
