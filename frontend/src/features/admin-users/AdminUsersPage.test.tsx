import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Navigate, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub, type FetchStep } from '../../test/fetchStub';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import AdminUsersPage from './AdminUsersPage';

const TOKEN = 'synthetic-super-admin-session';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const SUPER_ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const CREATED_AT = '2026-08-10T08:00:00+00:00';
const UPDATED_AT = '2026-08-12T09:30:00+00:00';
const LOGIN_RESPONSE = {
  access_token: TOKEN,
  expires_in: 1_800,
  token_type: 'bearer',
};

const SUPER_ADMIN_ME = {
  email: 'governor@example.invalid',
  id: SUPER_ADMIN_ID,
  is_active: true,
  role: 'super_admin',
};

const CUSTOMER = {
  created_at: CREATED_AT,
  email: 'customer@example.invalid',
  id: CUSTOMER_ID,
  is_active: true,
  role: 'customer',
  updated_at: UPDATED_AT,
};

const ADMIN = {
  created_at: '2026-08-11T08:00:00+00:00',
  email: 'administrator@example.invalid',
  id: ADMIN_ID,
  is_active: false,
  role: 'admin',
  updated_at: '2026-08-12T10:30:00+00:00',
};

const SUPER_ADMIN = {
  created_at: '2026-08-09T08:00:00+00:00',
  email: 'governor@example.invalid',
  id: SUPER_ADMIN_ID,
  is_active: true,
  role: 'super_admin',
  updated_at: '2026-08-12T11:30:00+00:00',
};

function currentUser(role: 'admin' | 'customer' | 'super_admin') {
  return {
    email: `${role}@example.invalid`,
    id: SUPER_ADMIN_ID,
    is_active: true,
    role,
  };
}

function listResponse(
  items: unknown[] = [CUSTOMER],
  overrides: Partial<{ limit: number; offset: number; total: number }> = {},
) {
  return {
    items,
    limit: overrides.limit ?? 50,
    offset: overrides.offset ?? 0,
    total: overrides.total ?? items.length,
  };
}

function roleUpdateResponse(
  user: typeof CUSTOMER | typeof ADMIN,
  role: 'admin' | 'customer',
) {
  return {
    email: user.email,
    id: user.id,
    role,
    updated_at: '2026-08-12T12:00:00+00:00',
  };
}

function storeToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: TOKEN, version: 1 }),
  );
}

function SuperAdminPageGate() {
  const { phase, user } = useAuth();
  if (phase === 'checking-session') {
    return <h1>Checking super-administrator session</h1>;
  }
  if (phase === 'temporarily-unavailable') {
    return <h1>Super-administrator session unavailable</h1>;
  }
  if (phase === 'unauthenticated') {
    return <Navigate to="/login" replace />;
  }
  if (user?.role === 'customer') {
    return <Navigate to="/account" replace />;
  }
  if (user?.role === 'admin') {
    return <Navigate to="/admin" replace />;
  }
  return <AdminUsersPage />;
}

function PersistentPageHarness() {
  const { login, phase } = useAuth();
  return (
    <>
      <button
        type="button"
        onClick={() => void login('new-session@example.invalid', 'password')}
      >
        Establish newer session
      </button>
      <span data-testid="auth-phase">{phase}</span>
      <AdminUsersPage />
    </>
  );
}

function renderUsers(...steps: FetchStep[]) {
  storeToken();
  const stub = installFetchStub(...steps);
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [
          { path: '/admin/users', element: <SuperAdminPageGate /> },
          { path: '/account', element: <h1>Customer account destination</h1> },
          { path: '/admin', element: <h1>Administrator destination</h1> },
          { path: '/login', element: <h1>Sign in</h1> },
        ],
      },
    ],
    { initialEntries: ['/admin/users'] },
  );
  return { router, stub, ...render(<RouterProvider router={router} />) };
}

function renderPersistentUsers(...steps: FetchStep[]) {
  storeToken();
  const stub = installFetchStub(...steps);
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [{ path: '/admin/users', element: <PersistentPageHarness /> }],
      },
    ],
    { initialEntries: ['/admin/users'] },
  );
  return { router, stub, ...render(<RouterProvider router={router} />) };
}

function formatDate(timestamp: string): string {
  return new Intl.DateTimeFormat('en-NO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function getActionButton(name: RegExp): HTMLButtonElement {
  const button = screen.getAllByRole('button', { name })[0];
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Expected a role action button');
  }
  return button;
}

