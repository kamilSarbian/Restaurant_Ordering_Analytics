import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { adminRoutes } from '../../routes/adminRoutes';
import { installFetchStub, type FetchStep } from '../../test/fetchStub';
import { AuthProvider } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import {
  fetchAdminOrderDetail,
  formatAdminMoney,
  type OrderStatus,
  type PaymentStatus,
  updateAdminOrderStatus,
} from './adminOrdersApi';

const SYNTHETIC_TOKEN = 'test-admin-token';
const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const ORDER_ID = '00000000-0000-4000-8000-000000000001';
const ITEM_ID = '00000000-0000-4000-8000-000000000002';
const MENU_ITEM_ID = '00000000-0000-4000-8000-000000000003';
const PAYMENT_ID = '00000000-0000-4000-8000-000000000004';
const PAYMENT_IDS = [
  PAYMENT_ID,
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
] as const;
const ME_RESPONSE = {
  email: 'admin@example.test',
  id: '00000000-0000-4000-8000-000000000905',
  is_active: true,
  role: 'admin',
};
const CUSTOMER_ME_RESPONSE = { ...ME_RESPONSE, role: 'customer' };
const DETAIL_RESPONSE = {
  order_id: ORDER_ID,
  public_order_number: PUBLIC_ORDER_NUMBER,
  status: 'accepted',
  order_type: 'dine_in',
  table_number: 7,
  currency: 'NOK',
  subtotal_amount: 25_000,
  total_amount: 25_000,
  created_at: '2026-08-12T10:00:00+00:00',
  updated_at: '2026-08-12T10:05:00+00:00',
  items: [
    {
      id: ITEM_ID,
      menu_item_id: MENU_ITEM_ID,
      position: 0,
      category_name: 'Historical mains',
      name: 'Historical seasonal bowl',
      quantity: 2,
      unit_price_amount: 12_500,
      unit_cost_amount: 7_500,
      tax_rate_bps: 2_500,
      discount_amount: 0,
      line_total_amount: 25_000,
    },
  ],
  status_history: [
    {
      sequence: 0,
      previous_status: null,
      new_status: 'created',
      changed_at: '2026-08-12T10:00:00+00:00',
    },
    {
      sequence: 1,
      previous_status: 'created',
      new_status: 'accepted',
      changed_at: '2026-08-12T10:05:00+00:00',
    },
  ],
  payments: [
    {
      id: PAYMENT_ID,
      status: 'succeeded',
      amount: 25_000,
      currency: 'NOK',
      created_at: '2026-08-12T10:01:00+00:00',
      updated_at: '2026-08-12T10:04:00+00:00',
      checkout_expires_at: '2026-08-12T10:31:00+00:00',
    },
  ],
};

const STATUS_PATHS: Record<OrderStatus, OrderStatus[]> = {
  accepted: ['created', 'accepted'],
  cancelled: ['created', 'cancelled'],
  completed: ['created', 'accepted', 'preparing', 'ready', 'completed'],
  created: ['created'],
  preparing: ['created', 'accepted', 'preparing'],
  ready: ['created', 'accepted', 'preparing', 'ready'],
};

function detailResponse(status: OrderStatus) {
  const path = STATUS_PATHS[status];
  return {
    ...DETAIL_RESPONSE,
    status,
    status_history: path.map((newStatus, sequence) => ({
      sequence,
      previous_status: sequence === 0 ? null : path[sequence - 1],
      new_status: newStatus,
      changed_at: `2026-08-12T10:0${sequence}:00+00:00`,
    })),
  };
}

function paymentResponse(status: PaymentStatus, index: number) {
  const id = PAYMENT_IDS[index];
  if (id === undefined) {
    throw new Error('Synthetic payment index is outside the approved fixture range');
  }
  return {
    ...DETAIL_RESPONSE.payments[0],
    id,
    status,
    created_at: `2026-08-12T10:0${index + 1}:00+00:00`,
    updated_at: `2026-08-12T10:1${index}:00+00:00`,
  };
}

function detailWithPayments(
  status: OrderStatus,
  paymentStatuses: readonly PaymentStatus[],
) {
  return {
    ...detailResponse(status),
    payments: paymentStatuses.map(paymentResponse),
  };
}

