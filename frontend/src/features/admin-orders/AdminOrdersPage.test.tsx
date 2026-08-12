import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { ADMIN_AUTH_STORAGE_KEY } from '../admin-auth/adminAuthStorage';
import { adminRoutes } from '../../routes/adminRoutes';
import { installFetchStub, type FetchStep } from '../../test/fetchStub';
import { fetchAdminOrders } from './adminOrdersApi';

const SYNTHETIC_TOKEN = 'test-admin-token';
const ME_RESPONSE = { email: 'admin@example.test', is_active: true };
const FIRST_ORDER = {
  public_order_number: 'ROA-23456789ABCD',
  status: 'created',
  order_type: 'dine_in',
  table_number: 7,
  total_amount: 12_550,
  currency: 'NOK',
  created_at: '2026-08-12T10:00:00+00:00',
  updated_at: '2026-08-12T10:05:00+00:00',
};
const SECOND_ORDER = {
  ...FIRST_ORDER,
  public_order_number: 'ROA-BCDEFGHJKLMN',
  status: 'accepted',
  order_type: 'takeaway',
  table_number: null,
};

function listResponse(
  items: unknown[] = [FIRST_ORDER],
  overrides: Partial<{ limit: number; offset: number; total: number }> = {},
) {
  return {
    items,
    limit: overrides.limit ?? 50,
    offset: overrides.offset ?? 0,
    total: overrides.total ?? items.length,
  };
}

function storeToken(): void {
  sessionStorage.setItem(
    ADMIN_AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 1 }),
  );
}