async function openConfirmation(actionName: RegExp): Promise<HTMLButtonElement> {
  const user = userEvent.setup();
  const action = getActionButton(actionName);
  await user.click(action);
  expect(screen.getByRole('heading', { name: 'Confirm role change' })).toHaveFocus();
  return action;
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('super-administrator users page', () => {
  it('fails closed while loading and then renders the stable empty state', async () => {
    let resolveList: ((response: Response) => void) | undefined;
    const listPromise = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    renderUsers({ json: SUPER_ADMIN_ME }, { responsePromise: listPromise });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Users' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Loading users' })).toBeVisible();

    await act(async () => {
      resolveList?.(
        new Response(JSON.stringify(listResponse([])), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await listPromise;
    });

    expect(
      await screen.findByRole('heading', { name: 'No users found' }),
    ).toBeVisible();
  });

  it('renders only safe responsive fields and keeps every super-admin row read-only', async () => {
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([SUPER_ADMIN, CUSTOMER, ADMIN]) },
    );

    expect(await screen.findByText('Showing 1–3 of 3')).toBeVisible();
    expect(
      screen.getByRole('table', { name: 'Registered users, oldest first' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Registered users, oldest first' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Super administrator')).toHaveLength(2);
    expect(screen.getAllByText('Customer')).toHaveLength(2);
    expect(screen.getAllByText('Administrator')).toHaveLength(2);
    expect(screen.getAllByText('Active')).toHaveLength(4);
    expect(screen.getAllByText('Inactive')).toHaveLength(2);
    expect(screen.getAllByText('Read only')).toHaveLength(2);
    expect(
      screen.getAllByRole('button', {
        name: `Promote to admin for ${CUSTOMER.email}`,
      }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole('button', {
        name: `Demote to customer for ${ADMIN.email}`,
      }),
    ).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /super administrator/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /assign super/i })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /delete|password|activate/i }),
    ).toBeNull();
    expect(screen.getAllByText(formatDate(CREATED_AT))).toHaveLength(2);
    expect(screen.getAllByText(formatDate(UPDATED_AT))).toHaveLength(2);
    expect(document.body).not.toHaveTextContent(CUSTOMER_ID);
    expect(document.body).not.toHaveTextContent(TOKEN);
    expect(stub.calls[1]?.url).toBe('/api/v1/admin/users?limit=50&offset=0');
    expect(stub.calls[1]?.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('paginates deterministically and preserves the current offset on retry', async () => {
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER], { total: 51 }) },
      { status: 503 },
      { json: listResponse([ADMIN], { offset: 50, total: 51 }) },
      { json: listResponse([CUSTOMER], { total: 51 }) },
    );
    const user = userEvent.setup();

    await screen.findByText('Showing 1–1 of 51');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(
      await screen.findByRole('heading', { name: 'Unable to load users' }),
    ).toBeVisible();
    expect(stub.calls[2]?.url).toBe('/api/v1/admin/users?limit=50&offset=50');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Showing 51–51 of 51')).toBeVisible();
    expect(stub.calls[3]?.url).toBe('/api/v1/admin/users?limit=50&offset=50');
    expect(screen.getByText('Page 2')).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Showing 1–1 of 51')).toBeVisible();
    expect(stub.calls[4]?.url).toBe('/api/v1/admin/users?limit=50&offset=0');
  });

  it.each([
    [{ error: new TypeError('offline') } satisfies FetchStep, /could not be reached/i],
    [
      { json: { items: 'not-a-list', limit: 50, offset: 0, total: 0 } },
      /unexpected response/i,
    ],
    [{ status: 503 } satisfies FetchStep, /temporarily unavailable/i],
  ])('shows a safe retryable list failure for %j', async (failure, message) => {
    renderUsers({ json: SUPER_ADMIN_ME }, failure);

    expect(
      await screen.findByRole('heading', { name: 'Unable to load users' }),
    ).toBeVisible();
    expect(screen.getByText(message)).toBeVisible();
    expect(document.body).not.toHaveTextContent('offline');
  });

  it('invalidates only the captured current session after a list 401', async () => {
    const { router, stub } = renderUsers({ json: SUPER_ADMIN_ME }, { status: 401 });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/login');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(stub.calls).toHaveLength(2);
  });

  it.each([
    ['customer', '/account', 'Customer account destination'],
    ['admin', '/admin', 'Administrator destination'],
  ] as const)(
    'refreshes a list 403 identity and sends a current %s to its safe destination',
    async (role, destination, heading) => {
      const { router, stub } = renderUsers(
        { json: SUPER_ADMIN_ME },
        { status: 403 },
        { json: currentUser(role) },
      );

      expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
      expect(router.state.location.pathname).toBe(destination);
      expect(stub.calls[2]?.url).toBe('/api/v1/auth/me');
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    },
  );

  it('locks an open confirmation after list 403 until reconciliation succeeds', async () => {
    const { router, stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER], { total: 51 }) },
      { status: 403 },
      { json: SUPER_ADMIN_ME },
      { status: 503 },
      { json: listResponse([CUSTOMER], { total: 51 }) },
    );
    const user = userEvent.setup();
    const actionName = new RegExp(`Promote to admin for ${CUSTOMER.email}`);

    await screen.findByText('Showing 1–1 of 51');
    await openConfirmation(actionName);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(
      await screen.findByText(/super-administrator access was confirmed/i),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/admin/users');
    expect(stub.calls[3]?.url).toBe('/api/v1/auth/me');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    expect(screen.getByText('Refresh required')).toBeVisible();

    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(confirmButton);
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    expect(getActionButton(actionName)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByRole('heading', { name: 'Unable to refresh users' }),
    ).toBeVisible();
    expect(screen.getByText('Refresh required')).toBeVisible();
    expect(confirmButton).toBeDisabled();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Role actions are available again/i)).toBeVisible();
    expect(screen.queryByText('Refresh required')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Confirm role change' })).toBeNull();
    expect(getActionButton(actionName)).toBeEnabled();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  it('requires explicit confirmation and returns focus after cancellation or Escape', async () => {
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
    );
    const user = userEvent.setup();
    const actionName = new RegExp(`Promote to admin for ${CUSTOMER.email}`);

    await screen.findByText('Showing 1–1 of 1');
    const initiatingAction = await openConfirmation(actionName);
    expect(screen.getByText(CUSTOMER.email, { selector: 'strong' })).toBeVisible();
    expect(stub.calls).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(initiatingAction).toHaveFocus());
    expect(stub.calls).toHaveLength(2);

    await user.click(initiatingAction);
    fireEvent.keyDown(screen.getByRole('group', { name: 'Confirm role change' }), {
      key: 'Escape',
    });
    await waitFor(() => expect(initiatingAction).toHaveFocus());
    expect(screen.queryByRole('heading', { name: 'Confirm role change' })).toBeNull();
    expect(stub.calls).toHaveLength(2);
  });

  it('does not update optimistically and uses one PATCH followed by an authoritative GET', async () => {
    let resolvePatch: ((response: Response) => void) | undefined;
    const patchPromise = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const promotedCustomer = { ...CUSTOMER, role: 'admin', updated_at: UPDATED_AT };
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
      { responsePromise: patchPromise },
      { json: listResponse([promotedCustomer]) },
    );
    await screen.findByText('Showing 1–1 of 1');
    await openConfirmation(new RegExp(`Promote to admin for ${CUSTOMER.email}`));
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    await waitFor(() => expect(stub.calls).toHaveLength(3));
    expect(stub.calls[2]?.method).toBe('PATCH');
    expect(stub.calls[2]?.body).toBe(JSON.stringify({ role: 'admin' }));
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(screen.getAllByText('Customer', { selector: 'span' })).toHaveLength(2);
    expect(screen.queryByText(/authoritative user list was loaded/i)).toBeNull();
    expect(
      screen
        .getAllByRole('button', {
          name: `Promote to admin for ${CUSTOMER.email}`,
        })
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);

    await act(async () => {
      resolvePatch?.(
        new Response(JSON.stringify(roleUpdateResponse(CUSTOMER, 'admin')), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await patchPromise;
    });

    expect(
      await screen.findByText(/authoritative user list was loaded/i),
    ).toBeVisible();
    expect(stub.calls).toHaveLength(4);
    expect(stub.calls[3]?.method).toBe('GET');
    expect(screen.getAllByText('Administrator', { selector: 'span' })).toHaveLength(2);
    expect(
      screen.getAllByRole('button', {
        name: `Demote to customer for ${CUSTOMER.email}`,
      }),
    ).toHaveLength(2);
  });

  it('supports the inverse admin-to-customer transition with the exact body', async () => {
    const demotedAdmin = { ...ADMIN, role: 'customer' };
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([ADMIN]) },
      { json: roleUpdateResponse(ADMIN, 'customer') },
      { json: listResponse([demotedAdmin]) },
    );
    const user = userEvent.setup();

    await screen.findByText('Showing 1–1 of 1');
    await openConfirmation(new RegExp(`Demote to customer for ${ADMIN.email}`));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByText(/authoritative user list was loaded/i),
    ).toBeVisible();
    expect(stub.calls[2]?.body).toBe(JSON.stringify({ role: 'customer' }));
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it.each([404, 409])(
    'reconciles a deterministic PATCH %s before enabling another action',
    async (status) => {
      const { stub } = renderUsers(
        { json: SUPER_ADMIN_ME },
        { json: listResponse([CUSTOMER]) },
        { status },
        { json: listResponse([ADMIN]) },
      );
      const user = userEvent.setup();

      await screen.findByText('Showing 1–1 of 1');
      await openConfirmation(new RegExp(`Promote to admin for ${CUSTOMER.email}`));
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      expect(await screen.findByText(/latest user state was loaded/i)).toBeVisible();
      expect(screen.queryByText('Refresh required')).toBeNull();
      expect(stub.calls).toHaveLength(4);
      expect(
        getActionButton(new RegExp(`Demote to customer for ${ADMIN.email}`)),
      ).toBeEnabled();
    },
  );

  it('reports a deterministic 422 safely and gates stale role actions', async () => {
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
      { status: 422 },
    );
    const user = userEvent.setup();

    await screen.findByText('Showing 1–1 of 1');
    await openConfirmation(new RegExp(`Promote to admin for ${CUSTOMER.email}`));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText(/transition was not valid/i)).toBeVisible();
    expect(stub.calls).toHaveLength(3);
    expect(screen.getByText('Refresh required')).toBeVisible();
    expect(getActionButton(/Promote to admin/)).toBeDisabled();
  });

  it('keeps ambiguous mutation outcomes gated until a successful reconciliation', async () => {
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER], { total: 51 }) },
      { error: new TypeError('connection lost after send') },
      { status: 503 },
      { json: listResponse([CUSTOMER], { total: 51 }) },
    );
    const user = userEvent.setup();

    await screen.findByText('Showing 1–1 of 51');
    await openConfirmation(new RegExp(`Promote to admin for ${CUSTOMER.email}`));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('Refresh required')).toBeVisible();
    expect(
      screen.getByText(/could not confirm whether the role changed/i),
    ).toBeVisible();
    expect(getActionButton(/Promote to admin/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(stub.calls).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByRole('heading', { name: 'Unable to refresh users' }),
    ).toBeVisible();
    expect(screen.getByText('Refresh required')).toBeVisible();
    expect(getActionButton(/Promote to admin/)).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Role actions are available again/i)).toBeVisible();
    expect(screen.queryByText('Refresh required')).toBeNull();
    expect(getActionButton(/Promote to admin/)).toBeEnabled();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('serializes list refreshes and mutations before explicit reconciliation', async () => {
    let resolveOldList: ((response: Response) => void) | undefined;
    const oldListPromise = new Promise<Response>((resolve) => {
      resolveOldList = resolve;
    });
    let resolvePatch: ((response: Response) => void) | undefined;
    const patchPromise = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const promotedCustomer = { ...CUSTOMER, role: 'admin', updated_at: UPDATED_AT };
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
      { responsePromise: oldListPromise },
      { responsePromise: patchPromise },
      { json: listResponse([promotedCustomer]) },
    );
    const user = userEvent.setup();
    const actionName = new RegExp(`Promote to admin for ${CUSTOMER.email}`);

    await screen.findByText(/Showing 1.*1 of 1/);
    await openConfirmation(actionName);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(stub.calls).toHaveLength(3));

    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeDisabled();
    fireEvent.click(confirmButton);
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);

    await act(async () => {
      resolveOldList?.(
        new Response(JSON.stringify(listResponse([CUSTOMER])), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await oldListPromise;
    });

    expect(screen.queryByRole('heading', { name: 'Confirm role change' })).toBeNull();
    await openConfirmation(actionName);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1),
    );

    const refreshButton = screen.getByRole('button', { name: 'Refresh' });
    expect(refreshButton).toBeDisabled();
    fireEvent.click(refreshButton);
    expect(stub.calls).toHaveLength(4);

    await act(async () => {
      resolvePatch?.(new Response(null, { status: 503 }));
      await patchPromise;
    });

    expect(await screen.findByText('Refresh required')).toBeVisible();
    expect(getActionButton(actionName)).toBeDisabled();
    expect(stub.calls).toHaveLength(4);

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Role actions are available again/i)).toBeVisible();
    expect(screen.queryByText('Refresh required')).toBeNull();
    expect(
      getActionButton(new RegExp(`Demote to customer for ${CUSTOMER.email}`)),
    ).toBeEnabled();
    expect(stub.calls).toHaveLength(5);
  });

  it('treats a mutation 503 as ambiguous and blocks another PATCH', async () => {
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
      { status: 503 },
    );
    const user = userEvent.setup();

    await screen.findByText('Showing 1–1 of 1');
    await openConfirmation(new RegExp(`Promote to admin for ${CUSTOMER.email}`));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('Refresh required')).toBeVisible();
    expect(
      screen.getByText(/could not confirm whether the role changed/i),
    ).toBeVisible();
    expect(getActionButton(/Promote to admin/)).toBeDisabled();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('treats an invalid successful mutation response as ambiguous', async () => {
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
      {
        json: {
          ...roleUpdateResponse(CUSTOMER, 'admin'),
          unexpected: 'field',
        },
      },
    );
    const user = userEvent.setup();

    await screen.findByText('Showing 1–1 of 1');
    await openConfirmation(new RegExp(`Promote to admin for ${CUSTOMER.email}`));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('Refresh required')).toBeVisible();
    expect(
      screen.getByText(/could not confirm whether the role changed/i),
    ).toBeVisible();
    expect(getActionButton(/Promote to admin/)).toBeDisabled();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('treats a mutation timeout as ambiguous and leaves reconciliation required', async () => {
    const { stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
      { waitForAbort: true },
    );

    await screen.findByText('Showing 1–1 of 1');
    vi.useFakeTimers();
    fireEvent.click(
      getActionButton(new RegExp(`Promote to admin for ${CUSTOMER.email}`)),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
    });

    expect(screen.getByText('Refresh required')).toBeVisible();
    expect(
      screen.getByText(/could not confirm whether the role changed/i),
    ).toBeVisible();
    expect(getActionButton(/Promote to admin/)).toBeDisabled();
  });

  it('invalidates the captured current session after a mutation 401', async () => {
    const { router, stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
      { status: 401 },
    );
    const user = userEvent.setup();

    await screen.findByText('Showing 1–1 of 1');
    await openConfirmation(new RegExp(`Promote to admin for ${CUSTOMER.email}`));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/login');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('ignores an old-generation mutation 401 after a newer login returns the same token', async () => {
    let resolveOldMutation: ((response: Response) => void) | undefined;
    const oldMutationPromise = new Promise<Response>((resolve) => {
      resolveOldMutation = resolve;
    });
    const { router, stub } = renderPersistentUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
      { responsePromise: oldMutationPromise },
      { json: LOGIN_RESPONSE },
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
    );
    const user = userEvent.setup();

    await screen.findByText('Showing 1–1 of 1');
    await openConfirmation(new RegExp(`Promote to admin for ${CUSTOMER.email}`));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(stub.calls).toHaveLength(3));

    await user.click(screen.getByRole('button', { name: 'Establish newer session' }));
    await waitFor(() =>
      expect(screen.getByTestId('auth-phase')).toHaveTextContent('authenticated'),
    );
    expect(stub.calls.length).toBeGreaterThanOrEqual(5);

    await act(async () => {
      resolveOldMutation?.(new Response(null, { status: 401 }));
      await oldMutationPromise;
    });

    await waitFor(() =>
      expect(screen.getByTestId('auth-phase')).toHaveTextContent('authenticated'),
    );
    expect(router.state.location.pathname).toBe('/admin/users');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBe(
      JSON.stringify({ accessToken: TOKEN, version: 1 }),
    );
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it.each([
    ['customer', '/account', 'Customer account destination'],
    ['admin', '/admin', 'Administrator destination'],
  ] as const)(
    'refreshes a mutation 403 identity and sends a current %s away safely',
    async (role, destination, heading) => {
      const { router, stub } = renderUsers(
        { json: SUPER_ADMIN_ME },
        { json: listResponse([CUSTOMER]) },
        { status: 403 },
        { json: currentUser(role) },
      );
      const user = userEvent.setup();

      await screen.findByText('Showing 1–1 of 1');
      await openConfirmation(new RegExp(`Promote to admin for ${CUSTOMER.email}`));
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
      expect(router.state.location.pathname).toBe(destination);
      expect(stub.calls[3]?.url).toBe('/api/v1/auth/me');
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    },
  );

  it('keeps a refreshed super-admin after mutation 403 without logging out', async () => {
    const { router, stub } = renderUsers(
      { json: SUPER_ADMIN_ME },
      { json: listResponse([CUSTOMER]) },
      { status: 403 },
      { json: SUPER_ADMIN_ME },
    );
    const user = userEvent.setup();

    await screen.findByText('Showing 1–1 of 1');
    await openConfirmation(new RegExp(`Promote to admin for ${CUSTOMER.email}`));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText(/role update was denied/i)).toBeVisible();
    expect(router.state.location.pathname).toBe('/admin/users');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    expect(stub.calls[3]?.url).toBe('/api/v1/auth/me');
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(screen.getByText('Refresh required')).toBeVisible();
    expect(getActionButton(/Promote to admin/)).toBeDisabled();
  });
});
