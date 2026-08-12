import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryRouter,
  RouterProvider,
  type InitialEntry,
} from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';

import AsyncNotice from '../components/AsyncNotice';
import { saveOrderAccess } from '../features/checkout/orderAccessStorage';
import { installFetchStub } from '../test/fetchStub';
import { routes } from './router';

const ROUTER_MENU = {
  categories: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Main dishes',
      description: null,
      display_order: 10,
      items: [
        {
          id: '00000000-0000-4000-8000-000000000011',
          name: 'Seasonal bowl',
          description: null,
          image_url: null,
          price_amount: 18900,
          currency: 'NOK',
          allergens: [],
          display_order: 10,
          is_available: true,
        },
      ],
    },
  ],
};

function renderRoute(initialEntry: InitialEntry) {
  const testRouter = createMemoryRouter(routes, {
    initialEntries: [initialEntry],
  });

  return render(<RouterProvider router={testRouter} />);
}

describe('customer frontend routing foundation', () => {
  beforeEach(() => {
    installFetchStub({ json: ROUTER_MENU });
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders the menu root page inside the application shell', async () => {
    renderRoute('/');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Our menu' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main-content',
    );
  });

  it('renders the local not-found page for an unknown path', () => {
    renderRoute('/missing-page');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to ordering' })).toBeInTheDocument();
  });

  it('returns from the not-found page to the menu root route', async () => {
    const user = userEvent.setup();
    renderRoute('/missing-page');

    await user.click(screen.getByRole('link', { name: 'Back to ordering' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Our menu' }),
    ).toBeInTheDocument();
  });

  it('does not expose an administrator interface or route', () => {
    renderRoute('/admin');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/administrator dashboard/i)).not.toBeInTheDocument();
  });

  it('provides appropriate live-region semantics for reusable notices', () => {
    render(
      <>
        <AsyncNotice title="Loading">Please wait.</AsyncNotice>
        <AsyncNotice tone="error" title="Unable to continue">
          Try again.
        </AsyncNotice>
      </>,
    );

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
  });

  it('renders the exact cart route with an empty-cart state', () => {
    renderRoute('/cart');

    expect(
      screen.getByRole('heading', { level: 1, name: 'Your cart' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Your cart is empty.')).toBeInTheDocument();
  });

  it('shares cart state across a menu-to-cart route transition', async () => {
    const user = userEvent.setup();
    installFetchStub({ json: ROUTER_MENU }, { json: ROUTER_MENU });
    renderRoute('/');
    const card = await screen.findByRole('article', { name: 'Seasonal bowl' });

    await user.click(within(card).getByRole('button', { name: 'Add to cart' }));
    await user.click(screen.getByRole('link', { name: 'View cart' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your cart' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Seasonal bowl' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Seasonal bowl quantity')).toHaveTextContent('1');
  });

  it('renders the exact order checkout route without starting a request', () => {
    const publicOrderNumber = 'ROA-23456789ABCD';
    saveOrderAccess(publicOrderNumber, 'private-guest-access-token');

    renderRoute(`/orders/${publicOrderNumber}/checkout`);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order created' }),
    ).toBeInTheDocument();
    expect(screen.getByText(publicOrderNumber)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Continue to secure payment' }),
    ).toBeEnabled();
    expect(screen.queryByText('private-guest-access-token')).not.toBeInTheDocument();
  });

  it('renders the neutral payment-return route without guest access', () => {
    const publicOrderNumber = 'ROA-23456789ABCD';

    renderRoute(`/orders/${publicOrderNumber}/payment-return`);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'You returned from secure checkout',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(publicOrderNumber)).toBeVisible();
  });

  it('renders the neutral checkout-cancelled route without guest access', () => {
    const publicOrderNumber = 'ROA-23456789ABCD';

    renderRoute(`/orders/${publicOrderNumber}/checkout-cancelled`);

    expect(
      screen.getByRole('heading', { level: 1, name: 'You left secure checkout' }),
    ).toBeInTheDocument();
    expect(screen.getByText(publicOrderNumber)).toBeVisible();
  });

  it('renders the protected order-status route with safe missing-token recovery', () => {
    const publicOrderNumber = 'ROA-23456789ABCD';

    renderRoute(`/orders/${publicOrderNumber}/status`);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Order status unavailable' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/private-guest-access-token/i)).not.toBeInTheDocument();
  });

  it.each(['/orders', '/checkout', '/status'])(
    'does not expose the future customer route %s',
    (path) => {
      renderRoute(path);
      expect(
        screen.getByRole('heading', { level: 1, name: 'Page not found' }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    '/orders/ROA-23456789ABCD/cancelled',
    '/orders/ROA-23456789ABCD/payment-return/extra',
    '/orders/ROA-23456789ABCD/status/extra',
  ])('does not expose the future post-order route %s', (path) => {
    renderRoute(path);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument();
  });
});
