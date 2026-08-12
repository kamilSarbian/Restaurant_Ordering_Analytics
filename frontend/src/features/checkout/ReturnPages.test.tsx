import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import CheckoutCancelledPage from './CheckoutCancelledPage';
import { saveOrderAccess } from './orderAccessStorage';
import PaymentReturnPage from './PaymentReturnPage';

const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';

function renderReturnPage(kind: 'cancelled' | 'return') {
  const path =
    kind === 'return'
      ? `/orders/${PUBLIC_ORDER_NUMBER}/payment-return`
      : `/orders/${PUBLIC_ORDER_NUMBER}/checkout-cancelled`;
  return render(
    <MemoryRouter initialEntries={[path]}>
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
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
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
      '/',
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
    expect(stub.calls).toHaveLength(0);
  });

  it('renders without any guest token in session storage', () => {
    installFetchStub();

    renderReturnPage('cancelled');

    expect(screen.getByText(PUBLIC_ORDER_NUMBER)).toBeVisible();
    expect(screen.queryByText(/access unavailable/i)).not.toBeInTheDocument();
  });
});
