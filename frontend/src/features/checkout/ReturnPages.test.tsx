import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import CheckoutCancelledPage from './CheckoutCancelledPage';
import { saveOrderAccess } from './orderAccessStorage';
import PaymentReturnPage from './PaymentReturnPage';

const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const AUTH_TOKEN = 'private-auth-token';
const CURRENT_USER = {
  email: 'customer@example.invalid',
  id: '11111111-1111-4111-8111-111111111111',
  is_active: true,
  role: 'customer',
};
const PAYMENT_CLAIM_PATTERN =
  /\b(successful|succeeded|failed|pending|confirmed|paid|charged)\b|\bno charge\b|\bpayment went through\b/i;

function renderReturnPage(kind: 'cancelled' | 'return', search = '') {
  const pathname =
    kind === 'return'
      ? `/orders/${PUBLIC_ORDER_NUMBER}/payment-return`
      : `/orders/${PUBLIC_ORDER_NUMBER}/checkout-cancelled`;
  return render(
    <MemoryRouter initialEntries={[`${pathname}${search}`]}>
      <AuthProvider>
        <Routes>
          <Route
            path="/orders/:publicOrderNumber/payment-return"
            element={<PaymentReturnPage />}
          />
          <Route
            path="/orders/:publicOrderNumber/checkout-cancelled"
            element={<CheckoutCancelledPage />}
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function storeAuthToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: AUTH_TOKEN, version: 1 }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
});

it.each(['return', 'cancelled'] as const)(
  'offers owner-capable links on %s without guest capability',
  async (kind) => {
    storeAuthToken();
    const stub = installFetchStub({ json: CURRENT_USER });

    renderReturnPage(kind);

    expect(
      await screen.findByRole('link', { name: 'View order status' }),
    ).toHaveAttribute('href', `/orders/${PUBLIC_ORDER_NUMBER}/status`);
    expect(screen.getByRole('link', { name: 'Return to payment' })).toHaveAttribute(
      'href',
      `/orders/${PUBLIC_ORDER_NUMBER}/checkout`,
    );
    expect(stub.calls.map((call) => call.url)).toEqual(['/api/v1/auth/me']);
  },
);

