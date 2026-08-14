import { render, screen } from '@testing-library/react';
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

function renderReturnPage(kind: 'cancelled' | 'return') {
  const path =
    kind === 'return'
      ? `/orders/${PUBLIC_ORDER_NUMBER}/payment-return`
      : `/orders/${PUBLIC_ORDER_NUMBER}/checkout-cancelled`;
  return render(
    <MemoryRouter initialEntries={[path]}>
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

it('keeps an unavailable saved session retryable instead of treating it as guest access', async () => {
  storeAuthToken();
  saveOrderAccess(PUBLIC_ORDER_NUMBER, 'private-guest-token');
  installFetchStub({ status: 503 });

  renderReturnPage('return');

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'saved session is retained',
  );
  expect(screen.getByRole('button', { name: 'Retry validation' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Log out' })).toBeEnabled();
  expect(
    screen.queryByRole('link', { name: 'View order status' }),
  ).not.toBeInTheDocument();
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
    expect(screen.getByText('Payment confirmation can take a moment.')).toBeVisible();
    expect(document.body).not.toHaveTextContent(/payment (succeeded|confirmed|paid)/i);
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
    expect(document.body).not.toHaveTextContent(/payment (succeeded|confirmed|paid)/i);
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
    expect(document.body).not.toHaveTextContent(/payment failed/i);
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
  });
});