function renderOrders(): ReturnType<typeof createMemoryRouter> {
  storeToken();
  const router = createMemoryRouter([adminRoutes], {
    initialEntries: ['/admin/orders'],
  });
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('administrator orders list', () => {
  it('uses the exact default authenticated GET and renders safe desktop and mobile data', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse([FIRST_ORDER, SECOND_ORDER]) },
    );

    renderOrders();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Orders' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Showing 1–2 of 2')).toBeInTheDocument();
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]?.url).toBe('/api/v1/admin/orders?limit=50&offset=0');
    expect(stub.calls[1]?.method).toBe('GET');
    expect(stub.calls[1]?.headers.get('Authorization')).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
    expect(
      screen.getByRole('table', { name: 'Administrator orders, newest first' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: FIRST_ORDER.public_order_number }),
    ).toHaveLength(2);
    expect(screen.getAllByText('Dine in')).not.toHaveLength(0);
    expect(screen.getAllByText('Not applicable')).not.toHaveLength(0);
    expect(screen.queryByText(/00000000-0000-4000/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /accept|cancel|prepar|ready|complete/i }),
    ).not.toBeInTheDocument();
  });

  it('shows a loading state while the list request remains pending', async () => {
    installFetchStub(
      { json: ME_RESPONSE },
      { responsePromise: new Promise<Response>(() => undefined) },
    );

    renderOrders();

    expect(
      await screen.findByRole('heading', { name: 'Loading orders' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('distinguishes the unfiltered and filtered empty states', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse([]) },
      { json: listResponse([]) },
    );
    const user = userEvent.setup();

    renderOrders();

    expect(
      await screen.findByRole('heading', { name: 'No orders yet' }),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'ready');
    expect(
      await screen.findByRole('heading', { name: 'No matching orders' }),
    ).toBeInTheDocument();
    expect(stub.calls[2]?.url).toBe(
      '/api/v1/admin/orders?status=ready&limit=50&offset=0',
    );
  });

  it('sends only exact status and order-type filters in one request per change', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse() },
      { json: listResponse() },
      { json: listResponse() },
    );
    const user = userEvent.setup();

    renderOrders();
    await screen.findByText('Showing 1–1 of 1');
    await user.selectOptions(screen.getByLabelText('Status'), 'accepted');
    await waitFor(() => expect(stub.calls).toHaveLength(3));
    expect(stub.calls[2]?.url).toBe(
      '/api/v1/admin/orders?status=accepted&limit=50&offset=0',
    );

    await user.selectOptions(screen.getByLabelText('Order type'), 'takeaway');
    await waitFor(() => expect(stub.calls).toHaveLength(4));
    expect(stub.calls[3]?.url).toBe(
      '/api/v1/admin/orders?status=accepted&order_type=takeaway&limit=50&offset=0',
    );
  });

  it('uses offset pagination and resets offset when a filter changes', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse([FIRST_ORDER], { total: 51 }) },
      { json: listResponse([SECOND_ORDER], { offset: 50, total: 51 }) },
      { json: listResponse([], { total: 0 }) },
    );
    const user = userEvent.setup();

    renderOrders();
    await screen.findByText('Showing 1–1 of 51');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 51–51 of 51')).toBeInTheDocument();
    expect(stub.calls[2]?.url).toBe('/api/v1/admin/orders?limit=50&offset=50');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Order type'), 'dine_in');
    await screen.findByRole('heading', { name: 'No matching orders' });
    expect(stub.calls[3]?.url).toBe(
      '/api/v1/admin/orders?order_type=dine_in&limit=50&offset=0',
    );
  });

  it('performs exactly one current request for manual Refresh', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: listResponse() },
      { json: listResponse([SECOND_ORDER]) },
    );
    const user = userEvent.setup();

    renderOrders();
    await screen.findByText('Showing 1–1 of 1');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findAllByText(SECOND_ORDER.public_order_number)).toHaveLength(
      2,
    );
    expect(stub.calls).toHaveLength(3);
  });

  it('ignores a stale list response after a filter starts a newer request', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { responsePromise: firstResponse },
      { json: listResponse([SECOND_ORDER]) },
    );
    const user = userEvent.setup();

    renderOrders();
    await screen.findByRole('heading', { name: 'Loading orders' });
    await user.selectOptions(screen.getByLabelText('Status'), 'accepted');
    expect(await screen.findAllByText(SECOND_ORDER.public_order_number)).toHaveLength(
      2,
    );

    resolveFirst?.(new Response(JSON.stringify(listResponse([FIRST_ORDER]))));
    await act(async () => Promise.resolve());
    expect(screen.queryByText(FIRST_ORDER.public_order_number)).not.toBeInTheDocument();
    expect(stub.calls[1]?.signal?.aborted).toBe(true);
  });

  it.each<[string, FetchStep, string]>([
    ['network', { error: new TypeError('offline') }, 'could not be reached'],
    ['validation', { status: 422 }, 'filters are not valid'],
    ['service', { status: 503 }, 'temporarily unavailable'],
    ['server', { status: 500 }, 'temporarily unavailable'],
  ])('shows a safe retryable %s error', async (_kind, step, message) => {
    installFetchStub({ json: ME_RESPONSE }, step);

    renderOrders();

    expect(
      await screen.findByRole('heading', { name: 'Unable to load orders' }),
    ).toBeInTheDocument();
    expect(screen.getByText(new RegExp(message, 'i'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('maps a request timeout to a safe connectivity state', async () => {
    vi.useFakeTimers();
    installFetchStub({ json: ME_RESPONSE }, { waitForAbort: true });

    renderOrders();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('heading', { name: 'Loading orders' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(
      screen.getByRole('heading', { name: 'Unable to load orders' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it.each([
    { ...listResponse(), unexpected: true },
    listResponse([{ ...FIRST_ORDER, status: 'invented' }]),
    listResponse([{ ...FIRST_ORDER, created_at: '2026-08-12T10:00:00' }]),
  ])('rejects a malformed successful response', async (response) => {
    installFetchStub({ json: response });

    await expect(fetchAdminOrders(SYNTHETIC_TOKEN)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('expires the shared session after a list 401 without exposing the response', async () => {
    const stub = installFetchStub({ json: ME_RESPONSE }, { status: 401 });
    const router = renderOrders();

    expect(
      await screen.findByRole('heading', { name: 'Administrator sign-in' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/login');
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toBeNull();
    expect(stub.calls).toHaveLength(2);
  });
});