it('keeps owner-capable links when authenticated access and guest capability coexist', async () => {
  storeAuthToken();
  saveOrderAccess(PUBLIC_ORDER_NUMBER, 'private-guest-token');
  installFetchStub({ json: CURRENT_USER });

  renderReturnPage('return');

  expect(await screen.findByRole('link', { name: 'View order status' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Return to payment' })).toBeVisible();
});

it.each(['return', 'cancelled'] as const)(
  'does not downgrade %s to guest links while auth is unresolved',
  async (kind) => {
    storeAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, 'private-guest-token');
    const stub = installFetchStub({
      responsePromise: new Promise<Response>(() => undefined),
    });

    renderReturnPage(kind);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Checking your saved session',
    );
    expect(
      screen.queryByRole('link', { name: 'View order status' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Return to payment' }),
    ).not.toBeInTheDocument();
    expect(stub.calls.map((call) => call.url)).toEqual(['/api/v1/auth/me']);
  },
);

it.each(['return', 'cancelled'] as const)(
  'keeps an unavailable saved session retryable on %s instead of treating it as guest access',
  async (kind) => {
    const user = userEvent.setup();
    storeAuthToken();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, 'private-guest-token');
    const stub = installFetchStub({ status: 503 }, { json: CURRENT_USER });

    renderReturnPage(kind);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'saved session is retained',
    );
    expect(screen.getByRole('button', { name: 'Retry validation' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeEnabled();
    expect(
      screen.queryByRole('link', { name: 'View order status' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Return to payment' }),
    ).not.toBeInTheDocument();
    expect(stub.calls).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Retry validation' }));

    expect(
      await screen.findByRole('link', { name: 'View order status' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Return to payment' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(stub.calls).toHaveLength(2));
  },
);

it.each([
  ['return', 'View order status'],
  ['cancelled', 'Return to payment'],
] as const)(
  'uses one compact brand identity and one keyboard-primary action on %s',
  async (kind, primaryActionName) => {
    const user = userEvent.setup();
    const stub = installFetchStub();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, 'private-token');

    const { container } = renderReturnPage(kind);

    expect(screen.getAllByText('Nordic Hearth')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const mark = container.querySelector('svg');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveAttribute('focusable', 'false');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    const primaryActions = container.querySelectorAll(
      '[data-action-priority="primary"]',
    );
    expect(primaryActions).toHaveLength(1);
    expect(primaryActions[0]).toHaveTextContent(primaryActionName);

    await user.tab();
    expect(primaryActions[0]).toHaveFocus();
    expect(stub.calls).toHaveLength(0);
  },
);

it('does not infer a return outcome from misleading URL state', () => {
  const stub = installFetchStub();

  renderReturnPage(
    'return',
    '?payment_status=succeeded&redirect_status=failed&payment=pending',
  );

  expect(
    screen.getByText(
      'This page does not check payment status or make a payment claim.',
    ),
  ).toBeVisible();
  expect(document.body).not.toHaveTextContent(PAYMENT_CLAIM_PATTERN);
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(stub.calls).toHaveLength(0);
});

it('keeps a cancelled redirect neutral even when its query suggests an outcome', () => {
  const stub = installFetchStub();

  renderReturnPage(
    'cancelled',
    '?payment_status=failed&redirect_status=succeeded&charged=true',
  );

  expect(screen.getByText(/restaurant order was not cancelled/i)).toBeVisible();
  expect(document.body).not.toHaveTextContent(PAYMENT_CLAIM_PATTERN);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(stub.calls).toHaveLength(0);
});

describe('PaymentReturnPage', () => {
  it('renders neutral return guidance without token access or API calls', () => {
    const stub = installFetchStub();

    renderReturnPage('return');

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'You returned from secure checkout',
      }),
    ).toBeVisible();
    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeVisible();
    expect(screen.getByText(/does not itself confirm a payment result/i)).toBeVisible();
    expect(document.body).not.toHaveTextContent(PAYMENT_CLAIM_PATTERN);
    expect(
      screen.queryByRole('link', { name: 'View order status' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Return to payment' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse the menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(screen.getByRole('link', { name: 'Browse the menu' })).toHaveAttribute(
      'data-action-priority',
      'primary',
    );
    expect(stub.calls).toHaveLength(0);
  });

  it('offers protected status and payment links only when session access exists', () => {
    const stub = installFetchStub();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, 'private-token');

    renderReturnPage('return');

    expect(screen.getByRole('link', { name: 'View order status' })).toHaveAttribute(
      'href',
      `/orders/${PUBLIC_ORDER_NUMBER}/status`,
    );
    expect(screen.getByRole('link', { name: 'Return to payment' })).toHaveAttribute(
      'href',
      `/orders/${PUBLIC_ORDER_NUMBER}/checkout`,
    );
    expect(document.body).not.toHaveTextContent(PAYMENT_CLAIM_PATTERN);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('CheckoutCancelledPage', () => {
  it('distinguishes leaving hosted checkout from cancelling the order', () => {
    const stub = installFetchStub();
    saveOrderAccess(PUBLIC_ORDER_NUMBER, 'private-token');

    renderReturnPage('cancelled');

    expect(
      screen.getByRole('heading', { level: 1, name: 'You left secure checkout' }),
    ).toBeVisible();
    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeVisible();
    expect(screen.getByText('Hosted checkout was cancelled or closed.')).toBeVisible();
    expect(screen.getByText(/restaurant order was not cancelled/i)).toBeVisible();
    expect(document.body).not.toHaveTextContent(PAYMENT_CLAIM_PATTERN);
    expect(screen.getByRole('link', { name: 'Return to payment' })).toHaveAttribute(
      'href',
      `/orders/${PUBLIC_ORDER_NUMBER}/checkout`,
    );
    expect(screen.getByRole('link', { name: 'View order status' })).toHaveAttribute(
      'href',
      `/orders/${PUBLIC_ORDER_NUMBER}/status`,
    );
    expect(screen.getByRole('link', { name: 'Browse the menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(stub.calls).toHaveLength(0);
  });

  it('renders without any guest token in session storage', () => {
    installFetchStub();

    renderReturnPage('cancelled');

    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeVisible();
    expect(screen.queryByText(/access unavailable/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'View order status' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Return to payment' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse the menu' })).toHaveAttribute(
      'data-action-priority',
      'primary',
    );
  });
});