function formattedMoneyMatcher(amount: number, currency: string) {
  const expected = formatAdminMoney(amount, currency).replace(/\s/g, ' ');
  return (_content: string, element: Element | null) =>
    element?.textContent?.replace(/\s/g, ' ') === expected;
}

function statusUpdateResponse(previousStatus: OrderStatus, targetStatus: OrderStatus) {
  return {
    public_order_number: PUBLIC_ORDER_NUMBER,
    status: targetStatus,
    updated_at: '2026-08-12T10:10:00+00:00',
    history: {
      sequence: STATUS_PATHS[previousStatus].length,
      previous_status: previousStatus,
      new_status: targetStatus,
      changed_at: '2026-08-12T10:10:00+00:00',
    },
  };
}

function storeToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 1 }),
  );
}

function renderDetail(): ReturnType<typeof createMemoryRouter> {
  storeToken();
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [
          { path: '/', element: <h1>Customer home</h1> },
          { path: '/account', element: <h1>Customer account</h1> },
          { path: '/login', element: <h1>Sign in</h1> },
          adminRoutes,
        ],
      },
    ],
    { initialEntries: [`/admin/orders/${PUBLIC_ORDER_NUMBER}`] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('administrator read-only order detail', () => {
  it('uses the exact authenticated GET and renders snapshots, totals, history, and safe payments', async () => {
    const stub = installFetchStub({ json: ME_RESPONSE }, { json: DETAIL_RESPONSE });

    renderDetail();

    await screen.findByRole('heading', {
      level: 1,
      name: `Order ${PUBLIC_ORDER_NUMBER}`,
    });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      await screen.findByRole('heading', { name: 'Order items' }),
    ).toBeInTheDocument();
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]?.url).toBe(`/api/v1/admin/orders/${PUBLIC_ORDER_NUMBER}`);
    expect(stub.calls[1]?.method).toBe('GET');
    expect(stub.calls[1]?.body).toBeNull();
    expect(stub.calls[1]?.headers.get('Authorization')).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
    expect(screen.getByText('Historical mains')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Historical seasonal bowl' }),
    ).toBeInTheDocument();

    const summarySection = screen
      .getByRole('heading', { name: 'Order summary' })
      .closest('section');
    expect(summarySection).not.toBeNull();
    expect(
      within(summarySection as HTMLElement).getByText('Dine in'),
    ).toBeInTheDocument();
    expect(
      within(summarySection as HTMLElement).getByText(
        formattedMoneyMatcher(25_000, 'NOK'),
      ),
    ).toBeInTheDocument();
    expect(
      within(summarySection as HTMLElement)
        .getByText('Accepted')
        .closest('[data-variant]'),
    ).toHaveAttribute('data-variant', 'info');

    const itemsSection = screen
      .getByRole('heading', { name: 'Order items' })
      .closest('section');
    expect(itemsSection).not.toBeNull();
    expect(
      within(itemsSection as HTMLElement).getAllByText(
        formattedMoneyMatcher(25_000, 'NOK'),
      ),
    ).toHaveLength(3);
    expect(
      within(itemsSection as HTMLElement).getByText(
        formattedMoneyMatcher(12_500, 'NOK'),
      ),
    ).toBeInTheDocument();
    expect(
      within(itemsSection as HTMLElement).queryByText(/unit cost|tax|discount/i),
    ).not.toBeInTheDocument();

    const paymentsSection = screen
      .getByRole('heading', { name: 'Payment attempts' })
      .closest('section');
    expect(paymentsSection).not.toBeNull();
    expect(
      within(paymentsSection as HTMLElement)
        .getByText('Succeeded')
        .closest('[data-variant]'),
    ).toHaveAttribute('data-variant', 'success');
    expect(
      within(paymentsSection as HTMLElement).getByText('Recorded checkout expiry'),
    ).toBeInTheDocument();
    expect(
      within(paymentsSection as HTMLElement).getByText(
        'Payment-attempt status is separate from the order fulfilment status.',
      ),
    ).toBeInTheDocument();
    expect(
      within(paymentsSection as HTMLElement).getByText(
        'Provider reconciliation state is not exposed by this order-detail contract.',
      ),
    ).toBeInTheDocument();
    expect(
      within(paymentsSection as HTMLElement).queryByText(
        /reconciliation (required|clear|complete)|provider confirmed/i,
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Status history' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Orders' })).toHaveAttribute(
      'href',
      '/admin/orders',
    );
    expect(screen.queryByText(ORDER_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(ITEM_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(MENU_ITEM_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(PAYMENT_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(SYNTHETIC_TOKEN)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/stripe|idempotency|checkout url|access token|token hash/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start preparing' })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Accept order' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel order' }),
    ).not.toBeInTheDocument();
    expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(screen.getByRole('article')).toHaveAttribute('aria-busy', 'false');
  });

  it('shows a polite loading state while detail remains pending', async () => {
    installFetchStub(
      { json: ME_RESPONSE },
      { responsePromise: new Promise<Response>(() => undefined) },
    );

    renderDetail();

    expect(
      await screen.findByRole('heading', { name: 'Loading order' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('article')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Refreshing order' })).toBeDisabled();
  });

  it('renders the exact empty-payments state without inferring payment failure', async () => {
    installFetchStub(
      { json: ME_RESPONSE },
      { json: { ...DETAIL_RESPONSE, payments: [] } },
    );

    renderDetail();

    expect(await screen.findByText('No payment records.')).toBeInTheDocument();
    expect(screen.getByText('No payment attempts')).toBeInTheDocument();
    expect(
      screen.queryByText(/failed payment|payment failed/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Provider reconciliation state is not exposed by this order-detail contract.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/reconciliation (required|clear|complete)/i),
    ).not.toBeInTheDocument();
  });

  it.each<[OrderStatus, string]>([
    ['created', 'neutral'],
    ['accepted', 'info'],
    ['preparing', 'warning'],
    ['ready', 'info'],
    ['completed', 'success'],
    ['cancelled', 'danger'],
  ])(
    'renders the authoritative %s status with the %s badge semantics',
    async (status, expectedVariant) => {
      installFetchStub(
        { json: ME_RESPONSE },
        { json: detailWithPayments(status, ['succeeded']) },
      );

      renderDetail();

      const summary = (
        await screen.findByRole('heading', { name: 'Order summary' })
      ).closest('section');
      expect(summary).not.toBeNull();
      const statusLabel = {
        accepted: 'Accepted',
        cancelled: 'Cancelled',
        completed: 'Completed',
        created: 'Created',
        preparing: 'Preparing',
        ready: 'Ready',
      }[status];
      const badge = within(summary as HTMLElement)
        .getAllByText(statusLabel)
        .map((element) => element.closest('[data-variant]'))
        .find((element) => element !== null);
      expect(badge).toHaveAttribute('data-variant', expectedVariant);
      expect(badge?.querySelector('[aria-hidden="true"]')).not.toBeNull();
      if (status === 'cancelled') {
        expect(badge).not.toHaveAttribute('data-variant', 'success');
      }
    },
  );

  it('keeps all payment-attempt states separate and makes no reconciliation claim', async () => {
    installFetchStub(
      { json: ME_RESPONSE },
      {
        json: detailWithPayments('accepted', [
          'pending',
          'succeeded',
          'failed',
          'expired',
        ]),
      },
    );

    renderDetail();

    const payments = (
      await screen.findByRole('heading', {
        name: 'Payment attempts',
      })
    ).closest('section');
    expect(payments).not.toBeNull();
    for (const [label, variant] of [
      ['Pending', 'warning'],
      ['Succeeded', 'success'],
      ['Failed', 'danger'],
      ['Expired', 'neutral'],
    ] as const) {
      expect(
        within(payments as HTMLElement)
          .getByText(label)
          .closest('[data-variant]'),
      ).toHaveAttribute('data-variant', variant);
    }
    expect(
      within(payments as HTMLElement).queryByText(
        /reconciliation (required|clear|complete)|provider confirmed/i,
      ),
    ).not.toBeInTheDocument();
  });

  it('renders long authoritative item content and large totals without exposing hidden rows', async () => {
    const longName =
      'Nordic Hearth historical winter tasting platter with preserved seasonal details';
    const largeAmount = 9_876_543_210;
    installFetchStub(
      { json: ME_RESPONSE },
      {
        json: {
          ...DETAIL_RESPONSE,
          subtotal_amount: largeAmount,
          total_amount: largeAmount,
          items: [
            {
              ...DETAIL_RESPONSE.items[0],
              line_total_amount: largeAmount,
              name: longName,
              quantity: 1,
              unit_price_amount: largeAmount,
            },
          ],
        },
      },
    );

    renderDetail();

    expect(
      await screen.findByRole('heading', { level: 3, name: longName }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(formattedMoneyMatcher(largeAmount, 'NOK')).length,
    ).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText(/unit cost|tax|discount/i)).not.toBeInTheDocument();
  });

  it('manually refreshes the same detail exactly once', async () => {
    const updatedDetail = {
      ...DETAIL_RESPONSE,
      status: 'preparing',
      updated_at: '2026-08-12T10:10:00+00:00',
    };
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: DETAIL_RESPONSE },
      { json: updatedDetail },
    );
    const user = userEvent.setup();

    renderDetail();
    await screen.findByRole('heading', { name: 'Order items' });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Preparing')).toBeInTheDocument();
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[2]?.url).toBe(`/api/v1/admin/orders/${PUBLIC_ORDER_NUMBER}`);
  });

  it('shows the safe not-found state for a detail 404', async () => {
    installFetchStub({ json: ME_RESPONSE }, { status: 404 });

    renderDetail();

    expect(
      await screen.findByRole('heading', { name: 'Order not found' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No order is available/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Order not found' })).toHaveFocus(),
    );
  });

  it.each<[string, FetchStep, string]>([
    ['network', { error: new TypeError('offline') }, 'could not be reached'],
    ['service', { status: 503 }, 'temporarily unavailable'],
    ['server', { status: 500 }, 'temporarily unavailable'],
  ])('shows a safe retryable %s error', async (_kind, step, message) => {
    installFetchStub({ json: ME_RESPONSE }, step);

    renderDetail();

    expect(
      await screen.findByRole('heading', { name: 'Unable to load order' }),
    ).toBeInTheDocument();
    expect(screen.getByText(new RegExp(message, 'i'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry order' })).toBeInTheDocument();
  });

  it('retries one failed detail read and focuses the authoritative summary', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { error: new TypeError('offline') },
      { json: DETAIL_RESPONSE },
    );
    const user = userEvent.setup();

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Retry order' }));

    const summaryHeading = await screen.findByRole('heading', {
      name: 'Order summary',
    });
    await waitFor(() => expect(summaryHeading).toHaveFocus());
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[2]?.method).toBe('GET');
    expect(stub.calls[2]?.url).toBe(`/api/v1/admin/orders/${PUBLIC_ORDER_NUMBER}`);
  });

  it('maps a detail timeout to a safe connectivity state', async () => {
    vi.useFakeTimers();
    installFetchStub({ json: ME_RESPONSE }, { waitForAbort: true });

    renderDetail();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('heading', { name: 'Loading order' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(
      screen.getByRole('heading', { name: 'Unable to load order' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it.each([
    { ...DETAIL_RESPONSE, unexpected: true },
    {
      ...DETAIL_RESPONSE,
      status_history: [{ ...DETAIL_RESPONSE.status_history[0], sequence: -1 }],
    },
    { ...DETAIL_RESPONSE, items: [{ ...DETAIL_RESPONSE.items[0], id: 'not-a-uuid' }] },
    {
      ...DETAIL_RESPONSE,
      payments: [
        {
          ...DETAIL_RESPONSE.payments[0],
          stripe_checkout_session_id: 'cs_forbidden',
        },
      ],
    },
    { ...DETAIL_RESPONSE, public_order_number: 'ROA-BCDEFGHJKLMN' },
  ])('rejects malformed or expanded successful detail', async (response) => {
    installFetchStub({ json: response });

    await expect(
      fetchAdminOrderDetail(SYNTHETIC_TOKEN, PUBLIC_ORDER_NUMBER),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('expires the shared session after a detail 401', async () => {
    const stub = installFetchStub({ json: ME_RESPONSE }, { status: 401 });
    const router = renderDetail();

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      `/admin/orders/${PUBLIC_ORDER_NUMBER}`,
    );
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('refreshes the shared identity after a detail 403 and applies the customer guard', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { status: 403 },
      { json: CUSTOMER_ME_RESPONSE },
    );
    const router = renderDetail();

    expect(
      await screen.findByRole('heading', { name: 'Customer account' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account');
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[stub.calls.length - 1]?.url).toBe('/api/v1/auth/me');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBe(
      JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 1 }),
    );
    expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});

describe('administrator order status mutations', () => {
  const allActionLabels = [
    'Accept order',
    'Cancel order',
    'Start preparing',
    'Mark ready',
    'Complete order',
  ];

  it.each<[OrderStatus, string[]]>([
    ['created', ['Accept order']],
    ['accepted', ['Start preparing']],
    ['preparing', ['Mark ready']],
    ['ready', ['Complete order']],
    ['completed', []],
    ['cancelled', []],
  ])('shows only valid actions for %s', async (status, expectedActions) => {
    installFetchStub({ json: ME_RESPONSE }, { json: detailResponse(status) });

    renderDetail();

    expect(
      await screen.findByRole('heading', { name: 'Order actions' }),
    ).toBeInTheDocument();
    for (const label of allActionLabels) {
      const action = screen.queryByRole('button', { name: label });
      if (expectedActions.includes(label)) {
        expect(action).toBeEnabled();
      } else {
        expect(action).not.toBeInTheDocument();
      }
    }
    if (expectedActions.length === 0) {
      expect(
        screen.getByText('No further status actions are available.'),
      ).toBeInTheDocument();
    } else {
      expect(
        screen.queryByText('No further status actions are available.'),
      ).not.toBeInTheDocument();
    }
  });

  it.each<{
    expectedActions: string[];
    guidance: RegExp;
    paymentStatuses: PaymentStatus[];
  }>([
    {
      expectedActions: ['Cancel order'],
      guidance: /acceptance is unavailable because no succeeded payment/i,
      paymentStatuses: [],
    },
    {
      expectedActions: ['Cancel order'],
      guidance: /acceptance is unavailable because no succeeded payment/i,
      paymentStatuses: ['failed'],
    },
    {
      expectedActions: ['Cancel order'],
      guidance: /acceptance is unavailable because no succeeded payment/i,
      paymentStatuses: ['failed', 'expired'],
    },
    {
      expectedActions: [],
      guidance: /pending payment attempt blocks acceptance and cancellation/i,
      paymentStatuses: ['pending'],
    },
    {
      expectedActions: ['Accept order'],
      guidance: /cancellation is unavailable because a succeeded payment/i,
      paymentStatuses: ['succeeded'],
    },
    {
      expectedActions: ['Accept order'],
      guidance: /cancellation is unavailable because a succeeded payment/i,
      paymentStatuses: ['pending', 'succeeded'],
    },
  ])(
    'pre-gates created-order actions from persisted attempts: $paymentStatuses',
    async ({ expectedActions, guidance, paymentStatuses }) => {
      const stub = installFetchStub(
        { json: ME_RESPONSE },
        { json: detailWithPayments('created', paymentStatuses) },
      );

      renderDetail();

      await screen.findByRole('heading', { name: 'Order actions' });
      for (const label of ['Accept order', 'Cancel order']) {
        const action = screen.queryByRole('button', { name: label });
        if (expectedActions.includes(label)) {
          expect(action).toBeEnabled();
        } else {
          expect(action).not.toBeInTheDocument();
        }
      }
      expect(screen.getByText(guidance)).toBeInTheDocument();
      if (expectedActions.length === 0) {
        expect(
          screen.getByText('No status action is currently available.'),
        ).toBeInTheDocument();
      }
      if (paymentStatuses.includes('pending')) {
        const payments = screen
          .getByRole('heading', { name: 'Payment attempts' })
          .closest('section');
        expect(payments).not.toBeNull();
        expect(
          within(payments as HTMLElement).getByText('Pending'),
        ).toBeInTheDocument();
        expect(
          within(payments as HTMLElement).getAllByText('Recorded checkout expiry')
            .length,
        ).toBeGreaterThanOrEqual(1);
      }
      expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);
    },
  );

  it('requires inline confirmation and returns focus without sending a PATCH', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailWithPayments('created', ['succeeded']) },
    );
    const user = userEvent.setup();

    renderDetail();
    const acceptButton = await screen.findByRole('button', { name: 'Accept order' });
    await user.click(acceptButton);

    expect(screen.getByRole('heading', { name: 'Accept this order?' })).toHaveFocus();
    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Confirm Accept order' }),
    ).toHaveAttribute('data-variant', 'primary');
    expect(stub.calls).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Keep current status' }));
    expect(
      screen.queryByRole('button', { name: 'Confirm Accept order' }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(acceptButton).toHaveFocus());
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('separates destructive cancellation and preserves its explicit confirmation', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailWithPayments('created', []) },
    );
    const user = userEvent.setup();

    renderDetail();
    const cancelButton = await screen.findByRole('button', {
      name: 'Cancel order',
    });
    expect(cancelButton).toHaveAttribute('data-variant', 'danger');
    expect(screen.getByText('Destructive action')).toBeInTheDocument();
    await user.click(cancelButton);

    const confirmationHeading = screen.getByRole('heading', {
      name: 'Cancel this order? This action cannot be undone in the current workflow.',
    });
    expect(confirmationHeading).toHaveFocus();
    expect(screen.getByText('Confirm destructive action')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Confirm Cancel order' }),
    ).toHaveAttribute('data-variant', 'danger');
    expect(confirmationHeading.closest('[data-destructive]')).toHaveAttribute(
      'data-destructive',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Keep current status' }));
    expect(
      screen.queryByRole('button', { name: 'Confirm Cancel order' }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(cancelButton).toHaveFocus());
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('sends the exact PATCH once and renders only the authoritative refetch', async () => {
    const refreshedDetail = detailResponse('preparing');
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailResponse('accepted') },
      { json: statusUpdateResponse('accepted', 'preparing') },
      { json: refreshedDetail },
    );
    const user = userEvent.setup();

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Start preparing' }));
    expect(stub.calls).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Confirm Start preparing' }));

    const successMessage = await screen.findByText('Order status updated.');
    expect(successMessage.closest('[data-variant]')).toHaveAttribute(
      'data-variant',
      'success',
    );
    expect(screen.getByRole('button', { name: 'Mark ready' })).toBeEnabled();
    expect(stub.calls).toHaveLength(4);
    expect(stub.calls[2]?.url).toBe(
      `/api/v1/admin/orders/${PUBLIC_ORDER_NUMBER}/status`,
    );
    expect(stub.calls[2]?.method).toBe('PATCH');
    expect(stub.calls[2]?.body).toBe(JSON.stringify({ status: 'preparing' }));
    expect(stub.calls[2]?.headers.get('Authorization')).toBe(
      `Bearer ${SYNTHETIC_TOKEN}`,
    );
    expect(stub.calls[3]?.method).toBe('GET');
    expect(stub.calls[3]?.url).toBe(`/api/v1/admin/orders/${PUBLIC_ORDER_NUMBER}`);
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);

    const historySection = screen
      .getByRole('heading', { name: 'Status history' })
      .closest('section');
    expect(historySection).not.toBeNull();
    expect(
      within(historySection as HTMLElement).getByText('Preparing'),
    ).toBeInTheDocument();
    expect(
      historySection?.querySelector('time[datetime="2026-08-12T10:02:00+00:00"]'),
    ).not.toBeNull();
    expect(
      historySection?.querySelector('time[datetime="2026-08-12T10:10:00+00:00"]'),
    ).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Order actions' })).toHaveFocus(),
    );
  });

  it('clears a prior mutation success when manual refresh starts and then fails', async () => {
    let resolveRefresh!: (response: Response) => void;
    const pendingRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    installFetchStub(
      { json: ME_RESPONSE },
      { json: detailResponse('accepted') },
      { json: statusUpdateResponse('accepted', 'preparing') },
      { json: detailResponse('preparing') },
      { responsePromise: pendingRefresh },
    );
    const user = userEvent.setup();

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Start preparing' }));
    await user.click(screen.getByRole('button', { name: 'Confirm Start preparing' }));
    expect(await screen.findByText('Order status updated.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.queryByText('Order status updated.')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Existing information remains visible while the same authoritative order is requested.',
      ),
    ).toBeVisible();

    resolveRefresh(new Response(null, { status: 503 }));
    expect(
      await screen.findByRole('heading', { name: 'Unable to refresh order' }),
    ).toBeVisible();
    expect(screen.queryByText('Order status updated.')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh' })).toHaveFocus(),
    );
  });

  it('does not update optimistically and blocks repeated Confirm clicks', async () => {
    let resolvePatch: ((response: Response) => void) | undefined;
    const pendingPatch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailResponse('accepted') },
      { responsePromise: pendingPatch },
      { json: detailResponse('preparing') },
    );
    const user = userEvent.setup();

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Start preparing' }));
    const confirmButton = screen.getByRole('button', {
      name: 'Confirm Start preparing',
    });
    await user.click(confirmButton);

    expect(confirmButton).toBeDisabled();
    expect(confirmButton).toHaveAttribute('aria-busy', 'true');
    expect(confirmButton).toHaveAccessibleName('Updating order to Preparing');
    fireEvent.click(confirmButton);
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(screen.getByRole('article')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Updating order status…')).toBeInTheDocument();
    const summarySection = screen
      .getByRole('heading', { name: 'Order summary' })
      .closest('section');
    expect(summarySection).not.toBeNull();
    expect(
      within(summarySection as HTMLElement).getByText('Accepted'),
    ).toBeInTheDocument();
    expect(
      within(summarySection as HTMLElement).queryByText('Preparing'),
    ).not.toBeInTheDocument();

    resolvePatch?.(
      new Response(JSON.stringify(statusUpdateResponse('accepted', 'preparing')), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(await screen.findByText('Order status updated.')).toBeInTheDocument();
  });

  it.each([
    { ...statusUpdateResponse('accepted', 'preparing'), unexpected: true },
    { ...statusUpdateResponse('accepted', 'preparing'), status: 'ready' },
    {
      ...statusUpdateResponse('accepted', 'preparing'),
      history: {
        ...statusUpdateResponse('accepted', 'preparing').history,
        new_status: 'ready',
      },
    },
  ])('rejects a malformed successful PATCH response', async (response) => {
    installFetchStub({ json: response });

    await expect(
      updateAdminOrderStatus(SYNTHETIC_TOKEN, PUBLIC_ORDER_NUMBER, 'preparing'),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('keeps stale detail gated when PATCH succeeds but refetch fails, then recovers on Refresh', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailResponse('accepted') },
      { json: statusUpdateResponse('accepted', 'preparing') },
      { error: new TypeError('offline after update') },
      { json: detailResponse('preparing') },
    );
    const user = userEvent.setup();

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Start preparing' }));
    await user.click(screen.getByRole('button', { name: 'Confirm Start preparing' }));

    expect(
      await screen.findByText(/status update was accepted by the server/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/status update failed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start preparing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    const summarySection = screen
      .getByRole('heading', { name: 'Order summary' })
      .closest('section');
    expect(
      within(summarySection as HTMLElement).getByText('Accepted'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: 'Mark ready' })).toBeEnabled();
    expect(screen.queryByText(/actions are disabled until/i)).not.toBeInTheDocument();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(stub.calls).toHaveLength(5);
  });

  it.each<[string, FetchStep]>([
    ['network', { error: new TypeError('offline') }],
    ['service unavailable', { status: 503 }],
    ['server failure', { status: 500 }],
    [
      'malformed success',
      {
        json: {
          ...statusUpdateResponse('accepted', 'preparing'),
          unexpected: true,
        },
      },
    ],
  ])(
    'gates an ambiguous %s outcome until a successful Refresh',
    async (_kind, step) => {
      const stub = installFetchStub(
        { json: ME_RESPONSE },
        { json: detailResponse('accepted') },
        step,
        { json: detailResponse('accepted') },
      );
      const user = userEvent.setup();

      renderDetail();
      await user.click(await screen.findByRole('button', { name: 'Start preparing' }));
      await user.click(screen.getByRole('button', { name: 'Confirm Start preparing' }));

      expect(
        await screen.findByText(
          /could not confirm whether the status update was applied/i,
        ),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Order actions' })).toHaveFocus(),
      );
      expect(screen.getByRole('button', { name: 'Start preparing' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Start preparing' })).toHaveAttribute(
        'aria-describedby',
        'status-actions-gate',
      );
      expect(stub.calls).toHaveLength(3);
      expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(
        await screen.findByRole('button', { name: 'Start preparing' }),
      ).toBeEnabled();
      expect(stub.calls).toHaveLength(4);
      expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    },
  );

  it('treats a PATCH timeout as ambiguous without automatic retry', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailResponse('accepted') },
      { waitForAbort: true },
      { json: detailResponse('accepted') },
    );
    renderDetail();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start preparing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Start preparing' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(
      screen.getByText(/could not confirm whether the status update was applied/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start preparing' })).toBeDisabled();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);

    vi.useRealTimers();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByRole('button', { name: 'Start preparing' }),
    ).toBeEnabled();
  });

  it('keeps a raced backend 409 authoritative and derives new actions only after refetch', async () => {
    const rawDetail = 'Order is not paid';
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailWithPayments('created', ['succeeded']) },
      { json: { detail: rawDetail }, status: 409 },
      { json: detailWithPayments('created', []) },
    );
    const user = userEvent.setup();

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Accept order' }));
    await user.click(screen.getByRole('button', { name: 'Confirm Accept order' }));

    expect(
      await screen.findByText(/latest order details have been loaded/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(rawDetail)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Accept order' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeEnabled();
    expect(
      screen.getByText(/acceptance is unavailable because no succeeded payment/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Order actions' })).toHaveFocus(),
    );
    expect(stub.calls).toHaveLength(4);
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('shows the safe not-found state after a mutation 404', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailResponse('accepted') },
      { json: { detail: 'Order not found' }, status: 404 },
    );
    const user = userEvent.setup();

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Start preparing' }));
    await user.click(screen.getByRole('button', { name: 'Confirm Start preparing' }));

    expect(
      await screen.findByRole('heading', { name: 'Order not found' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Order not found' })).toHaveFocus(),
    );
    expect(
      screen.queryByRole('heading', { name: 'Order actions' }),
    ).not.toBeInTheDocument();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('expires the shared session after a mutation 401', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailResponse('accepted') },
      { status: 401 },
    );
    const user = userEvent.setup();
    const router = renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Start preparing' }));
    await user.click(screen.getByRole('button', { name: 'Confirm Start preparing' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      `/admin/orders/${PUBLIC_ORDER_NUMBER}`,
    );
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('expires the shared session when the post-PATCH detail refetch returns 401', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailResponse('accepted') },
      { json: statusUpdateResponse('accepted', 'preparing') },
      { status: 401 },
    );
    const user = userEvent.setup();
    const router = renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Start preparing' }));
    await user.click(screen.getByRole('button', { name: 'Confirm Start preparing' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      `/admin/orders/${PUBLIC_ORDER_NUMBER}`,
    );
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(stub.calls).toHaveLength(4);
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('shows a safe definitive 422 without raw detail or automatic retry', async () => {
    const stub = installFetchStub(
      { json: ME_RESPONSE },
      { json: detailResponse('accepted') },
      { json: { detail: 'raw validation internals' }, status: 422 },
    );
    const user = userEvent.setup();

    renderDetail();
    await user.click(await screen.findByRole('button', { name: 'Start preparing' }));
    await user.click(screen.getByRole('button', { name: 'Confirm Start preparing' }));

    expect(
      await screen.findByText(/status update request was not valid/i),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Order actions' })).toHaveFocus(),
    );
    expect(screen.queryByText('raw validation internals')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start preparing' })).toBeEnabled();
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });
});
